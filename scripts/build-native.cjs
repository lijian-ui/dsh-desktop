/**
 * 物化 koffi 原生二进制（打包前置步骤，best-effort）
 * ------------------------------------------------------------
 * koffi 不在 npm 包内附带预编译二进制，而是在安装脚本 / 首次 require 时下载到临时目录。
 * 为避免打包后首次运行依赖联网下载，这里主动把预编译二进制物化到
 * node_modules/koffi/win32_x64/koffi.node，再由 electron-builder 的 asarUnpack 随包分发。
 *
 * 设计要点：
 *   - 使用当前 Node（process.execPath，即系统 Node）执行 koffi 自带的 cnoke 构建脚本，
 *     与 dsh 子进程使用的 Node 保持一致，避免 ABI 错配。
 *   - 该步骤失败「不阻断打包」：koffi 在运行时仍可自行下载，仅首次运行需联网。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const koffiDir = path.join(__dirname, '..', 'node_modules', 'koffi');

try {
  if (!fs.existsSync(koffiDir)) {
    console.warn('[build-native] 未找到 koffi 目录，跳过物化步骤');
    process.exit(0);
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
