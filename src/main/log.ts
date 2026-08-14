/**
 * 日志模块
 * ------------------------------------------------------------------
 * 桌面端主进程统一日志输出工具。
 *
 * 设计要点：
 * 1. 所有日志带 ISO 时间戳与模块标签（scope），方便区分「主进程」与「dsh 子进程」输出。
 * 2. 不引入第三方日志库，保持零额外依赖、可在 Node / Electron 主进程直接使用。
 * 3. 通过 createLogger(scope) 工厂生成带固定标签的 logger 实例，各模块按需创建。
 */

/** 支持的日志级别 */
export type LogLevel = 'info' | 'warn' | 'error';

/** 一个带固定标签的 logger 接口 */
export interface Logger {
  /** 普通信息 */
  info(...args: unknown[]): void;
  /** 警告信息 */
  warn(...args: unknown[]): void;
  /** 错误信息 */
  error(...args: unknown[]): void;
}

/** 不同级别对应的控制台方法，集中映射避免散落调用 */
const consoleByLevel: Record<LogLevel, (...args: unknown[]) => void> = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

/**
 * 创建一个带固定标签的 logger。
 *
 * @param scope 模块标签，例如 'main'（主进程）、'dsh'（dsh 子进程输出）
 * @returns Logger 实例
 */
export function createLogger(scope: string): Logger {
  /**
   * 统一的日志打印实现。
   * 前缀格式：[时间戳] [scope] 消息...
   */
  const print = (level: LogLevel, args: unknown[]): void => {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${scope}]`;
    consoleByLevel[level](prefix, ...args);
  };

  return {
    info: (...args) => print('info', args),
    warn: (...args) => print('warn', args),
    error: (...args) => print('error', args),
  };
}
