/**
 * 窗口管理模块
 * ------------------------------------------------------------------
 * 负责创建并配置 Electron 主窗口，将 dsh web 的本地 HTTP 页面加载进来。
 *
 * 设计要点：
 * 1. 方案 A 下，渲染进程内容完全来自官方 dsh 的 localhost 页面，
 *    我们自己的 preload 仅用于提供桌面专属能力（如打开外部链接、重试）。
 * 2. 窗口在 dsh 端口解析完成后再创建（见 index.ts），因此 loadURL 时服务已就绪。
 * 3. 采用 contextIsolation + 关闭 nodeIntegration 的安全默认值。
 * 4. 健壮性：页面加载超时或失败（例如 dsh 子进程崩溃）时，渲染一张中文错误页，
 *    提供「重试」按钮（通过 preload 桥接调用主进程的 dsh:retry），而非白屏。
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './log';

const log = createLogger('window');

/** 主窗口默认尺寸 */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/** 页面加载超时时间（毫秒）：超过仍未 ready-to-show 则判定无响应，展示错误页 */
const LOAD_TIMEOUT_MS = 20_000;

/**
 * 解析桌面端图标路径（开发模式窗口图标）。
 * - 源码路径：electron-app/build/icon.png（由 scripts/generate-icon.cjs 生成）
 * - 打包后 Windows 任务栏图标由 exe 嵌入的 ICO 决定（win.icon），此选项主要用于
 *   开发期 `npm run dev` 启动时窗口/任务栏显示，以及 Linux 下的窗口图标。
 * - 打包后 build/ 目录不会出现在 dist/ 中，因此用 existsSync 兜底，避免运行报错。
 */
function resolveWindowIcon(): string | undefined {
  const iconPath = path.join(__dirname, '../../build/icon.png');
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

/**
 * 构造错误兜底页的 HTML（内联，不依赖外部资源）。
 * 错误页运行在渲染进程，通过 window.dshDesktop.requestRetry() 触发主进程重启 dsh。
 *
 * @param opts.title 错误标题
 * @param opts.detail 错误详情（端口 / 原因等）
 */
function buildErrorHtml(opts: { title: string; detail: string }): string {
  // 注意：此 HTML 通过 data: URL 加载，preload 仍会执行，
  // 因此 window.dshDesktop.requestRetry 一定可用。
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${opts.title}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #0f1115; color: #e6e6e6; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .card {
      max-width: 460px; padding: 32px 36px; border-radius: 14px;
      background: #181b22; border: 1px solid #2a2f3a; box-shadow: 0 8px 30px rgba(0,0,0,.4);
      text-align: center;
    }
    h1 { font-size: 20px; margin: 0 0 12px; color: #ff6b6b; }
    p { font-size: 14px; line-height: 1.7; color: #aab2c0; margin: 0 0 22px; word-break: break-all; }
    button {
      cursor: pointer; border: none; border-radius: 8px; padding: 10px 26px;
      font-size: 14px; color: #fff; background: #4f7cff; transition: background .2s;
    }
    button:hover { background: #3f6af0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${opts.title}</h1>
    <p>${opts.detail}</p>
    <button onclick="window.dshDesktop && window.dshDesktop.requestRetry()">重新连接</button>
  </div>
</body>
</html>`;
}

/**
 * 创建主窗口并加载 dsh web 的本地地址。
 *
 * @param port dsh 实际监听端口（由 dsh-process 解析得到）
 * @param host 监听地址，默认 127.0.0.1
 * @returns 已配置好的 BrowserWindow 实例
 */
export function createMainWindow(port: number, host = '127.0.0.1'): BrowserWindow {
  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    // 先隐藏，待页面就绪后再显示，避免白屏闪烁
    show: false,
    title: 'DeepSeek Harness 桌面端',
    // 开发模式窗口图标（详见 resolveWindowIcon 注释）；打包后 Windows 由 exe 资源图标优先
    icon: resolveWindowIcon(),
    webPreferences: {
      // preload 提供桌面集成能力（打开外部链接、重试等）；渲染进程本身仍是 dsh 的 web 页面
      preload: path.join(__dirname, '../preload/index.js'),
      // 安全默认值：隔离上下文、不向网页暴露 Node API
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loadDsh(win, port, host);

  // 便于开发期调试：F12 打开 DevTools（生产环境可按需移除）
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    // 仅当 dsh 自身地址加载失败时才展示兜底错误页，避免错误页自身加载触发递归
    if (validatedURL.startsWith('http://127.0.0.1')) {
      log.error(`dsh 页面加载失败 (${errorCode}): ${errorDescription} -> ${validatedURL}`);
      showFatalError(win, {
        title: '无法连接 dsh 服务',
        detail: `页面加载失败（${errorDescription}）。可能是 dsh 子进程未启动或已崩溃。点击「重新连接」尝试重启服务。`,
      });
    }
  });

  return win;
}

/**
 * 让窗口加载（或重新加载）指定端口的 dsh 页面。
 * 同时设置加载超时兜底：超时未展示则提示用户。
 *
 * @param win 目标窗口
 * @param port dsh 监听端口
 * @param host 监听地址
 */
export function loadDsh(win: BrowserWindow, port: number, host = '127.0.0.1'): void {
  const url = `http://${host}:${port}`;
  log.info(`主窗口加载: ${url}`);

  // 超时兜底：若超时仍未 ready-to-show（例如服务中途崩溃），展示错误页
  const timer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      showFatalError(win, {
        title: '加载超时',
        detail: `在 ${LOAD_TIMEOUT_MS / 1000} 秒内未能加载 dsh 页面（端口 ${port}）。点击「重新连接」尝试重启服务。`,
      });
    }
  }, LOAD_TIMEOUT_MS);

  // 页面渲染完成后再显示，提升观感；显示即视为加载成功，清除超时计时器
  win.once('ready-to-show', () => {
    clearTimeout(timer);
    win.show();
  });

  void win.loadURL(url);
}

/**
 * 在窗口中渲染中文错误兜底页（含「重新连接」按钮）。
 *
 * @param win 目标窗口
 * @param opts 错误标题与详情
 */
export function showFatalError(win: BrowserWindow, opts: { title: string; detail: string }): void {
  if (win.isDestroyed()) return;
  log.warn(`展示错误兜底页: ${opts.title}`);
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildErrorHtml(opts))}`;
  void win.loadURL(dataUrl);
}
