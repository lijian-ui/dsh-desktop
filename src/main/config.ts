/**
 * 配置模块
 * ------------------------------------------------------------------
 * 负责读取桌面端的运行配置，并组装传给官方 dsh 子进程的环境变量。
 *
 * 设计要点：
 * 1. dsh 官方只暴露 CLI，我们通过子进程启动 `dsh web`，因此需要在这里集中管理：
 *    - 监听地址（host）与端口（port）
 *    - API Key 等敏感凭证（通过环境变量注入子进程，而不是命令行参数，避免泄露到进程列表）
 *    - 允许透传的额外 CLI 参数
 * 2. 凭证优先级：环境变量 > 本地 config.json 文件。文件里的明文密钥仅作本地开发兜底。
 * 3. config.json 已在 .gitignore 中忽略，切勿提交真实密钥。
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/** 桌面端运行配置 */
export interface DshConfig {
  /** HTTP 监听地址，默认 127.0.0.1（仅本机，不暴露到网络） */
  host: string;
  /** 监听端口，传 0 让操作系统分配一个空闲端口，避免 3080 默认端口冲突 */
  port: number;
  /** DeepSeek API Key（可选，缺失时 dsh 会在其 UI 内提示填写） */
  apiKey?: string;
  /** 需要原样透传给 `dsh web` 的额外命令行参数 */
  extraArgs: string[];
}

/** 本地配置文件名称（位于项目根或用户数据目录） */
const CONFIG_FILE_NAME = 'config.json';

/**
 * 读取一份可选的本地配置文件。
 * 优先读取项目根目录下的 config.json，其次读取用户数据目录（打包后场景）。
 * 文件不存在时返回空对象，不抛错。
 */
function readLocalConfigFile(): Partial<DshConfig> {
  const candidates = [
    path.join(process.cwd(), CONFIG_FILE_NAME),
    app.isPackaged ? path.join(app.getPath('userData'), CONFIG_FILE_NAME) : null,
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        return JSON.parse(raw) as Partial<DshConfig>;
      }
    } catch (err) {
      // 配置文件损坏或解析失败时忽略，回退到默认值 / 环境变量
      console.warn(`[config] 读取配置文件失败，已忽略: ${file}`, err);
    }
  }
  return {};
}

/**
 * 加载配置。
 * 优先级：环境变量 > 本地 config.json > 内置默认值。
 */
export function loadConfig(): DshConfig {
  const fileConfig = readLocalConfigFile();

  // API Key：环境变量优先，其次是配置文件（避免把密钥写进启动命令）
  const apiKey = process.env.DEEPSEEK_API_KEY || fileConfig.apiKey;

  return {
    host: process.env.DSH_HOST || fileConfig.host || '127.0.0.1',
    port: fileConfig.port ?? (process.env.DSH_PORT ? Number(process.env.DSH_PORT) : 0),
    apiKey,
    extraArgs: fileConfig.extraArgs ?? [],
  };
}

/**
 * 组装传给 dsh 子进程的环境变量。
 * 关键点：把 API Key 放进环境变量，而不是命令行参数，避免 `ps` 等命令泄露密钥。
 *
 * @param config 当前配置
 * @returns 合并后的环境变量对象（基于当前进程环境）
 */
export function buildDshEnv(config: DshConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (config.apiKey) {
    // dsh 官方约定的 API Key 环境变量名
    env.DEEPSEEK_API_KEY = config.apiKey;
  }

  return env;
}
