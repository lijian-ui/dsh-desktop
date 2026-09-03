/**
 * 拷贝 OfficeCLI 二进制到 vendor/（打包前置步骤）
 * ------------------------------------------------------------------
 * 目的：为桌面端捆绑一个 OfficeCLI 二进制，让 office-preview 路由
 * 不依赖用户系统 PATH，开箱即用 OfficeCLI 的 PPTX/Word 服务端渲染。
 *
 * 输入：officecli/ 目录下的 GitHub Release 二进制文件
 *   officecli-win-x64.exe      → vendor/officecli/win-x64/officecli.exe   （Windows x64）
 *   officecli-mac-x64          → vendor/officecli/mac-x64/officecli       （macOS Intel）
 *   officecli-mac-arm64        → vendor/officecli/mac-arm64/officecli     （macOS Apple Silicon）
 *
 * 下载地址：https://github.com/iOfficeAI/OfficeCLI/releases
 * 每个 Release 包含 11 个资产，选择对应平台的单文件二进制即可。
 *
 * 用法：
 *   node scripts/fetch-officecli.cjs --win     # 只处理 Windows x64
 *   node scripts/fetch-officecli.cjs --mac     # 处理 macOS x64 + arm64
 *   不带参数：按本机平台处理
 *
 * 目录名对应 electron-builder 的 ${os}-${arch} 宏：
 *   win-x64 / mac-x64 / mac-arm64，由 electron-builder.yml 的 extraResources 引用。
 */

const fs = require('fs');
const path = require('path');

// 平台映射：{ electronBuilderTarget: { assetName, destFile } }
// assetName = GitHub Release 中的文件名
// destFile = vendor/officecli/<target>/ 下的文件名
const TARGETS = {
  'win-x64': { assetName: 'officecli-win-x64.exe', destFile: 'officecli.exe' },
  'mac-x64': { assetName: 'officecli-mac-x64', destFile: 'officecli' },
  'mac-arm64': { assetName: 'officecli-mac-arm64', destFile: 'officecli' },
};

const ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'officecli'); // 用户下载的二进制
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'officecli'); // 精简产物

/**
 * 处理单个平台。
 * @param {string} target electron-builder 目标（win-x64 / mac-x64 / mac-arm64）
 * @param {boolean} force 是否强制重建（默认跳过已存在的）
 */
function processTarget(target, force = false) {
  const cfg = TARGETS[target];
  if (!cfg) {
    console.error(`❌ 未知目标: ${target}（可选: ${Object.keys(TARGETS).join(', ')}）`);
    process.exit(1);
  }

  const srcFile = path.join(SRC_ROOT, cfg.assetName);
  const destDir = path.join(VENDOR_ROOT, target);
  const destFile = path.join(destDir, cfg.destFile);

  if (!fs.existsSync(srcFile)) {
    console.error(`❌ 未找到二进制: ${srcFile}\n   请先从 https://github.com/iOfficeAI/OfficeCLI/releases 下载 ${cfg.assetName} 到 officecli/ 目录`);
    process.exit(1);
  }

  if (!force && fs.existsSync(destFile)) {
    const srcSize = (fs.statSync(srcFile).size / 1024 / 1024).toFixed(1);
    const destSize = (fs.statSync(destFile).size / 1024 / 1024).toFixed(1);
    if (Math.abs(srcSize - destSize) < 0.1) {
      console.log(`⏭️  ${target} 已存在，跳过（--force 强制重建）`);
      return;
    }
  }

  // 清空目标目录后重新拷贝
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  fs.copyFileSync(srcFile, destFile);
  // 保证可执行权限（macOS/Linux）
  fs.chmodSync(destFile, 0o755);

  const sizeMB = (fs.statSync(destFile).size / 1024 / 1024).toFixed(1);
  console.log(`✅ ${target} 完成: ${path.relative(ROOT, destFile)} (${sizeMB}MB)`);
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
console.log(`📦 OfficeCLI 二进制: ${targets.join(', ')}${force ? ' [--force]' : ''}`);

for (const t of targets) {
  if (!TARGETS[t]) {
    console.warn(`⚠️  跳过本机不支持的目标: ${t}`);
    continue;
  }
  processTarget(t, force);
}

console.log('\n完成。electron-builder 将通过 extraResources 把 vendor/officecli/<target> 打进安装包。');