/**
 * 精简拷贝 Node.js 运行时到 vendor/（打包前置步骤，v0.2.0）
 * ------------------------------------------------------------------
 * 目的：为桌面端捆绑一个精简版 Node 运行时，让 dsh 子进程不依赖用户系统 Node，
 * 彻底解决「用户未装 Node / nvm 探测不到 / 系统旧版 Node 命中」等环境问题。
 *
 * 输入：node/ 目录下的官方 Node 发行包（已解压，用户下载，见 docs/node-runtime-bundling.md）
 *   node-v24.19.0-win-x64/        → vendor/node/win-x64/       （Windows x64）
 *   node-v24.19.0-darwin-x64/     → vendor/node/mac-x64/       （macOS Intel）
 *   node-v24.19.0-darwin-arm64/   → vendor/node/mac-arm64/     （macOS Apple Silicon）
 *
 * 精简策略：只保留可执行文件本体，删除 npm/npx/include/share 等构建用不上的内容。
 *   - Windows: node.exe（官方 zip 的 node.exe 自包含，内建全部模块）
 *   - macOS/Linux: bin/node（同理，内建模块编译进二进制）
 *   Node 的 N-API 内建能力（fs/path/child_process/url 等）都在二进制内，无需 lib。
 *
 * 用法：
 *   node scripts/fetch-node.cjs --win     # 只处理 Windows x64
 *   node scripts/fetch-node.cjs --mac     # 处理 macOS x64 + arm64
 *   不带参数：按本机平台处理
 *
 * 目录名对应 electron-builder 的 ${os}-${arch} 宏：
 *   win-x64 / mac-x64 / mac-arm64，由 electron-builder.yml 的 extraResources 引用。
 */

const fs = require('fs');
const path = require('path');

// 发行包版本（与 node/ 目录一致，更新 Node 版本时同步改这里）
const NODE_VERSION = 'v24.19.0';

// 平台映射：{ electronBuilderTarget: { os, arch, distDir } }
// distDir = node/ 下的官方发行目录名
const TARGETS = {
  'win-x64': { distDir: `node-${NODE_VERSION}-win-x64`, nodeFile: 'node.exe' },
  'mac-x64': { distDir: `node-${NODE_VERSION}-darwin-x64`, nodeFile: 'bin/node' },
  'mac-arm64': { distDir: `node-${NODE_VERSION}-darwin-arm64`, nodeFile: 'bin/node' },
};

const ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'node'); // 官方发行包
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'node'); // 精简产物

/** 递归拷贝目录（保留结构） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/**
 * 精简处理单个平台。
 * @param {string} target electron-builder 目标（win-x64 / mac-x64 / mac-arm64）
 * @param {boolean} force 是否强制重建（默认跳过已存在的）
 */
function processTarget(target, force = false) {
  const cfg = TARGETS[target];
  if (!cfg) {
    console.error(`❌ 未知目标: ${target}（可选: ${Object.keys(TARGETS).join(', ')}）`);
    process.exit(1);
  }

  const srcDir = path.join(SRC_ROOT, cfg.distDir);
  const destDir = path.join(VENDOR_ROOT, target);

  if (!fs.existsSync(srcDir)) {
    console.error(`❌ 未找到发行包: ${srcDir}\n   请先从官方/镜像下载并解压 Node ${NODE_VERSION}（见 docs/node-runtime-bundling.md）`);
    process.exit(1);
  }

  if (!force && fs.existsSync(path.join(destDir, path.basename(cfg.nodeFile)))) {
    console.log(`⏭️  ${target} 已精简，跳过（--force 强制重建）`);
    return;
  }

  // 清空目标目录后重新拷贝
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  // 只拷贝可执行文件本体（+ 保持 bin/ 目录结构以便路径稳定）
  const nodeFile = cfg.nodeFile;
  const destFile = path.join(destDir, nodeFile);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.copyFileSync(path.join(srcDir, nodeFile), destFile);
  // 保证可执行权限（macOS/Linux）
  fs.chmodSync(destFile, 0o755);

  // Windows 额外拷贝同目录 dll（node.exe 依赖的，若有）
  if (process.platform === 'win32' && cfg.nodeFile === 'node.exe') {
    const srcNodeDir = path.dirname(path.join(srcDir, 'node.exe'));
    for (const f of fs.readdirSync(srcNodeDir)) {
      if (f.endsWith('.dll')) fs.copyFileSync(path.join(srcNodeDir, f), path.join(destDir, f));
    }
  }

  const sizeMB = (fs.statSync(destFile).size / 1024 / 1024).toFixed(1);
  console.log(`✅ ${target} 精简完成: ${path.relative(ROOT, destFile)} (${sizeMB}MB)`);
}

/** 解析命令行目标列表 */
function resolveTargets() {
  const args = process.argv.slice(2);
  if (args.includes('--win')) return ['win-x64'];
  if (args.includes('--mac')) return ['mac-x64', 'mac-arm64'];
  if (args.includes('--force')) return Object.keys(TARGETS);
  // 无参数：按本机平台
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return [`${platform}-${arch}`];
}

// 主流程
const targets = resolveTargets();
const force = process.argv.includes('--force');
console.log(`📦 Node 运行时精简（${NODE_VERSION}）: ${targets.join(', ')}${force ? ' [--force]' : ''}`);

for (const t of targets) {
  if (!TARGETS[t]) {
    console.warn(`⚠️  跳过本机不支持的目标: ${t}`);
    continue;
  }
  processTarget(t, force);
}

console.log('\n完成。electron-builder 将通过 extraResources 把 vendor/node/<target> 打进安装包。');
