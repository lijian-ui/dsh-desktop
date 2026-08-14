/**
 * 系统托盘模块
 * ------------------------------------------------------------------
 * 负责创建应用常驻的系统托盘（Tray）：
 *   - Windows / Linux：托盘区图标 + 右键菜单
 *   - macOS：菜单栏图标（点击弹出菜单）
 *
 * 设计要点：
 * 1. 关闭窗口 → 最小化到托盘（见 window.ts 的 close 拦截），托盘是用户找回窗口的入口。
 * 2. 图标复用 build/icon.png（黑色鲸鱼），resize 到 32×32 适配托盘显示尺寸。
 * 3. 托盘菜单只放高频动作：显示窗口 / 重启 dsh / 退出；「退出」必须走 onQuit
 *    （置 isQuitting 后真正退出），否则会被窗口的 close 拦截吞掉。
 * 4. 创建失败不阻断应用：仅告警，用户仍可用 Dock/任务栏操作窗口。
 */

import { Tray, Menu, nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './log';

const log = createLogger('tray');

/** 托盘动作回调（由主进程注入） */
export interface TrayHandlers {
  /** 显示并聚焦主窗口（窗口可能处于隐藏/最小化状态） */
  onShowWindow(): void;
  /** 重启 dsh 服务（与菜单项、错误页共用同一入口） */
  onRestartDsh(): void;
  /** 真正退出应用（先置 isQuitting，避免被 close 拦截） */
  onQuit(): void;
}

/** 全局托盘实例（主进程生命周期内唯一） */
let tray: Tray | null = null;

/**
 * 解析托盘图标：优先 build/icon.png（黑鲸，由 generate-icon.cjs 生成），
 * resize 到 32×32——Windows 托盘 / macOS 菜单栏的常规尺寸。
 */
function resolveTrayIcon(): Electron.NativeImage {
  const iconPath = path.join(__dirname, '../../build/icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 });
  }
  // 兜底：仅开发期可能出现（build/ 未生成），不影响应用启动
  log.warn('未找到托盘图标 build/icon.png，使用空图标');
  return nativeImage.createEmpty();
}

/**
 * 创建系统托盘并挂上菜单与交互事件。
 *
 * @param handlers 托盘动作回调
 * @returns 创建的 Tray 实例；失败时返回 null（不阻断应用）
 */
export function createTray(handlers: TrayHandlers): Tray | null {
  try {
    tray = new Tray(resolveTrayIcon());

    // 右键（macOS 为点击）上下文菜单
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => handlers.onShowWindow() },
      { type: 'separator' },
      { label: '重启 dsh 服务', click: () => handlers.onRestartDsh() },
      { type: 'separator' },
      // 退出必须显式标记（onQuit 内部置 isQuitting），否则 close 拦截会把它变成「隐藏」
      { label: '退出', click: () => handlers.onQuit() },
    ]);
    tray.setToolTip('DeepSeek Harness 桌面端');
    tray.setContextMenu(contextMenu);

    // Windows：单击/双击托盘图标都恢复窗口（macOS 单击默认弹出菜单，无需处理）
    tray.on('click', () => {
      if (process.platform === 'win32') handlers.onShowWindow();
    });
    tray.on('double-click', () => handlers.onShowWindow());

    log.info('系统托盘已创建');
    return tray;
  } catch (err) {
    // 个别 Linux 桌面环境无托盘支持，创建失败仅告警
    log.warn(`系统托盘创建失败（不影响使用）: ${(err as Error).message}`);
    return null;
  }
}

/** 销毁托盘（应用退出时调用，避免残留托盘图标） */
export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
