/**
 * GitHub 发布脚本（dsh-desktop）
 * ------------------------------------------------------------------
 * 把 electron-builder 打出的产物（dist-electron/）上传到 GitHub Release，
 * 全部走 gh CLI（创建 release + 上传附件），不手写 REST API。
 *
 * 用法：
 *   node scripts/publish-github.mjs          # 单步发布
 *   GH_REPO=lijian-ui/dsh-desktop node scripts/publish-github.mjs   # 自定义仓库（可选）
 *
 * 前置条件：
 *   1. 已安装 gh CLI 并登录：winget install --id GitHub.cli && gh auth login
 *   2. 已构建产物：npm run dist:win
 *   3. 发布说明（可选）：项目根 RELEASE_NOTES.md，缺省用默认文案
 *
 * 流程：
 *   1) 检查 gh 可用性与登录状态
 *   2) 扫描 dist-electron/ 产物 + 解析版本 → tag v{version}
 *   3) 目标 release 不存在 → gh release create（含附件）
 *      已存在         → 清掉同名旧附件后 gh release upload --clobber
 *   4) 打印 release 地址
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  GITHUB_REPO, releaseDir,
  loadReleaseInfo, loadReleaseNotes,
} from './publish-lib.mjs';

/** 实际发布仓库：可用环境变量覆盖，默认取公共模块配置 */
const repo = process.env.GH_REPO || GITHUB_REPO;

/** 附件绝对路径列表（供 gh 上传） */
function assetPaths(files) {
  return files.map((f) => path.join(releaseDir, f));
}

/**
 * 执行 gh 命令，异常时抛出并附带 stderr 摘要。
 * @param {string[]} args gh 子命令参数数组
 */
function runGh(args) {
  try {
    execFileSync('gh', args, { stdio: 'inherit', timeout: 600_000 });
  } catch (err) {
    // execFileSync 已把输出打到控制台，这里只补错误上下文
    throw new Error(`gh ${args[0]} 执行失败（exit ${err.status}）`);
  }
}

/** 检查 gh CLI 可用且已登录 */
function checkGh() {
  execFileSync('gh', ['--version'], { stdio: 'ignore' });
  execFileSync('gh', ['auth', 'status'], { stdio: 'inherit' });
}

/**
 * 目标 tag 是否已存在 release。
 * @param {string} tag
 * @returns {boolean}
 */
function releaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // 1. 前置检查
  console.log('🔍 检查 gh CLI…');
  checkGh();

  // 2. 产物与版本
  const { files, version, tag } = loadReleaseInfo();
  const releaseBody = loadReleaseNotes(version);
  console.log(`📦 GitHub 发布  版本: ${version}  tag: ${tag}  附件 ${files.length} 个`);
  for (const f of files) console.log(`   - ${f}`);

  // 发布说明写入临时文件（gh --notes-file 支持多行且避免 shell 转义）
  const notesFile = path.join(releaseDir, `.release-notes-${tag}.tmp.md`);
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(notesFile, releaseBody, 'utf8');

  try {
    if (!releaseExists(tag)) {
      // 3a. 新 release：create 时直接携带附件
      console.log(`🆕 创建 release ${tag} 并上传附件…`);
      runGh([
        'release', 'create', tag,
        '--repo', repo,
        '--title', `DeepSeek Harness 桌面端 ${version}`,
        '--notes-file', notesFile,
        ...assetPaths(files),
      ]);
    } else {
      // 3b. 已存在：更新说明 + 覆盖同名附件
      console.log(`♻️  更新已有 release ${tag}…`);
      runGh(['release', 'edit', tag, '--repo', repo, '--notes-file', notesFile]);
      console.log('⬆️  上传/覆盖附件…');
      runGh(['release', 'upload', tag, '--repo', repo, '--clobber', ...assetPaths(files)]);
    }
  } finally {
    // 清理临时说明文件
    try { rmSync(notesFile, { force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n✅ 发布完成: https://github.com/${repo}/releases/tag/${tag}`);
}

main().catch((err) => {
  console.error('\n❌ GitHub 发布失败:', err.message);
  process.exit(1);
});
