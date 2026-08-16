/**
 * 主进程入口（应用程序生命周期）
 * ------------------------------------------------------------------
 * Electron 启动后从这里开始执行，负责串联各模块：
 *
 *   应用就绪 → 构建中文菜单 → 启动 dsh 管理器（拿到端口）→ 创建/刷新主窗口
 *   应用退出 → 按进程树清理 dsh 子进程
 *
 * 关键约束（来自项目方案 A）：
 *   - 不引用、不改动官方 dsh 任何源码，仅通过子进程消费 `@deepseek-ai/dsh` 的 CLI。
 *   - 原生模块与 Node 版本问题全部由官方子进程承担。
 *
 * 健壮性：
 *   - dsh 子进程崩溃时由 DshManager 自动重启，窗口无缝刷新；
 *   - 启动/连接彻底失败时，向用户展示中文错误页或弹窗，而非白屏或静默退出。
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { createLogger } from './log';
import { loadConfig } from './config';
import { DshManager } from './dsh-process';
import { createMainWindow, loadDsh, showFatalError, showMainWindow } from './window';
import { createAppMenu } from './menu';
import { createTray, destroyTray } from './tray';
import { initAutoUpdater, checkForUpdatesManually } from './updater';

const log = createLogger('main');

/** dsh 子进程管理器（全局持有，退出时清理） */
let dshManager: DshManager | null = null;
/** 主窗口引用（用于单实例聚焦、菜单动作、刷新） */
let mainWindow: BrowserWindow | null = null;
/**
 * 是否处于「真正退出」流程。
 * 点击窗口 X / Cmd+W 时若为 false，窗口只隐藏到系统托盘（见 window.ts close 拦截）；
 * 只有托盘/菜单「退出」显式置 true 后才真正结束应用。
 */
let isQuitting = false;
/**
 * 系统托盘是否可用（部分 Linux 桌面环境不支持托盘，创建会失败）。
 * 托盘不可用时关闭窗口应直接退出，否则窗口关闭后无法找回。
 */
let trayAvailable = false;

/** 显式退出入口：置 isQuitting 后走标准退出流程（before-quit 清理 dsh 进程树） */
function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/** 判断「本次窗口关闭是否应最小化到托盘」：托盘可用 && 未在退出流程 */
function shouldHideToTray(): boolean {
  return trayAvailable && !isQuitting;
}

/**
 * 注册主进程与 preload 之间的 IPC 通道。
 * - dsh:get-version：返回桌面端版本，供 preload 桥接使用
 * - dsh:open-external：在系统浏览器打开外部链接（避免网页内导航破坏桌面体验）
 * - dsh:retry：错误兜底页的「重新连接」按钮触发，重启 dsh 并刷新页面
 */
function registerIpc(): void {
  ipcMain.handle('dsh:get-version', () => app.getVersion());

  ipcMain.handle('dsh:open-external', async (_event, url: string) => {
    // 仅允许 http/https，避免任意协议带来的安全风险
    if (/^https?:\/\//.test(url)) {
      await shell.openExternal(url);
    } else {
      log.warn(`拒绝打开非 http(s) 链接: ${url}`);
    }
  });

  // 错误页「重新连接」→ 重启 dsh（onReady 回调会自动刷新窗口到新端口）
  ipcMain.handle('dsh:retry', async () => {
    await dshManager?.restart();
  });
}

/** 获取当前主窗口（供菜单动作使用） */
function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** 显示「关于」对话框 */
function onShowAbout(): void {
  dialog.showMessageBox({
    type: 'info',
    title: '关于 DeepSeek Harness 桌面端',
    message: `DeepSeek Harness 桌面端  v${app.getVersion()}`,
    detail:
      '基于官方 @deepseek-ai/dsh 的 Web 形态构建的 Electron 桌面壳（方案 A）。\n' +
      '所有算力与界面均由官方 dsh 提供，本应用仅负责桌面化集成。',
    buttons: ['确定'],
  });
}

/**
 * 启动整个桌面端：先起 dsh 管理器，再创建窗口（管理器就绪回调会驱动窗口）。
 * 顺序很重要——必须等端口解析完成（服务已监听）才加载页面。
 */
async function bootstrap(): Promise<void> {
  registerIpc();

  // 构建中文应用菜单（含重启 dsh、关于等桌面端特有动作）
  createAppMenu({
    getMainWindow,
    onRestartDsh: () => void dshManager?.restart(),
    onShowAbout,
    onQuit: quitApp,
    onCheckForUpdates: () => void checkForUpdatesManually(),
  });

  // 初始化自动更新（GitHub Release 通道）：
  // 启动 60s 后检查新版本，发现后自动下载，下载完弹窗询问是否重启安装。
  // 仅打包版启用（开发模式无 update 通道，electron-updater 会自行跳过）。
  initAutoUpdater(getMainWindow, { autoDownload: true });

  // 创建系统托盘：窗口最小化后从这里找回；「退出」走 quitApp（置 isQuitting）。
  // 返回 null 表示托盘不可用（如部分 Linux 桌面），此时不拦截窗口关闭。
  trayAvailable = createTray({
    onShowWindow: () => showMainWindow(mainWindow),
    onRestartDsh: () => void dshManager?.restart(),
    onQuit: quitApp,
  }) !== null;

  const config = loadConfig();
  log.info('正在启动 dsh 子进程管理器...');

  dshManager = new DshManager(config, {
    // dsh 就绪（首次或崩溃重启后）：创建窗口或刷新到新端口
    onReady: (port) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createMainWindow(port, config.host, shouldHideToTray);
      } else {
        loadDsh(mainWindow, port, config.host);
      }
    },
    // 运行期间崩溃：先记录，等待自动重启逻辑（onRestarting / onReady）继续
    onCrashed: (code, signal) => {
      log.warn(`dsh 子进程在运行期间退出（code=${code}, signal=${signal}），将尝试自动重启`);
    },
    // 正在进行自动重启：向用户展示「正在重启」提示页
    onRestarting: (attempt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        showFatalError(mainWindow, {
          title: 'dsh 服务异常',
          detail: `dsh 子进程已退出，正在尝试第 ${attempt} 次自动重启，请稍候…`,
        });
      }
    },
    // 启动彻底失败或达到重启上限：展示错误页（或弹窗）而非白屏/静默退出
    onError: (message) => {
      log.error(message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        showFatalError(mainWindow, {
          title: 'dsh 服务不可用',
          detail: `${message}\n点击「重新连接」可再次尝试启动。`,
        });
      } else {
        // 连窗口都还没建起来（首次启动即失败）：弹窗提示后退出
        dialog.showErrorBox('启动失败', message);
        app.quit();
      }
    },
  });

  // 首次启动 dsh（内部含端口冲突重试）
  await dshManager.start();
}

// ------------------------------------------------------------------
// 应用生命周期事件
// ------------------------------------------------------------------

// 单实例锁：避免重复启动多个桌面端（每个实例都会拉起一个 dsh，浪费资源）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 第二个实例启动时，聚焦已有窗口而不是再开一个
  app.on('second-instance', () => {
    showMainWindow(mainWindow);
  });

  // 应用就绪后启动
  app.whenReady().then(bootstrap);

  // macOS 习惯：点 Dock 图标时若无窗口则重建；窗口在托盘里则恢复显示
  app.on('activate', () => {
    if (!showMainWindow(mainWindow) && dshManager?.isRunning) {
      mainWindow = createMainWindow(dshManager.currentPort, undefined, shouldHideToTray);
    }
  });

  // 退出前清理 dsh 子进程树（before-quit 可异步等待）
  app.on('before-quit', async (event) => {
    event.preventDefault(); // 先拦截，等清理完成再真正退出
    destroyTray();          // 移除托盘图标，避免退出后残留
    await dshManager?.stop();
    app.exit();
  });

  // 兜底：终端 Ctrl+C（SIGINT）/ kill（SIGTERM）等信号退出时，Node 进程默认
  // 直接终止、不触发 before-quit 事件，dsh 子进程会残留成孤儿。这里手动补一次
  // 进程树清理再退出（开发期 npm run dev + Ctrl+C 主要靠这条；打包后 GUI 无信号场景则无害）。
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.warn(`收到 ${sig} 信号，清理 dsh 子进程后退出`);
      void (dshManager?.stop() ?? Promise.resolve()).finally(() => app.exit());
    });
  }
}
