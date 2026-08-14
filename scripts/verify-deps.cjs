/**
 * 依赖完整性守护（打包前置步骤，v0.2.0）
 * ------------------------------------------------------------
 * 背景：electron-builder 的依赖收集器只收集 dependencies + optionalDependencies，
 * peerDependencies 被源码级剔除（实测：dsh 依赖树的 peer 依赖未显式声明时，
 * 打包产物缺 @deepseek-ai/cordis-plugin-group 等，目标机器启动即 ERR_MODULE_NOT_FOUND）。
 *
 * 职责：扫描 node_modules 全部包的 peerDependencies，凡是不在 package.json
 * dependencies 里的，自动补写进去（幂等：已声明的不动）。npm 7+ 本就会把
 * peer 依赖装进 node_modules，因此无需重新 npm install，electron-builder
 * 即可按更新后的 dependencies 收集进包。
 *
 * 设计取舍：
 * - 自动写入而非仅警告：升级 dsh 后新增 peer 依赖时，跑一次 build 即自愈，
 *   避免「依赖缺失 → 用户机器报错」的滞后期。写入是纯增量、可 diff、可回滚。
 * - 不阻断构建：即使写入失败也放行（best-effort），后续 build 步骤兜底。
 * - 写入后提示 npm install + 提交：保持 package-lock.json 与 package.json 一致。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const nodeModulesDir = path.join(ROOT, 'node_modules');
const pkgJsonPath = path.join(ROOT, 'package.json');

/** 扫描 node_modules 下所有包的 peerDependencies */
function collectPeerDeps() {
  const peers = new Map(); // name -> version（取第一个遇到的版本范围）
  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      if (entry.startsWith('@')) {
        scanDir(full); // scoped 包再下一层
        continue;
      }
      const pj = path.join(full, 'package.json');
      if (!fs.existsSync(pj)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (pkg.peerDependencies) {
          for (const [k, v] of Object.entries(pkg.peerDependencies)) {
            if (!peers.has(k)) peers.set(k, v);
          }
        }
      } catch {
        // 忽略损坏的 package.json
      }
    }
  };
  scanDir(nodeModulesDir);
  return peers;
}

function main() {
  if (!fs.existsSync(pkgJsonPath)) {
    console.warn('[verify-deps] 未找到 package.json，跳过');
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  const peers = collectPeerDeps();
  const missing = [];
  for (const [name, version] of peers) {
    if (declared.has(name)) continue;
    // 只声明 node_modules 里实际存在的（避免把纯类型/可选 peer 也拉进来）
    const base = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name;
    if (fs.existsSync(path.join(nodeModulesDir, base))) {
      missing.push({ name, version });
    }
  }

  if (missing.length === 0) {
    console.log('[verify-deps] peer 依赖声明完整，无需补充');
    process.exit(0);
  }

  // 自动补写进 dependencies（幂等）
  pkg.dependencies = pkg.dependencies || {};
  for (const { name, version } of missing) {
    pkg.dependencies[name] = pkg.dependencies[name] || version;
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');

  console.warn(
    `[verify-deps] ⚠️ 发现 ${missing.length} 个未声明的 peer 依赖，已自动写入 package.json:\n` +
    missing.map((m) => `   - ${m.name}@${m.version}`).join('\n') +
    '\n  📌 请运行 npm install 更新 package-lock.json，并把 package.json 变更提交到 git',
  );
  // 不阻断构建：dependencies 已更新，electron-builder 本轮即可收集到
  process.exit(0);
}

main();
