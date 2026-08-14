/**
 * 物化 koffi 原生二进制（打包前置步骤，best-effort）
 * ------------------------------------------------------------
 * koffi 不在 npm 包内附带预编译二进制，而是通过「按平台拆分的 optionalDependencies」
 * （@koromix/koffi-<platform>-<arch>）提供。npm 安装时**只装当前平台**的包，
 * 因此本机 node_modules/@koromix/ 下通常只有一种架构——这会导致双架构打包
 * （--mac --x64 --arm64）时缺失另一架构的 koffi，目标机器启动即
 * ERR_MODULE_NOT_FOUND（实测：Intel 包正常、M 芯片包报错）。
 *
 * 本脚本做两件事（都 best-effort，失败不阻断打包）：
 *   1. 本地物化：用当前系统 Node 跑 cnoke（与 dsh 子进程 Node 一致，避免 ABI 错配）
 *   2. 补齐平台包：从 npmmirror 下载缺失的 @koromix/koffi-<os>-<arch> tgz 解压到
 *      node_modules/@koromix/，保证任意架构的产物都带全量 koffi
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const koffiDir = path.join(__dirname, '..', 'node_modules', 'koffi');
const koromixDir = path.join(__dirname, '..', 'node_modules', '@koromix');

/** 需要补齐的平台包（覆盖全部打包目标） */
const WANTED_KOFFI_PLATFORMS = ['darwin-x64', 'darwin-arm64', 'win32-x64'];

/** 下载 URL 编码（npmmirror 对 scoped 包路径的转义） */
function tarballUrl(pkgName, version) {
  return `https://registry.npmmirror.com/@koromix/${pkgName}/-/${pkgName}-${version}.tgz`;
}

/** 简单下载到文件（https，跟随重定向，失败抛错） */
function download(url, destFile, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随 302 重定向（npmmirror -> CDN），最多 5 跳
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
  // tar 在 Windows 10+ / macOS / Linux 均可用
  execFileSync('tar', ['-xzf', tgzPath, '-C', tmpDir], { stdio: 'inherit' });
  const inner = path.join(tmpDir, 'package');
  if (!fs.existsSync(inner)) throw new Error('tgz 内缺少 package/ 目录');
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, entry), path.join(destDir, entry));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** 补齐缺失的 koffi 平台包（best-effort） */
async function ensureKoffiPlatformPackages() {
  if (!fs.existsSync(koromixDir)) fs.mkdirSync(koromixDir, { recursive: true });

  const koffiPkg = JSON.parse(fs.readFileSync(path.join(koffiDir, 'package.json'), 'utf8'));
  const version = koffiPkg.version;

  for (const platform of WANTED_KOFFI_PLATFORMS) {
    const pkgName = `koffi-${platform}`;
    const destDir = path.join(koromixDir, pkgName);
    if (fs.existsSync(path.join(destDir, 'package.json'))) {
      console.log(`[build-native] koffi 平台包已存在: @koromix/${pkgName}`);
      continue;
    }
    try {
      console.log(`[build-native] 下载缺失的 koffi 平台包: @koromix/${pkgName}@${version} ...`);
      const tgzPath = path.join(koromixDir, `${pkgName}.tgz`);
      await download(tarballUrl(pkgName, version), tgzPath);
      extractTgz(tgzPath, destDir);
      fs.rmSync(tgzPath, { force: true });
      console.log(`[build-native]   -> 已补齐 ${destDir}`);
    } catch (err) {
      // best-effort：失败仅告警，运行时 koffi 仍可能自行解决（如仅单架构使用）
      console.warn(`[build-native] koffi 平台包 ${pkgName} 补齐失败（忽略）: ${err.message}`);
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

  // 补齐平台包（双架构打包必需）
  await ensureKoffiPlatformPackages();
}

main().catch((err) => {
  console.warn(`[build-native] 异常（忽略）: ${err.message}`);
});
