/**
 * 预加载脚本（Preload）
 * ------------------------------------------------------------------
 * 运行在渲染进程（即 dsh 的 web 页面）加载之前，处于隔离的上下文环境中，
 * 是唯一被允许在「主进程」与「网页」之间架桥的脚本。
 *
 * 方案 A 说明：
 *   当前 dsh 页面通过 HTTP 与后端通信，不需要 preload 注入网络桥接。
 *   本脚本仅暴露「桌面专属能力」，为后续桌面化增强预留接口，例如：
 *     - 在系统默认浏览器中打开外部链接（避免网页内直接跳转丢失桌面体验）
 *     - 读取桌面端版本、平台等元信息
 *
 * 安全约定：
 *   仅通过 contextBridge 暴露最小必要接口，绝不暴露 Node 原始 API 或 require。
 */

import { contextBridge, ipcRenderer } from 'electron';

/** 暴露给网页（window.dshDesktop）的接口类型 */
interface DshDesktopBridge {
  /** 当前运行平台，例如 'win32' / 'darwin' / 'linux' */
  platform: string;
  /** 获取桌面端版本号（来自主进程 package.json，避免硬编码不同步） */
  getVersion(): Promise<string>;
  /** 在系统默认浏览器中打开外部链接 */
  openExternal(url: string): Promise<void>;
  /**
   * 请求主进程「重启 dsh 并刷新页面」。
   * 错误兜底页（dsh 子进程没起来/崩溃）上的「重试」按钮会调用它。
   */
  requestRetry(): Promise<void>;
}

const bridge: DshDesktopBridge = {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('dsh:get-version'),
  openExternal: (url: string) => ipcRenderer.invoke('dsh:open-external', url),
  requestRetry: () => ipcRenderer.invoke('dsh:retry'),
};

// 将桥接接口挂到 window.dshDesktop，供 dsh 页面按需调用
contextBridge.exposeInMainWorld('dshDesktop', bridge);
