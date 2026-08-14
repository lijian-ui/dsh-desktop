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

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import kill from 'tree-kill';
import { createLogger } from './log';
import { DshConfig, buildDshEnv } from './config';

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
      const { command, args } = resolveDshBin(this.config);

      // 组装 dsh web 的完整参数：
      //   dsh web --host 127.0.0.1 --port <desiredPort> [额外参数...]
      const dshArgs = [
        ...args,
        'web',
        '--host', this.config.host,
        '--port', String(desiredPort),
        ...this.config.extraArgs,
      ];

      log.info(`启动命令: ${command} ${dshArgs.join(' ')}`);

      // 使用系统 Node 运行 dsh（满足其 ^22.19 || >=24 的要求）。
      // stdio 设为 pipe 以便读取 stdout / stderr 解析端口与日志。
      const child = spawn(command, dshArgs, {
        env: buildDshEnv(this.config),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows 下调用 .cmd / npx 需要 shell；*nix 下直接执行 bin 即可
        shell: process.platform === 'win32',
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
          // 重启时使用 --port 0 让系统重新分配端口（避免复用可能仍被占用的旧端口）
          await this.spawnOnce(0);
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
      kill(child.pid, 'SIGTERM', (err) => {
        if (err) {
          log.warn(`停止 dsh 进程树失败（pid=${child.pid}）: ${err.message}`);
        } else {
          log.info(`已停止 dsh 进程树（pid=${child.pid}）`);
        }
        resolve();
      });
    });
  }
}

/**
 * 解析 dsh 可执行文件路径。
 *
 * 开发期：优先使用本项目本地安装的 dsh（node_modules/.bin/dsh）。
 *
 * 打包后（app.isPackaged）：
 *   - dsh 及其全部依赖已被 asarUnpack 解包到 app.asar.unpacked/node_modules/，
 *     系统 Node 可直接读取真实文件。
 *   - 命令改为「系统 Node + dsh 的 lib/bin.js」：
 *     * 系统 Node 路径 = config.nodePath（用户显式指定）→ 常见路径探测 → 报错
 *     * macOS GUI 启动的进程 PATH 不完整，绝不能依赖 npx / 相对 node 命令
 *
 * @param config 当前配置（携带 nodePath）
 * @returns 命令与基础参数，例如：
 *   开发期 { command: '/.../node_modules/.bin/dsh', args: [] }
 *   打包后 { command: '/usr/local/bin/node', args: ['/.../app.asar.unpacked/.../dsh/lib/bin.js'] }
 */
function resolveDshBin(config: DshConfig): { command: string; args: string[] } {
  // ── 打包后场景：node_modules 已在 app.asar.unpacked，直接用系统 Node 跑 dsh bin ──
  if (app.isPackaged) {
    // electron-builder 把 asarUnpack 内容放在 resources/app.asar.unpacked/
    const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
    const dshBinJs = path.join(
      unpackedDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js',
    );

    if (fs.existsSync(dshBinJs)) {
      const nodePath = resolveSystemNode(config);
      if (nodePath) {
        log.info(`打包版使用系统 Node 启动 dsh: ${nodePath}`);
        return { command: nodePath, args: [dshBinJs] };
      }
      // Node 路径未解析到：走 npx 兜底（若 PATH 恰好可用），最终由调用方报错
      log.warn('未找到系统 Node 可执行文件，回退到 npx 调用');
      return { command: 'npx', args: ['--no-install', '@deepseek-ai/dsh'] };
    }

    log.warn(`打包后未找到 dsh 可执行文件: ${dshBinJs}，回退到 npx 调用`);
    return { command: 'npx', args: ['--no-install', '@deepseek-ai/dsh'] };
  }

  // ── 开发期：本地 node_modules/.bin/dsh ──
  const binDir = path.join(process.cwd(), 'node_modules', '.bin');
  const localBin = process.platform === 'win32'
    ? path.join(binDir, 'dsh.cmd')
    : path.join(binDir, 'dsh');

  // 本地安装存在时优先使用，路径最确定、启动最快
  if (fs.existsSync(localBin)) {
    return { command: localBin, args: [] };
  }

  // 兜底：依赖 npx 调用本地已安装的包（--no-install 避免联网下载）
  log.warn('未找到本地 dsh 可执行文件，回退到 npx 调用');
  return { command: 'npx', args: ['--no-install', '@deepseek-ai/dsh'] };
}

/**
 * 解析系统 Node.js 可执行文件绝对路径。
 * 优先级：config.nodePath（用户显式指定）→ 常见安装路径 → 返回 null。
 *
 * macOS GUI 启动的 Electron 进程 PATH 不完整（不含用户 shell 的 ~/.zshrc 等），
 * 所以这里不能靠「在 PATH 里找 node」，必须探测绝对路径。
 *
 * 覆盖范围：Homebrew（Apple Silicon / Intel）、官方安装包、nvm（~/.nvm）。
 *
 * @param config 当前配置
 * @returns Node 绝对路径；未找到返回 null
 */
function resolveSystemNode(config: DshConfig): string | null {
  // 1. 用户显式配置（最可靠，README 会引导填写）
  if (config.nodePath && fs.existsSync(config.nodePath)) {
    return config.nodePath;
  }

  // 2. 常见安装路径探测
  const candidates = process.platform === 'win32'
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
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      log.info(`探测到系统 Node: ${p}`);
      return p;
    }
  }

  // 3. macOS/Linux：nvm 路径扫描（~/.nvm/versions/node/vX.Y.Z/bin/node）
  //    nvm 用户（如报告该 bug 的 M4 Mac 用户）最常见。取语义化版本最大的已安装版本。
  if (process.platform !== 'win32') {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (fs.existsSync(nvmDir)) {
      const versions = fs
        .readdirSync(nvmDir)
        .filter((v) => v.startsWith('v'))
        // 按 semver 降序（自然排序对 vX.Y.Z 形式够用）
        .sort()
        .reverse();
      for (const v of versions) {
        const p = path.join(nvmDir, v, 'bin', 'node');
        if (fs.existsSync(p)) {
          log.info(`探测到 nvm Node: ${p}`);
          return p;
        }
      }
    }
  }

  return null;
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
