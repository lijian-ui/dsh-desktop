/**
 * 应用菜单模块（中文）
 * ------------------------------------------------------------------
 * 负责构建 Electron 顶栏/系统菜单，所有标签均为中文。
 * 通过 MenuHandlers 把菜单动作回调给主进程（如重启 dsh、显示关于对话框）。
 *
 * 设计要点：
 * 1. 编辑 / 视图 / 窗口 等使用 Electron 内置 role，可自动获得快捷键与跨平台行为，
 *    我们仅显式指定中文 label，不改变其语义。
 * 2. 「重启 dsh 服务」与「关于」是桌面端特有动作，需回调主进程处理。
 * 3. macOS 与 Windows/Linux 的菜单结构略有差异（macOS 首项为应用名菜单）。
 */

import { Menu, BrowserWindow, app, shell } from 'electron';

/** 菜单动作所需的回调集合（由主进程注入） */
export interface MenuHandlers {
  /** 获取当前主窗口（用于「重新加载页面」「开发者工具」等） */
  getMainWindow(): BrowserWindow | null;
  /** 重启 dsh 子进程（菜单项与错误页共用） */
  onRestartDsh(): void;
  /** 显示「关于」对话框 */
  onShowAbout(): void;
  /**
   * 退出应用：先置 isQuitting 标志再 quit，否则会被窗口 close 拦截
   * 变成「最小化到托盘」，永远退不掉。
   */
  onQuit(): void;
}

/**
 * 构建并设置中文应用菜单。
 *
 * @param handlers 菜单动作回调
 * @returns 已设置的 Menu 实例
 */
export function createAppMenu(handlers: MenuHandlers): Menu {
  const isMac = process.platform === 'darwin';

  // 应用菜单（仅 macOS 需要，Windows/Linux 用「文件」承载退出等）
  const appMenu: Electron.MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name || 'DeepSeek Harness',
          submenu: [
            { label: '关于', click: () => handlers.onShowAbout() },
            { type: 'separator' },
            // 退出必须走 onQuit（置 isQuitting），否则 close 拦截会吞掉退出
            { label: '退出', accelerator: 'Cmd+Q', click: () => handlers.onQuit() },
          ],
        },
      ]
    : [];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载页面',
          accelerator: 'CmdOrCtrl+R',
          click: () => handlers.getMainWindow()?.reload(),
        },
        {
          label: '重启 dsh 服务',
          click: () => handlers.onRestartDsh(),
        },
        { type: 'separator' },
        // 退出必须走 onQuit（置 isQuitting），避免被窗口 close 拦截为「最小化到托盘」
        { label: '退出', accelerator: isMac ? 'Cmd+Q' : 'Ctrl+Q', click: () => handlers.onQuit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '刷新', role: 'reload' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '切换全屏', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: '开发者工具', role: 'toggleDevTools' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' },
        { type: 'separator' },
        { label: '全部置于顶层', role: 'front' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于', click: () => handlers.onShowAbout() },
        {
          label: '访问 DeepSeek 官网',
          click: () => void shell.openExternal('https://www.deepseek.com'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}
