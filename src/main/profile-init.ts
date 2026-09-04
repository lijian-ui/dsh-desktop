/**
 * profile 离线部署模块（打包集成 im-gateway 的核心）
 * ------------------------------------------------------------------
 * 目标：让「下载安装包即用」成立——用户机器上首次启动时，`~/.dsh/profiles/web`
 * 还不存在（或没有 im-gateway），本模块在 spawn dsh 之前把它准备好：
 *
 *   1. 若 profile 目录缺失 → 写入与官方 web profile 同构的模板
 *      （package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml）。
 *   2. 把插件的 junction 链接建到 `profile/node_modules/@lijian-ui/dsh-im-gateway`，
 *      指向桌面壳 node_modules 里的实体（打包期 = app.asar.unpacked/node_modules，
 *      开发期 = 项目根 node_modules）。dsh 启动时 reconcilePlugins 会把声明了
 *      `dsh.bundle` 的 dependencies 自动并入层栈，因此无需手动维护 bundles 数组。
 *   3. 插件依赖（qqbot-nodejs / dingtalk-stream 等）随 npm install 进桌面壳
 *      node_modules；node 的模块解析从 junction 的「物理目标」向上找 node_modules，
 *      自动命中桌面壳 node_modules —— 无需联网、无需 pnpm、无需符号链接 store。
 *
 * 幂等：profile 已存在只做「补齐」；junction 目标变化（升级重装路径变更）会重建。
 * 失败不抛错（仅 warn），避免阻断 dsh 本体启动。
 */

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { app } from 'electron';
import { DshConfig } from './config';

/** 内置的自研插件包名（与 npm 发布名一致）——打包版随桌面壳分发并自动启用 */
export const IM_GATEWAY_BUNDLE = '@lijian-ui/dsh-im-gateway';
export const SESSION_CLEANER_BUNDLE = '@lijian-ui/dsh-session-cleaner';
/** 文件管理面板插件（Explorer + Preview + `@` 提及引用）。
 *  已发布到 npm（`@lijian-ui/dsh-file-manager`），在根 package.json 依赖中声明，
 *  由 `npm install` 从 registry 拉取；profile junction 指向桌面壳 node_modules 中的实体。 */
export const FILE_MANAGER_BUNDLE = '@lijian-ui/dsh-file-manager';
/** 终端面板插件（PTY + xterm.js + 会话页 header AnimatedDock 工具坞）。
 *  已发布到 npm（`@lijian-ui/dsh-term`，含 dock scale 防抖修复），在根 package.json
 *  依赖中声明，由 `npm install` 从 registry 拉取；profile junction 指向桌面壳 node_modules 中的实体。 */
export const DSH_TERM_BUNDLE = '@lijian-ui/dsh-term';
/** 技能管理插件（skill 列表 / 启用 / 停用 / 删除 / 添加 / 迁移）。
 *  已发布到 npm（`@lijian-ui/dsh-skill-manage`），在根 package.json 依赖中声明，
 *  由 `npm install` 从 registry 拉取；profile junction 指向桌面壳 node_modules 中的实体。 */
export const SKILL_MANAGE_BUNDLE = '@lijian-ui/dsh-skill-manage';
/** 定时任务插件（cron 表达式调度 + 跨 session 消息注入 + 四级通知）。
 *  纯 UI 管理、零 LLM tool，到期以 `请根据系统指令开始执行任务。` 注入目标 session。
 *  在根 package.json 依赖中声明，由 `npm install` 从 registry 拉取；
 *  profile junction 指向桌面壳 node_modules 中的实体。 */
export const SCHEDULE_VIEW_BUNDLE = '@lijian-ui/dsh-schedule-view';
/** 社区插件市场（dshplugin/dsh-plugin-hub）：应用内浏览/搜索/安装 4000+ 社区插件。
 *  依赖官方 `dsh plugin` CLI，安装走 profile 目录 pnpm，与预置 junction 插件共存。 */
export const PLUGIN_HUB_BUNDLE = 'dsh-plugin';

/** 模型视觉能力开关插件（settings 页：按模型切换「支持图片」）。
 *  读取/写回官方 `llm-pi-ai` 命名空间的 `input` 模态，无需手改 settings.yaml。
 *  本地开发以 file: dependencies 链接到 extensions/dsh-vision-toggle。 */
export const VISION_TOGGLE_BUNDLE = '@lijian-ui/dsh-vision-toggle';

/** 全部自研插件（逐个建立 profile junction + 层栈声明）。
 *  注意：@lijian-ui/dsh-office 已停用（仅作代码参考），不再注册进 bundle，避免
 *  未安装导致 ensurePluginLink 启动抛错。 */
export const PLUGIN_BUNDLES: string[] = [IM_GATEWAY_BUNDLE, SESSION_CLEANER_BUNDLE, FILE_MANAGER_BUNDLE, DSH_TERM_BUNDLE, SKILL_MANAGE_BUNDLE, SCHEDULE_VIEW_BUNDLE, PLUGIN_HUB_BUNDLE, VISION_TOGGLE_BUNDLE];

/** profile 层栈里的官方内置 bundle（dsh 从自身解析，不在 profile node_modules 里） */
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

/** profile 模板文件（结构与官方 web profile 同构，nodeLinker 必须 hoisted 便于离线） */
const CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;
const CORDIS_PATCH_YML = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;
const PNPM_WORKSPACE_YML = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** 桌面壳 node_modules 根目录（插件实体与全部依赖所在；NODE_PATH 兜底也指向这里） */
export function resolveBundledNodeModules(config: DshConfig): string {
  // 打包期：electron-builder 把 node_modules 全量解包到 app.asar.unpacked
  // 开发期：项目根 node_modules（npm install 后插件随根依赖进入）
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
    : path.join(process.cwd(), 'node_modules');
}

/** 桌面壳 node_modules 里插件的实体路径（junction 的目标） */
function resolvePluginSource(bundleName: string, config: DshConfig): string {
  return path.join(resolveBundledNodeModules(config), ...bundleName.split('/'));
}

/** 计算 dsh 用户数据目录（与 config.ts buildDshEnv 的 DSH_HOME 保持一致） */
function resolveDshHome(): string {
  return path.join(homedir(), '.dsh');
}

/**
 * 读取 profile 的 package.json；缺失返回 null。
 */
function readProfileManifest(profileDir: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 把全部插件 bundle 补齐到 profile 的 package.json（dependencies + bundles 数组）。
 * 返回 true 表示发生了写入。
 */
function patchProfileManifest(profileDir: string, manifest: Record<string, unknown>): boolean {
  const deps = (manifest.dependencies ?? {}) as Record<string, string>;
  const dsh = (manifest.dsh ?? {}) as Record<string, unknown>;
  const profile = (dsh.profile ?? {}) as Record<string, unknown>;
  const bundles = (profile.bundles ?? []) as string[];

  let changed = false;
  for (const bundle of PLUGIN_BUNDLES) {
    if (!(bundle in deps)) {
      deps[bundle] = '^0.1.0';
      changed = true;
    }
    // 显式把插件写进层栈（reconcile 也会补，这里双保险保证顺序在官方 bundle 之后）
    if (!bundles.includes(bundle)) {
      bundles.push(bundle);
      changed = true;
    }
  }
  if (!BASE_BUNDLES.every((b) => bundles.includes(b))) {
    for (const b of [...BASE_BUNDLES].reverse()) {
      if (!bundles.includes(b)) bundles.unshift(b);
    }
    changed = true;
  }

  if (!changed) return false;
  manifest.dependencies = deps;
  manifest.dsh = { ...dsh, profile: { ...profile, bundles } };
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * 确保 `profile/node_modules/<bundle>` junction 存在且指向当前实体。
 * 目标不一致（升级/换路径）时删除重建。
 */
function ensurePluginLink(profileDir: string, bundleName: string, source: string): void {
  const linkPath = path.join(profileDir, 'node_modules', ...bundleName.split('/'));
  if (!fs.existsSync(source)) {
    throw new Error(`插件实体不存在（请确认已 npm install 或打包完整）: ${source}`);
  }
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    // 已有链接：校验目标是否一致
    try {
      const existing = fs.readlinkSync(linkPath);
      if (path.resolve(existing) === path.resolve(source)) return; // 一致，无需动
      // 目标变化：删除旧链接重建（junction 是链接不是目录内容，unlink 即可）
      fs.unlinkSync(linkPath);
    } catch (err) {
      // readlink 失败 = 不是链接（可能是个真实目录/残留），尝试移除后重建
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(source, linkPath, 'junction');
}

/**
 * 首次启动离线部署：把 im-gateway 固化进 `~/.dsh/profiles/<name>`。
 *
 * @returns 部署详情（供日志）；任何失败以 throw 表达，由调用方决定是否阻断。
 */
export function ensureImGatewayProfile(config: DshConfig): { profileDir: string; pluginSources: string[] } {
  const profileName = config.profile ?? 'web';
  const profileDir = path.join(resolveDshHome(), 'profiles', profileName);

  fs.mkdirSync(profileDir, { recursive: true });

  // 1. 补齐模板文件（缺哪个补哪个，不覆盖已有内容）
  const files: Array<[string, string]> = [
    ['cordis.yml', CORDIS_YML],
    ['cordis.patch.yml', CORDIS_PATCH_YML],
    ['pnpm-workspace.yaml', PNPM_WORKSPACE_YML],
  ];
  for (const [name, content] of files) {
    const p = path.join(profileDir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf-8');
  }

  // 2. package.json：缺失则创建最小模板，存在则只补齐插件依赖/层栈
  let manifest = readProfileManifest(profileDir);
  if (!manifest) {
    manifest = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...BASE_BUNDLES] } },
    };
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }
  patchProfileManifest(profileDir, manifest);

  // 3. 全部插件 junction（依赖解析靠它的物理目标向上命中桌面壳 node_modules）
  const pluginSources: string[] = [];
  for (const bundle of PLUGIN_BUNDLES) {
    const source = resolvePluginSource(bundle, config);
    ensurePluginLink(profileDir, bundle, source);
    pluginSources.push(source);
  }

  return { profileDir, pluginSources };
}

/**
 * 首次启动内置 office-cli skill 落盘到全局 skills 目录 `~/.dsh/skills/office-cli/`。
 *
 * 与插件 profile 同构的「下载即用」引导：dsh 的全局 skills 目录为 `~/.dsh/skills/`，
 * skill 子系统会自动发现其中的 SKILL.md，因此用户无需手动拷贝即可获得官方 officecli
 * skill。打包期源 = resources/office-cli-skill/（extraResources 产物），开发期源 =
 * 项目根 skills/office-cli/。
 *
 * 幂等/策略：目标目录已存在则整体跳过（不覆盖，保护用户对自己的修改），只做首次
 * 播种；随包分发的 SKILL.md 为启用态，首次安装即启用。失败以 throw 表达（不抛出错误
 * 则由调用方决定是否阻断）。
 *
 * @returns 播种的目标目录；已存在（跳过）时返回 null
 */
export function seedBundledOfficeCliSkill(): string | null {
  const source = app.isPackaged
    ? path.join(process.resourcesPath, 'office-cli-skill')
    : path.join(process.cwd(), 'skills', 'office-cli');
  const skillDir = path.join(resolveDshHome(), 'skills', 'office-cli');

  if (fs.existsSync(skillDir)) return null; // 已存在：跳过，保留用户改动

  fs.cpSync(source, skillDir, { recursive: true });
  return skillDir;
}
