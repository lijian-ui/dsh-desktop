/**
 * 发布脚本公共模块（供 publish-github.mjs 使用）
 * ------------------------------------------------------------------
 * 职责：发布目标配置、产物识别与扫描、版本解析、发布说明加载。
 * 与 pi-desktop 的 publish-lib.mjs 对齐，但按 dsh-desktop 需求精简：
 *   - 只发 GitHub（无 Gitee / 镜像加速 / 多平台子目录合并）
 *   - 产物目录 = electron-builder 的 directories.output（dist-electron/）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ────────────────────────── 发布目标配置 ──────────────────────────
/** GitHub 仓库（owner/repo），对应 electron-app 的 git remote origin */
export const GITHUB_REPO = 'lijian-ui/dsh-desktop';

/** 产物目录：与 electron-builder.yml 的 directories.output 保持一致 */
export const releaseDir = path.join(__dirname, '..', 'dist-electron');

// ────────────────────────── 产物识别 ──────────────────────────
/** 需要上传为 release 附件的扩展名（electron-builder Windows nsis 产物） */
const ASSET_EXTS = ['.exe', '.dmg', '.AppImage', '.deb', '.zip', '.yml', '.blockmap'];

/**
 * 判断文件名是否为可上传产物。
 * 排除构建调试文件（builder-*.yml / *.yaml），其余按扩展名匹配。
 * @param {string} f 文件名
 * @returns {boolean}
 */
export function isAsset(f) {
  if (f.startsWith('builder-')) return false;
  return ASSET_EXTS.some((ext) => f.endsWith(ext));
}

// ────────────────────────── 产物扫描 + 版本解析 ──────────────────────────
/**
 * 扫描产物目录并解析版本 / tag。
 * @returns {{ files: string[], version: string, tag: string }}
 *   files  - dist-electron/ 顶层产物文件名列表
 *   version- package.json 的 version
 *   tag    - release tag（v{version}）
 */
export function loadReleaseInfo() {
  if (!fs.existsSync(releaseDir)) {
    console.error(`❌ 产物目录不存在（${releaseDir}），请先运行 npm run dist:win`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(releaseDir)
    .filter((f) => fs.statSync(path.join(releaseDir, f)).isFile() && isAsset(f));

  if (files.length === 0) {
    console.error(`❌ ${releaseDir}/ 下没有可发布产物（.exe/.yml/.blockmap 等）`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!version) {
    console.error('❌ package.json 缺少 version 字段');
    process.exit(1);
  }

  return { files, version, tag: `v${version}` };
}

// ────────────────────────── 发布说明 ──────────────────────────
/**
 * 加载发布说明：优先读项目根的 RELEASE_NOTES.md，否则用默认文案。
 * @param {string} version 版本号
 * @returns {string} 发布说明内容
 */
export function loadReleaseNotes(version) {
  const notesPath = path.join(__dirname, '..', 'RELEASE_NOTES.md');
  if (fs.existsSync(notesPath)) {
    console.log(`📝 使用 RELEASE_NOTES.md 作为发布说明`);
    return fs.readFileSync(notesPath, 'utf8');
  }
  console.log(`💡 未找到 RELEASE_NOTES.md，使用默认发布说明（可创建它来自定义）`);
  return `DeepSeek Harness 桌面端 ${version}\n\n> 在项目根目录创建 RELEASE_NOTES.md 即可自定义发布说明。`;
}
