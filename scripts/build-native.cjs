/**
 * 物化 koffi 原生二进制 + 补齐平台拆分包（打包前置步骤，best-effort）
 * ------------------------------------------------------------
 * 背景：
 *   1. koffi 不在 npm 包内附带预编译二进制，通过「按平台拆分的 optionalDependencies」
 *      （@koromix/koffi-<platform>-<arch>）提供。npm 安装时**只装当前平台**的包，
 *      双架构打包（--mac --x64 --arm64）会缺失另一架构，目标机器启动即
 *      ERR_MODULE_NOT_FOUND。
 *   2. sharp 同理：@img/sharp-<platform>-<arch> + @img/sharp-libvips-<platform>-<arch>
 *      也是 optionalDependencies，只装当前平台（实测 M 芯片报
 *      "Could not load the sharp module using the darwin-arm64 runtime"）。
 *
 * 本脚本做两件事（都 best-effort，失败不阻断打包）：
 *   1. 本地物化：用当前系统 Node 跑 cnoke（与 dsh 子进程 Node 一致，避免 ABI 错配）
 *   2. 通用补齐：扫描 node_modules 全部 optionalDependencies，凡是以目标平台
 *      （darwin-x64 / darwin-arm64 / win32-x64）结尾的拆分包，若本地缺失则从
 *      npmmirror 下载 tgz 解压到 node_modules 对应位置。
 *      这样 koffi / sharp / libvips 以及未来新增的平台包一次全搞定。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const nodeModulesDir = path.join(ROOT, 'node_modules');
const koffiDir = path.join(nodeModulesDir, 'koffi');

/** 需要补齐的平台（覆盖全部打包目标：Windows x64 + macOS x64/arm64） */
const WANTED_PLATFORMS = ['darwin-x64', 'darwin-arm64', 'win32-x64'];

/** 平台拆分包命名后缀检测：@scope/pkg-<platform> 或 pkg-<platform> */
const PLATFORM_SUFFIX_RE = new RegExp(`-(${WANTED_PLATFORMS.join('|')})$`);

/** scoped 包的 tarball 下载 URL（npmmirror） */
function tarballUrl(scope, name, version) {
  // scoped 包 tarball 路径：/-/name-version.tgz（name 不含 scope）
  const base = scope ? `${scope}/${name}` : name;
  return `https://registry.npmmirror.com/${base}/-/${name}-${version}.tgz`;
}

/** 简单下载到文件（https，跟随重定向，失败抛错） */
function download(url, destFile, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('重定向次数过多'));
          return;
        }
        const loc = res.headers.location;
        download(loc.startsWith('http') ? loc : new URL(loc, url).href, destFile, redirectsLeft - 1)
          .then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const out = fs.createWriteStream(destFile);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('下载超时')));
  });
}

/** 解压 tgz 到目标目录，并把内部 package/ 内容上移一层 */
function extractTgz(tgzPath, destDir) {
  const tmpDir = path.join(path.dirname(tgzPath), `extract-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'inherit' });
  const inner = path.join(tmpDir, 'package');
  if (!fs.existsSync(inner)) throw new Error('tgz 内缺少 package/ 目录');
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, entry), path.join(destDir, entry));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * 扫描 node_modules 下所有包的 optionalDependencies，
 * 收集「以目标平台结尾」的拆分包声明（含版本）。
 * @returns {Map<string, { scope: string|null, name: string, version: string, destDir: string }>}
 */
function collectPlatformOptionalDeps() {
  const result = new Map();

  /** 处理一个包的 optionalDependencies */
  const handleOptional = (pkgDir) => {
    const pjPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pjPath)) return;
    try {
      const pkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      const opt = pkg.optionalDependencies;
      if (!opt) return;
      for (const [depName, version] of Object.entries(opt)) {
        if (!PLATFORM_SUFFIX_RE.test(depName)) continue;
        // 解析 scope 与 name
        const parts = depName.split('/');
        const scope = parts.length === 2 ? parts[0] : null;
        const name = parts.length === 2 ? parts[1] : depName;
        result.set(depName, {
          scope,
          name,
          version: version.replace(/^[~^]/, ''),
          destDir: path.join(nodeModulesDir, scope || '', name),
        });
      }
    } catch {
      // 忽略损坏的 package.json
    }
  };

  // 顶层包
  for (const entry of fs.readdirSync(nodeModulesDir)) {
    if (entry.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry);
      if (!fs.statSync(scopeDir).isDirectory()) continue;
      for (const sub of fs.readdirSync(scopeDir)) {
        handleOptional(path.join(scopeDir, sub));
      }
    } else {
      handleOptional(path.join(nodeModulesDir, entry));
    }
  }
  return result;
}

/** 通用补齐：缺失的平台拆分包从 npmmirror 下载解压（best-effort） */
async function ensurePlatformPackages() {
  const missing = [];
  for (const [depName, info] of collectPlatformOptionalDeps()) {
    if (fs.existsSync(path.join(info.destDir, 'package.json'))) continue;
    missing.push({ depName, ...info });
  }

  if (missing.length === 0) {
    console.log('[build-native] 平台拆分包全部就绪，无需补齐');
    return;
  }

  for (const { depName, scope, name, version, destDir } of missing) {
    try {
      console.log(`[build-native] 下载缺失平台包: ${depName}@${version} ...`);
      const tgzPath = path.join(nodeModulesDir, `${name}-${version}.tgz`);
      await download(tarballUrl(scope, name, version), tgzPath);
      extractTgz(tgzPath, destDir);
      fs.rmSync(tgzPath, { force: true });
      console.log(`[build-native]   -> 已补齐 ${destDir}`);
    } catch (err) {
      // best-effort：失败仅告警，运行时对应模块仍可能自行解决
      console.warn(`[build-native] 平台包 ${depName} 补齐失败（忽略）: ${err.message}`);
    }
  }
}

async function main() {
  try {
    if (!fs.existsSync(koffiDir)) {
      console.warn('[build-native] 未找到 koffi 目录，跳过物化步骤');
      return;
    }

    console.log('[build-native] 正在物化 koffi 预编译原生二进制...');
    // 参数与 koffi 自身 install 脚本一致：-P 包目录, -D 源码目录, --prebuild 下载预编译, --release 发布构建
    execFileSync(process.execPath, [
      'cnoke.cjs',
      '-P', '.',
      '-D', 'src/koffi',
      '--prebuild',
      '--release',
    ], {
      cwd: koffiDir,
      stdio: 'inherit',
    });
    console.log('[build-native] koffi 原生二进制物化完成');
  } catch (err) {
    // 失败仅告警：运行时 koffi 仍可自动下载，不影响打包继续
    console.warn(`[build-native] koffi 物化失败（运行时将自动下载，不影响打包）: ${err.message}`);
  }

  // 通用补齐平台拆分包（双架构打包必需，覆盖 koffi/sharp/libvips 等）
  await ensurePlatformPackages();
}

main().catch((err) => {
  console.warn(`[build-native] 异常（忽略）: ${err.message}`);
});
