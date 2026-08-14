/**
 * 自动更新模块（electron-updater 封装，v0.2.0）
 * ------------------------------------------------------------------
 * 基于 electron-updater + GitHub Release 通道（electron-builder.yml publish 配置）。
 *
 * 设计要点：
 * 1. 启动后延迟检查（避免抢占启动资源），发现新版本自动下载。
 * 2. 下载完成弹窗询问用户：立即重启安装 / 稍后手动。
 * 3. 只发布正式版（非 prerelease）：用 channel 语义隔离 dev-preview。
 * 4. 失败静默：自动更新是「锦上添花」，失败不应打扰用户主流程。
 *
 * 注意：主进程需在 app ready 后调用 initAutoUpdater()。
 */

import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { createLogger } from './log';

const log = createLogger('updater');

/** 更新状态（供 UI 或调试展示） */
export enum UpdateStatus {
  Idle = 'idle',
  Checking = 'checking',
  Available = 'available',
  Downloading = 'downloading',
  Downloaded = 'downloaded',
  UpToDate = 'up-to-date',
  Error = 'error',
}

/** 当前更新状态 */
export let updateStatus: UpdateStatus = UpdateStatus.Idle;

/** 是否已初始化（避免重复注册监听） */
let initialized = false;

/**
 * 初始化自动更新。
 * 幂等：重复调用仅首次生效。
 *
 * @param getMainWindow 获取主窗口（用于弹窗确认重启安装）
 * @param options.autoDownload 发现更新后自动下载，默认 true
 */
export function initAutoUpdater(
  getMainWindow: () => BrowserWindow | null,
  options: { autoDownload?: boolean } = {},
): void {
  if (initialized) return;
  initialized = true;

  const autoDownload = options.autoDownload ?? true;

  // electron-updater 默认写日志到文件；控制台也输出便于调试
  autoUpdater.logger = {
    info: (msg) => log.info(String(msg)),
    warn: (msg) => log.warn(String(msg)),
    error: (msg) => log.error(String(msg)),
    debug: (msg) => log.info(`[updater:debug] ${String(msg)}`),
  };

  // ---- 状态回调 ----
  autoUpdater.on('checking-for-update', () => {
    updateStatus = UpdateStatus.Checking;
    log.info('正在检查更新…');
  });

  autoUpdater.on('update-available', (info) => {
    updateStatus = UpdateStatus.Available;
    log.info(`发现新版本: ${info.version}`);
    if (autoDownload) {
      updateStatus = UpdateStatus.Downloading;
      log.info('开始自动下载…');
      void autoUpdater.downloadUpdate().catch((err) => {
        log.error(`自动下载失败: ${err.message}`);
        updateStatus = UpdateStatus.Error;
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    updateStatus = UpdateStatus.UpToDate;
    log.info(`已是最新版本（${info.version}）`);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    // 每秒多次触发；避免刷屏只记百分比
    log.info(`下载进度: ${progressObj.percent.toFixed(1)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateStatus = UpdateStatus.Downloaded;
    log.info(`新版本 ${info.version} 已下载完成`);
    // 弹窗询问是否立即重启安装（需在主窗口上弹出）
    const win = getMainWindow();
    const opts: Electron.MessageBoxOptions = {
      type: 'info',
      title: '更新已就绪',
      message: `DeepSeek Harness 桌面端 ${info.version} 已下载完成`,
      detail: '点击「立即重启」安装并重启应用；或「稍后」手动重启时生效。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const show = (): void => {
      const showBox = (): Promise<Electron.MessageBoxReturnValue> =>
        win && !win.isDestroyed()
          ? dialog.showMessageBox(win, opts)
          : dialog.showMessageBox(opts);
      void showBox().then(({ response }) => {
        if (response === 0) {
          log.info('用户选择立即重启，安装更新…');
          void autoUpdater.quitAndInstall();
        } else {
          log.info('用户选择稍后安装');
        }
      });
    };
    // 窗口可能被托盘隐藏/未创建；就绪后延迟弹出，避免打断用户
    if (win && !win.isDestroyed()) {
      setTimeout(show, 1_000);
    } else {
      // 窗口不可用时（理论上不会，主窗口常驻），退化为直接提示
      show();
    }
  });

  autoUpdater.on('error', (err) => {
    updateStatus = UpdateStatus.Error;
    log.error(`更新出错: ${err.message}`);
  });

  // ---- 启动后延迟检查（避免抢占启动资源） ----
  // 60 秒后首次检查；之后每小时检查一次（electron-updater 自带定时）
  setTimeout(() => {
    log.info('开始首次更新检查…');
    void autoUpdater.checkForUpdates().catch((err) => {
      updateStatus = UpdateStatus.Error;
      log.error(`检查更新失败: ${err.message}`);
    });
  }, 60_000);

  // 每小时自动检查（electron-updater 支持 setInterval 风格，但这里用简单轮询）
  setInterval(() => {
    if (updateStatus === UpdateStatus.Downloading || updateStatus === UpdateStatus.Downloaded) {
      // 正在下载/已下载时不重复检查，避免打断
      return;
    }
    log.info('定时检查更新…');
    void autoUpdater.checkForUpdates().catch((err) => {
      updateStatus = UpdateStatus.Error;
      log.error(`检查更新失败: ${err.message}`);
    });
  }, 60 * 60 * 1000);
}

/**
 * 手动检查更新（供菜单项「检查更新」使用）。
 * @returns 是否有可用更新（仅供 UI 展示，非关键）
 */
export async function checkForUpdatesManually(): Promise<boolean> {
  try {
    updateStatus = UpdateStatus.Checking;
    const result = await autoUpdater.checkForUpdates();
    const available = result?.updateInfo?.version !== undefined;
    log.info(`手动检查完成${available ? '，有新版本' : ''}`);
    return available;
  } catch (err) {
    updateStatus = UpdateStatus.Error;
    log.error(`手动检查更新失败: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
