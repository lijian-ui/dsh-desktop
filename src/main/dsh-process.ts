/**
 * dsh 子进程管理模块
 * ------------------------------------------------------------------
 * 本模块是整个桌面端「方案 A」的核心：通过子进程启动官方 `dsh web`，
 * 并解析其监听端口，供 Electron 窗口加载。
 *
 * 为什么是子进程而非 import：
 * 官方主包 @deepseek-ai/dsh 只暴露 CLI（bin: dsh），没有可 import 的运行时 API。
 * 因此我们用 spawn 启动 `dsh web`，由官方子进程自己承担：
 *   - 原生模块（node-pty / koffi）的加载与 ABI 兼容
 *   - Node 版本要求（^22.19 || >=24，使用系统 Node 而非 Electron 内置 Node）
 *   - 内部 API 的破坏性变更（dev-preview 阶段随 `npm update` 跟随）
 * 桌面端主进程因此零原生模块负担。
 *
 * 本模块在「启动」与「存活」两个维度做了健壮性增强：
 *   1. 端口冲突重试：当配置了固定端口且该端口被占用时，自动顺延端口重试，避免启动即失败。
 *   2. 崩溃自动重启：dsh 子进程在运行期间异常退出时，按指数退避自动重启（上限次数），
 *      并回调主进程刷新窗口，用户无感知或仅看到短暂错误页。
 *
 * 生命周期回调（DshCallbacks）由主进程注入，用于驱动窗口状态。
 */

import { ChildProcess, spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import kill from 'tree-kill';
import { createLogger } from './log';
import { DshConfig, buildDshEnv } from './config';
import { ensureImGatewayProfile, resolveBundledNodeModules } from './profile-init';

const log = createLogger('dsh');

/** 单次启动的超时时间（毫秒）：超过则判定 dsh 启动失败 */
const START_TIMEOUT_MS = 30_000;
/** 启动阶段端口冲突的最大重试次数（仅对固定端口生效；--port 0 由系统分配不会冲突） */
const MAX_START_RETRIES = 10;
/** 崩溃后自动重启的最大次数（超过则停止重启并报告错误） */
const MAX_RESTARTS = 5;
/** 自动重启的退避基数（毫秒），实际等待 = BASE * 2^(尝试次数-1) */
const RESTART_BACKOFF_BASE_MS = 1_000;

/**
 * dsh 运行状态回调。主进程通过这些回调同步窗口展示。
 */
export interface DshCallbacks {
  /** dsh 就绪（首次启动或崩溃后重启成功），携带新端口 */
  onReady(port: number): void;
  /** dsh 在运行期间异常退出（即将尝试自动重启） */
  onCrashed(code: number | null, signal: string | null): void;
  /** 正在进行第 attempt 次自动重启 */
  onRestarting(attempt: number): void;
  /** 启动彻底失败或达到重启上限，无法继续 */
  onError(message: string): void;
}

/**
 * dsh 子进程管理器。
 * 封装 spawn / 端口解析 / 端口冲突重试 / 崩溃自动重启 / 进程树清理。
 */
export class DshManager {
  private child: ChildProcess | null = null;
  private port = 0;
  /** 是否已成功启动并在运行中（用于区分「启动中失败」与「运行中崩溃」 */
  private running = false;
  /** 是否为主动停止（主动停止时不触发自动重启） */
  private stopping = false;
  /** 崩溃自动重启计数 */
  private restartCount = 0;
  /**
   * 生命周期纪元令牌。每次 start / stop 都自增，
   * 用于作废上一轮残留的「自动重启退避定时器」，避免重复 spawn。
   */
  private epoch = 0;
  /** 当前已累积的 dsh stdout（用于端口解析与错误诊断） */
  private stdoutBuffer = '';

  constructor(
    private readonly config: DshConfig,
    private readonly callbacks: DshCallbacks,
  ) {}

  /** 获取当前 dsh 监听端口（未就绪时为 0） */
  get currentPort(): number {
    return this.port;
  }

  /** 是否已就绪并运行中 */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 启动 dsh 子进程。
   * 若配置了固定端口且绑定失败，自动顺延端口重试（最多 MAX_START_RETRIES 次）。
   */
  async start(): Promise<void> {
    this.stopping = false;
    this.restartCount = 0;
    this.epoch += 1; // 作废上一轮可能残留的自动重启定时器

    // 首次启动离线部署自研插件（im-gateway / session-cleaner）：
    // 把插件固化进 `~/.dsh/profiles/<name>`（junction 到桌面壳 node_modules，
    // 依赖离线解析）。失败仅告警，不阻断 dsh 本体。
    try {
      const r = ensureImGatewayProfile(this.config);
      log.info(`插件 profile 就绪: ${r.profileDir}（${r.pluginSources.length} 个 bundle）`);
    } catch (err) {
      log.warn(`插件 profile 部署失败（不影响 dsh 启动）: ${err instanceof Error ? err.message : String(err)}`);
    }

    let tryPort = this.config.port; // 0 表示由系统分配空闲端口

    for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt++) {
      try {
        await this.spawnOnce(tryPort);
        this.running = true;
        this.callbacks.onReady(this.port);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 固定端口被占用时顺延端口重试；系统分配端口（0）或无法重试时直接失败
        const conflict = /EADDRINUSE|address already in use|端口|port/i.test(msg);
        if (conflict && tryPort > 0 && attempt < MAX_START_RETRIES) {
          log.warn(`端口 ${tryPort} 冲突，尝试下一个端口: ${tryPort + 1}`);
          tryPort += 1;
          continue;
        }
        this.callbacks.onError(`dsh 启动失败：${msg}`);
        return;
      }
    }

    this.callbacks.onError(`dsh 启动失败：在 ${MAX_START_RETRIES} 次端口重试后仍无法启动`);
  }

  /**
   * 主动停止 dsh 及其整个进程树。
   * 主动停止不会触发崩溃自动重启。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.epoch += 1; // 作废上一轮可能残留的自动重启定时器
    if (this.child) {
      const child = this.child;
      this.child = null;
      await this.killTree(child);
    }
  }

  /**
   * 手动重启（菜单「重启 dsh 服务」或错误页「重新连接」触发）。
   * 先停止再启动，并重置自动重启计数。
   */
  async restart(): Promise<void> {
    log.info('收到手动重启请求，重启 dsh 子进程');
    await this.stop();
    await this.start();
  }

  /**
   * 启动一次 dsh 子进程并等待其监听端口就绪。
   *
   * @param desiredPort 期望端口；传 0 让系统分配
   * @returns 解析出实际端口后 resolve；启动超时或进程提前退出则 reject
   */
  private spawnOnce(desiredPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const { command, args, shell } = resolveDshBin(this.config);

      // 组装 dsh 的完整参数。
      // 默认：dsh web --host ... --port ... [额外参数]
      //   开发期 profile：dsh --profile <name> --host ... --port ... [额外参数]
      // 注意 `--profile` 是 launcher 级全局参数，必须位于子命令/应用参数之前；
      // `web` 本身是 `--profile web` 的别名，自定义 profile 无需再带 `web` 令牌
      // （自定义 profile 已在其 bundles 中纳入 dsh-web-app，启动即拉起 web 服务）。
      const profilePrefix = this.config.profile
        ? ['--profile', this.config.profile]
        : ['web'];
      const dshArgs = [
        ...args,
        ...profilePrefix,
        '--host', this.config.host,
        '--port', String(desiredPort),
        // 桌面端有自己的窗口，无需 dsh-web-app 再打开系统浏览器。
        // 放在 extraArgs 之前，用户仍可通过 extraArgs 覆盖。
        '--no-open',
        ...this.config.extraArgs,
      ];

      log.info(`启动命令: ${command} ${dshArgs.join(' ')}`);

      // 使用系统 Node 运行 dsh（满足其 ^22.19 || >=24 的要求）。
      // stdio 设为 pipe 以便读取 stdout / stderr 解析端口与日志。
      // shell 仅在回退到 npx（.cmd shim）时为 true；正常路径直接 spawn 系统
      // Node + bin.js，child.pid 即真正的 node 进程，退出时 tree-kill 才能精准命中，
      // 不会因中间套一层 cmd.exe 而留下孤儿进程。
      const child = spawn(command, dshArgs, {
        // NODE_PATH 兜底：插件 junction 的物理目标在桌面壳 node_modules，依赖解析
        // 已能自动向上命中；再加 NODE_PATH 覆盖 dsh 可能改变解析环境的场景（保险）。
        env: prepareDshEnv(this.config),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell,
      });

      this.child = child;
      this.stdoutBuffer = '';
      let settled = false; // 端口是否已解析（防止超时与退出重复处理）

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stdout.write(`[dsh] ${text}`);
        this.stdoutBuffer += text;

        if (!settled) {
          const port = extractPort(this.stdoutBuffer);
          if (port !== null) {
            settled = true;
            clearTimeout(timer);
            this.port = port;
            // 端口就绪后挂接「崩溃自动重启」监听，并开始监控异常退出
            this.watchCrash(child);
            resolve();
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        process.stderr.write(`[dsh] ${text}`);
        this.stdoutBuffer += text; // 一并保留用于错误诊断

        // 启动阶段若 stderr 报端口冲突，立即以失败拒绝，交给定时重试逻辑顺延端口
        if (!settled && /EADDRINUSE|address already in use/i.test(text)) {
          settled = true;
          clearTimeout(timer);
          void this.killTree(child);
          reject(new Error(`端口 ${desiredPort} 已被占用（EADDRINUSE）`));
        }
      });

      // 子进程在端口解析前就退出：通常是 Node 版本不满足或依赖缺失。
      // 把 stdoutBuffer（含 stderr 输出）末尾几行附到错误信息里，
      // 让错误对话框直接展示 dsh 的真实报错，方便用户排查。
      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const tail = this.stdoutBuffer
            .trim()
            .split(/\r?\n/)
            .filter((l) => l.trim())
            .slice(-10)
            .join('\n');
          reject(new Error(
            `dsh 子进程在就绪前退出（code=${code}, signal=${signal}）。\n` +
            `请确认系统 Node 版本满足 ^22.19 || >=24，且已安装 @deepseek-ai/dsh。\n` +
            `如需指定系统 Node 路径，请在 config.json 设置 nodePath。` +
            (tail ? `\n\ndsh 输出（最近 10 行）：\n${tail}` : ''),
          ));
        }
        // 已就绪情况下的退出由 watchCrash 处理
      });

      // 启动超时保护
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          log.error(`dsh 启动超时（>${START_TIMEOUT_MS}ms），终止子进程`);
          void this.killTree(child);
          reject(new Error('dsh 启动超时，未能解析到监听端口'));
        }
      }, START_TIMEOUT_MS);
    });
  }

  /**
   * 监控一次已就绪的 dsh 子进程。若其异常退出且非主动停止，则按退避自动重启。
   *
   * @param child 已就绪的 dsh 子进程
   */
  private watchCrash(child: ChildProcess): void {
    child.on('exit', (code, signal) => {
      // 主动停止或已销毁：不重启
      if (this.stopping || this.child !== child) return;

      this.running = false;
      this.callbacks.onCrashed(code, signal);

      if (this.restartCount >= MAX_RESTARTS) {
        this.callbacks.onError(
          `dsh 子进程已连续崩溃 ${MAX_RESTARTS} 次，停止自动重启。请检查日志或手动重启。`,
        );
        return;
      }

      this.restartCount += 1;
      const backoff = RESTART_BACKOFF_BASE_MS * 2 ** (this.restartCount - 1);
      // 捕获当前纪元，若期间发生 start/stop（如手动重启），定时器作废，避免重复 spawn
      const myEpoch = this.epoch;
      this.callbacks.onRestarting(this.restartCount);
      log.warn(`dsh 崩溃（code=${code}, signal=${signal}），${backoff}ms 后进行第 ${this.restartCount} 次重启`);

      setTimeout(async () => {
        if (this.stopping || this.epoch !== myEpoch) return; // 已主动停止或纪元过期，放弃本次重启
        try {
          // 崩溃后复用固定端口重启（保持 origin 稳定，localStorage 才能持久化）；
          // 若端口此刻仍被占用，会被 spawnOnce 的启动失败路径捕获并按 start() 重试。
          await this.spawnOnce(this.config.port);
          if (this.epoch !== myEpoch) return; // 重启期间又发生了 start/stop，放弃
          this.running = true;
          this.callbacks.onReady(this.port);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`第 ${this.restartCount} 次重启失败: ${msg}`);
          // 重启失败也计入次数，最终达到上限后由 watchCrash 下一次 exit 触发 onError
        }
      }, backoff);
    });
  }

  /**
   * 停止 dsh 子进程及其整个进程树。
   * 使用 tree-kill 而非 child.kill，确保 dsh 内部拉起的孙进程一并清理，
   * 不会在桌面端退出后残留后台进程。
   *
   * @param child dsh 子进程
   */
  private killTree(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (child.pid === undefined) {
        resolve();
        return;
      }
      const pid = child.pid;
      let settled = false;
      const finish = (reason?: string) => {
        if (settled) return;
        settled = true;
        if (reason) {
          log.warn(`dsh 进程树清理兜底（pid=${pid}）: ${reason}`);
        } else {
          log.info(`已停止 dsh 进程树（pid=${pid}）`);
        }
        resolve();
      };

      // 主清理：tree-kill 强制杀整棵进程树（含 dsh 内部 vite / node-pty 开的 shell）。
      // 注意：绝不依赖其回调 resolve——Windows 上 `taskkill /T` 在杀 conhost / csrss
      // 这类内核态孙进程时偶发挂起，回调永不触发会导致 stop() 永远 pending，进而
      // before-quit 的 await 永不返回、app.exit() 永不调用，Electron 主进程卡死、
      // npm 的 shell 无法返回（即用户遇到的「结束 run dev 卡主」）。
      // 因此这里 fire-and-forget，统一交给下方 exit / 超时兜底收口。
      kill(pid, 'SIGTERM', (err) => {
        if (err) {
          log.warn(`停止 dsh 进程树失败（pid=${pid}）: ${err.message}`);
        }
      });

      // dsh web 主进程真正退出即视为清理完成（其孙进程随之被 OS 回收）
      child.on('exit', () => finish());

      // 兜底：最多等 2.5s，超时则强制放行退出，杜绝卡死 npm。
      // 超时后再补一刀强制信号，尽量清掉残留孙进程（fire-and-forget，不阻塞）。
      setTimeout(() => {
        finish('清理超时（疑似 taskkill 挂起），强制继续退出');
        try {
          kill(pid, 'SIGKILL', () => {});
        } catch {
          /* 进程可能已不存在，忽略 */
        }
      }, 2500);
    });
  }
}

/**
 * 在环境变量里追加桌面壳 node_modules 到 NODE_PATH（模块解析兜底）。
 * 插件通过 junction 链接进 profile，其物理目标在桌面壳 node_modules 内，
 * node 从物理路径向上查找依赖已能命中；NODE_PATH 额外覆盖 dsh 内部
 * 可能改变模块解析的场景。
 */
function addNodePath(env: NodeJS.ProcessEnv, config: DshConfig): NodeJS.ProcessEnv {
  const base = (env.NODE_PATH ?? '').split(path.delimiter).filter(Boolean);
  const bundled = resolveBundledNodeModules(config);
  if (!base.includes(bundled)) base.push(bundled);
  env.NODE_PATH = base.join(path.delimiter);
  return env;
}

/**
 * 把桌面壳 node_modules/.bin 前缀进 PATH，让 dsh 子进程（及插件市场 spawn 的
 * `dsh plugin` → pnpm）能解析到桌面壳自带的 pnpm；无需用户机器预装 pnpm。
 *
 * 跨平台策略：
 *   - 开发期：项目根 node_modules/.bin 已含 pnpm 入口（npm/pnpm install 生成），直接加进 PATH
 *   - 打包期：electron-builder 过滤了 .bin 目录，入口文件缺失 → 在临时目录创建 pnpm shim
 *     - Windows：pnpm.cmd（批处理），用绝对路径 node.exe 调用 pnpm.cjs
 *     - macOS/Linux：pnpm（shell 脚本，shebang 指向内置 node），chmod 0o755
 *   - 内置 node.exe 路径：Windows = resources/node-runtime/node.exe，其他平台 = resources/node-runtime/node
 */
function addBinPath(env: NodeJS.ProcessEnv, config: DshConfig): NodeJS.ProcessEnv {
  const nm = resolveBundledNodeModules(config)
  const paths = new Set((env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
  const binDir = path.join(nm, '.bin')

  if (fs.existsSync(binDir)) {
    if (!paths.has(binDir)) paths.add(binDir)
  } else {
    const pnpmBin = path.join(nm, 'pnpm', 'bin')
    const isWin = process.platform === 'win32'
    const pnpmEntry = path.join(pnpmBin, isWin ? 'pnpm.cmd' : 'pnpm')
    if (fs.existsSync(pnpmEntry)) {
      // 内置 node 路径：Windows = node-runtime/node.exe，其他平台 = node-runtime/bin/node
      // （fetch-node.cjs 精简时保留 bin/ 目录结构，注意不能漏 bin/）
      const nodePath = app.isPackaged
        ? path.join(process.resourcesPath, 'node-runtime', ...(isWin ? ['node.exe'] : ['bin', 'node']))
        : resolveSystemNode(config)
      // 临时目录 %TEMP%/dsh-bin/（跨平台可写）
      const shimDir = path.join(os.tmpdir(), 'dsh-bin')
      try {
        fs.mkdirSync(shimDir, { recursive: true })
        const shimName = isWin ? 'pnpm.cmd' : 'pnpm'
        const shimPath = path.join(shimDir, shimName)
        if (!fs.existsSync(shimPath)) {
          // 用绝对路径：shim 经 PATH 调用时 cwd 是用户当前目录，相对路径会失效
          const script = pnpmEntry
          if (isWin) {
            const nodeArg = nodePath ? `"${nodePath}"` : 'node'
            fs.writeFileSync(shimPath, `@${nodeArg} "${script}" %*\r\n`, 'utf8')
          } else {
            // macOS/Linux：避免 shebang 空格问题（内核按空白切分、引号不可靠），
            // 用 /bin/sh 读取脚本后 exec 真实 node，既保住空格路径又保留 pid 直指 node。
            const scriptBody = nodePath
              ? `#!/bin/sh\nexec "${nodePath}" "${script}" "$@"\n`
              : '#!/usr/bin/env node\n'  // 开发期无内置 node 时的兜底
            fs.writeFileSync(shimPath, scriptBody, 'utf8')
            fs.chmodSync(shimPath, 0o755)
          }
        }
        if (!paths.has(shimDir)) paths.add(shimDir)
      } catch { /* 忽略 */ }
    }
    if (fs.existsSync(pnpmBin) && !paths.has(pnpmBin)) paths.add(pnpmBin)
  }
  env.PATH = Array.from(paths).join(path.delimiter)
  return env
}

/**
 * 把内置 node-runtime 的 bin 目录前缀进 PATH。node.exe 所在目录与
 * node_modules/.bin 同级调用链的关键：pnpm 的 .cmd shim 内嵌 `node` 命令，
 * 靠 PATH 解析——不注入则打包后的用户机器（可能没装系统 node）在
 * `dsh plugin` → pnpm 一步就失败。前缀内置 node 保证全链路不依赖外部。
 */
function addNodeRuntimePath(env: NodeJS.ProcessEnv, config: DshConfig): NodeJS.ProcessEnv {
  const nodePath = resolveSystemNode(config);
  if (!nodePath) return env;
  const nodeDir = path.dirname(nodePath);
  const base = (env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!base.includes(nodeDir)) base.unshift(nodeDir);
  env.PATH = base.join(path.delimiter);
  return env;
}

/**
 * ⚠️ 若环境变量存在，跳过的浏览器探测：保留用户/系统已设置的显式值。
 */
const UNIVER_RENDER_BROWSER_ENV = 'UNIVER_RENDER_BROWSER';

/**
 * 探测本机 Chrome/Chromium 可执行文件绝对路径。
 *
 * 背景：第三方插件（如 dsh-univer-office）用 `puppeteer-core`，它**不**内置/下载
 * 浏览器，只探测固定标准路径 + `UNIVER_RENDER_BROWSER` 环境变量兜底。很多用户
 * 的 Chrome 装在非标准位置（如 per-user `AppData\Local\Google\Chrome\Bin\`，
 * 或 Edge 的 `EdgeCore\`），会被漏掉。这里在 spawn dsh 前主动探测并注入，
 * 让这类渲染类插件开箱即用——不只对 univer，对所有按 `UNIVER_RENDER_BROWSER`
 * 约定找浏览器的插件都生效。
 *
 * @returns 浏览器可执行文件路径；未找到返回 null
 */
function resolveBundledBrowser(): string | null {
  const candidates: string[] = [];
  const isWin = process.platform === 'win32';
  const local = process.env.LOCALAPPDATA;

  if (isWin) {
    // 标准 per-user + Program Files（含非标准 `Bin\` 变体，因 2024 年后 Chrome
    // 更新可能落到 `AppData\Local\Google\Chrome\Bin\`）
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    );
    if (local) {
      candidates.push(
        path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(local, 'Google\\Chrome\\Bin\\chrome.exe'),
        path.join(local, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(local, 'Microsoft\\Edge\\EdgeCore\\msedge.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
    candidates.push(
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略单个候选的异常，继续探测 */
    }
  }
  return null;
}

/**
 * 把内置 officecli 二进制目录前缀进 PATH，让 dsh 子进程（及其拉起 LLM 的
 * shell）可直接 `officecli view <file> html` 命令，无需用户预装。
 *
 * 二进制所在目录按运行形态区分，保证 dev 与打包后行为一致：
 *   - 打包版：resources/officecli/（仅 app.isPackaged 为真时存在）
 *   - 开发版：项目根 vendor/officecli/<os>-<arch>/（fetch-officecli.cjs 产物，
 *             与打包 extraResources 同源）
 *
 * 权限兜底：macOS/Linux 上 electron-builder 的 extraResources 拷贝不可靠保留
 * 0o755 执行位，此处运行时检出缺失执行位即补足，避免「PATH 已在但 spawn
 * 拿到 permission denied」——那是安装后 LLM 调不到 officecli 的典型场景。
 */
function addOfficecliPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // 平台目标目录映射（与 electron-builder ${os}-${arch} / fetch-officecli TARGETS 对齐）
  const isWin = process.platform === 'win32';
  let officecliDir: string;

  if (app.isPackaged) {
    officecliDir = path.join(process.resourcesPath, 'officecli');
  } else {
    const target = isWin
      ? process.arch === 'x64'
        ? 'win-x64'
        : null
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'mac-arm64'
          : process.arch === 'x64'
            ? 'mac-x64'
            : null
        : null;
    if (target === null) {
      log.warn(`当前平台无内置 OfficeCLI 产物，跳过 PATH 注入: ${process.platform}/${process.arch}`);
      return env;
    }
    officecliDir = path.join(process.cwd(), 'vendor', 'officecli', target);
  }

  const officecliFile = path.join(officecliDir, isWin ? 'officecli.exe' : 'officecli');

  if (!fs.existsSync(officecliFile)) {
    log.warn(`未找到内置 OfficeCLI 二进制，跳过 PATH 注入: ${officecliFile}`);
    return env;
  }

  // 运行时权限兜底：非 Windows 平台若缺执行位，立即补足 0o755。
  try {
    if (!isWin) {
      const mode = fs.statSync(officecliFile).mode;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(officecliFile, 0o755);
        log.info(`修复内置 OfficeCLI 执行权限: ${officecliFile}`);
      }
    }
  } catch (err) {
    log.warn(`设置内置 OfficeCLI 执行权限失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const base = (env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (!base.includes(officecliDir)) base.unshift(officecliDir);
  env.PATH = base.join(path.delimiter);
  log.info(`已注入内置 OfficeCLI 到 PATH: ${officecliDir}`);

  // 常驻进程落盘策略：officecli 用命名管道维持文件常驻（create 自动启动），
  // 修改在内存 DOM。默认 auto 是空闲去抖 flush（2-10s），LLM 每步独立
  // `set` 退出后常驻可能未到 flush 时机，改动会在内存中丢失（"修改不落盘"）。
  // 强制 each：每次 mutation 命令返回前写盘，保证模型单步修改立即可见。
  if (env.OFFICECLI_RESIDENT_FLUSH === undefined) {
    env.OFFICECLI_RESIDENT_FLUSH = 'each';
    log.info(`设定 OfficeCLI 常驻落盘策略 OFFICECLI_RESIDENT_FLUSH=${env.OFFICECLI_RESIDENT_FLUSH}`);
  }
  return env;
}

/** dsh 子进程启动环境：基础 env + NODE_PATH 兜底 + node-runtime、内置 bin/pnpm、officecli 前缀进 PATH。 */
function prepareDshEnv(config: DshConfig): NodeJS.ProcessEnv {
  const env = buildDshEnv(config);
  addNodePath(env, config);
  addNodeRuntimePath(env, config);
  addBinPath(env, config);
  injectBundledBrowser(env);
  addOfficecliPath(env);
  return env;
}

/**
 * 探测到本机浏览器且 `UNIVER_RENDER_BROWSER` 未显式设置时，注入子进程环境变量。
 * 用户/系统已显式设置的值优先，不覆盖。
 */
function injectBundledBrowser(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[UNIVER_RENDER_BROWSER_ENV] || process.env[UNIVER_RENDER_BROWSER_ENV]) {
    return env;
  }
  const browser = resolveBundledBrowser();
  if (browser) {
    log.info(`探测到本机浏览器，注入 UNIVER_RENDER_BROWSER: ${browser}`);
    env[UNIVER_RENDER_BROWSER_ENV] = browser;
  } else {
    log.warn('未探测到 Chrome/Chromium，渲染类插件（如幻灯片/表格）的浏览器能力将不可用');
  }
  return env;
}

/**
 * 解析 dsh 可执行文件路径。
 *
 * 开发期与打包后统一：都用「系统 Node + dsh 的 lib/bin.js」启动。
 * 这样绕开 npm 生成的 `.cmd` shim（shim 内部也是调 node 跑 bin.js，但会额外
 * 套一层 cmd.exe），让 `child.pid` 直接指向真正的 node 进程 —— 退出时 tree-kill
 * 才能精准命中，不会因中间隔着 cmd.exe 而留下孤儿进程。
 *
 * 打包后（app.isPackaged）dsh 及依赖被 asarUnpack 到 app.asar.unpacked/node_modules/，
 * 开发期则直接用项目根 node_modules 里的 bin.js。
 *
 * @param config 当前配置（携带 nodePath）
 * @returns 命令、基础参数、以及是否需要 shell（仅 npx 兜底需要，正常路径为 false）
 */
function resolveDshBin(config: DshConfig): { command: string; args: string[]; shell: boolean } {
  const dshBinJs = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

  if (fs.existsSync(dshBinJs)) {
    const nodePath = resolveSystemNode(config);
    if (nodePath) {
      log.info(`${app.isPackaged ? '打包版' : '开发期'}使用系统 Node 启动 dsh: ${nodePath}`);
      return { command: nodePath, args: [dshBinJs], shell: false };
    }
    // Node 路径未解析到：走 npx 兜底（npx 是 .cmd shim，需要 shell）
    log.warn('未找到满足 dsh 要求的系统 Node，回退到 npx 调用');
    return { command: 'npx', args: ['--no-install', '@deepseek-ai/dsh'], shell: true };
  }

  log.warn(`未找到 dsh 可执行文件: ${dshBinJs}，回退到 npx 调用`);
  return { command: 'npx', args: ['--no-install', '@deepseek-ai/dsh'], shell: true };
}

/**
 * 解析系统 Node.js 可执行文件绝对路径。
 * 优先级：内置 Node（打包版）→ config.nodePath → nvm → 常见安装路径 → null。
 *
 * macOS GUI 启动的 Electron 进程 PATH 不完整（不含用户 shell 的 ~/.zshrc 等），
 * 所以这里不能靠「在 PATH 里找 node」，必须探测绝对路径。
 *
 * 覆盖范围：内置运行时（resources/node-runtime）、nvm（~/.nvm）、
 * Homebrew（Apple Silicon / Intel）、官方安装包。
 * 关键：每个候选都执行版本校验（dsh 要求 ^22.19 || >=24），不满足的旧版
 * （如系统自带 v18）会被跳过，避免命中了但 dsh 启动即崩（实测踩坑：系统
 * v18 命中导致 ERR_MODULE_NOT_FOUND）。
 *
 * @param config 当前配置
 * @returns Node 绝对路径；未找到返回 null
 */
function resolveSystemNode(config: DshConfig): string | null {
  // 0. ★ 内置 Node 运行时（v0.2.0，最优先）：
  //    打包版把精简 Node 放在 resources/node-runtime/（见 electron-builder.yml
  //    extraResources + scripts/fetch-node.cjs），开箱即用，不依赖用户环境。
  //    开发模式（app.isPackaged === false）没有此目录，自然跳过。
  const bundledRoot = path.join(process.resourcesPath, 'node-runtime');
  const bundledNode = process.platform === 'win32'
    ? path.join(bundledRoot, 'node.exe')
    : path.join(bundledRoot, 'bin', 'node');
  if (fs.existsSync(bundledNode)) {
    log.info(`使用内置 Node 运行时: ${bundledNode}`);
    return bundledNode;
  }

  // 1. 用户显式配置（最可靠，README 会引导填写）
  if (config.nodePath && fs.existsSync(config.nodePath)) {
    log.info(`使用用户配置的 Node: ${config.nodePath}`);
    return config.nodePath;
  }

  // 候选收集：nvm 版本（优先，用户主动安装管理的通常更新）→ 常见安装路径
  const candidates: string[] = [];

  // 1.5 macOS/Linux：nvm 路径（~/.nvm/versions/node/vX.Y.Z/bin/node）
  //    注意必须先于常见路径探测——很多 nvm 用户系统里也有旧版 node（如 v18），
  //    若先命中常见路径会拿到旧版，dsh 启动即崩。nvm 是用户显式管理的版本，优先。
  if (process.platform !== 'win32') {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs
        .readdirSync(nvmDir)
        .filter((v) => v.startsWith('v'))
        .sort() // 字符串排序对 vX.Y.Z 足够：v24 > v18 > v16
        .reverse();
      for (const v of versions) {
        const p = path.join(nvmDir, v, 'bin', 'node');
        if (fs.existsSync(p)) candidates.push(p);
      }
    }
  }

  // 2. 常见安装路径（作为 nvm 之后的回退）
  candidates.push(
    ...(process.platform === 'win32'
      ? [
          'C:\\Program Files\\nodejs\\node.exe',
          'C:\\Program Files (x86)\\nodejs\\node.exe',
          path.join(process.env.APPDATA ?? '', 'nvm', 'current', 'node.exe'),
        ]
      : [
          // macOS：Homebrew（Apple Silicon / Intel 两种前缀）与官方安装包
          '/opt/homebrew/bin/node',
          '/usr/local/bin/node',
          '/usr/bin/node',
        ]),
  );

  // 3. 逐个校验：存在 + 版本满足 dsh 要求
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    if (!satisfiesDshNodeVersion(p)) {
      log.warn(`探测到 Node 但版本不满足 dsh 要求，跳过: ${p}`);
      continue;
    }
    log.info(`探测到系统 Node: ${p}`);
    return p;
  }

  return null;
}

/**
 * 校验 Node 版本是否满足 dsh 的 `^22.19.0 || >=24.0.0` 要求。
 * 通过执行 `<node> --version` 解析主/次版本号判断。
 *
 * @param nodePath Node 可执行文件绝对路径
 * @returns 满足要求返回 true；执行失败或版本不符返回 false
 */
function satisfiesDshNodeVersion(nodePath: string): boolean {
  try {
    const out = execFileSync(nodePath, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.trim().match(/^v(\d+)\.(\d+)/);
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    // ^22.19.0：22.x 且 minor>=19；>=24.0.0：24 及以上（23 不在要求内）
    return (major === 22 && minor >= 19) || major >= 24;
  } catch {
    // 执行失败（无权限 / 非可执行文件等）视为不满足
    return false;
  }
}

/**
 * 从一段文本中提取 dsh 监听的端口号。
 * dsh web 启动后会在 stdout 打印监听地址（形如 http://127.0.0.1:port），
 * 我们用宽松正则抓取第一个 http(s)://host:port 中的端口。
 *
 * 注意：此解析依赖 dsh 的 stdout 输出格式，若官方改版需同步调整。
 *
 * @param text 累积的 stdout 文本
 * @returns 端口号；未找到返回 null
 */
function extractPort(text: string): number | null {
  const match = text.match(/https?:\/\/[0-9a-zA-Z.\-]+:(\d{2,5})/);
  if (match) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) {
      return port;
    }
  }
  return null;
}
