# v0.2.0 方案：内置 Node.js 运行时（Bundled Node Runtime）

> 状态：**设计稿**（尚未实施）
> 目标版本：v0.2.0
> 关联问题：M4 用户 nvm 环境启动失败、打包版依赖系统 Node 的环境脆弱性

---

## 1. 背景与问题

### 1.1 现状

桌面端采用方案 A：Electron 主进程 spawn 官方 `dsh web` 子进程，子进程运行在**系统 Node** 上。
要求 Node 版本 `^22.19.0 || >=24.0.0`（dsh 官方硬性要求，见 `DEVELOPMENT.md` 调研结论）。

当前获取系统 Node 的逻辑（`src/main/dsh-process.ts` 的 `resolveSystemNode()`）：

```ts
// 优先级：config.nodePath → 常见安装路径 → nvm 扫描 → null
const candidates = [
  '/opt/homebrew/bin/node',  // Homebrew Apple Silicon
  '/usr/local/bin/node',     // Homebrew Intel / 官方安装包
  '/usr/bin/node',
  // + macOS nvm: ~/.nvm/versions/node/v*/bin/node（v0.1.1 已加）
];
```

### 1.2 问题

| 场景 | 现象 |
|------|------|
| 用户未装 Node | spawn 失败，报「请确认系统 Node 版本」 |
| nvm 用户（如 jiapeng 的 M4 Mac） | 路径探测复杂，即使 v0.1.1 加了 nvm 扫描仍可能漏（fnm/volta/asdf 等管理器） |
| GUI 启动 PATH 不完整 | macOS 双击 .app 时 `PATH` 不含用户 shell 配置，`npx`/`node` 找不到 |
| 版本不满足 | 用户装了 Node 但版本 <22.19，dsh 直接拒绝启动 |

**根本矛盾**：桌面端应「开箱即用」，却把运行环境强依赖绑定在用户的机器配置上。

### 1.3 目标

- **打包产物内置 Node 运行时**，子进程优先使用内置 Node，无需用户预装
- 支持三平台：Windows x64 / macOS x64 / macOS arm64
- 尽量控制体积增量（目标：+40~60MB/平台，而非 +100MB）
- 保留回退链：内置 Node 不可用时仍可走 `config.nodePath` / 系统探测

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│  .app / .exe 安装包                                        │
│  ├─ Contents/Resources/app.asar        （我们代码 + dsh 依赖）│
│  ├─ Contents/Resources/app.asar.unpacked（dsh 原生模块解包）  │
│  └─ Contents/Resources/node-runtime/   ★ 新增：内置 Node    │
│        ├─ bin/node        （macOS/Linux）                   │
│        │  └─ ...          （node 运行时必需文件）             │
│        └─ node.exe        （Windows）                       │
└────────────────────────────────────────────────────────────┘
```

启动链路（改动后）：

```
Electron 主进程
  └─ resolveSystemNode() 返回：
       ① process.resourcesPath/node-runtime/...（内置，优先）
       ② config.nodePath                        （用户显式指定）
       ③ 系统探测（Homebrew / nvm / 官方路径）     （回退）
  └─ spawn(内置 node, dsh/lib/bin.js, 'web', ...)
```

---

## 3. 实施步骤

### 3.1 目录结构（新增）

```
electron-app/
├── node/                         # ★ 已有（不入 git）：官方 Node 发行包，见 3.1.1
│   ├── node-v24.19.0-win-x64/          # Windows x64（解压版）
│   ├── node-v24.19.0-darwin-x64/       # macOS Intel（解压版）
│   └── node-v24.19.0-darwin-arm64/     # macOS Apple Silicon（解压版）
├── vendor/                        # ★ 新增：精简后的 Node 运行时（不入 git，见 3.4）
│   └── node/
│       ├── win-x64/
│       │   └── node.exe           # 精简后的 Windows Node
│       ├── darwin-x64/
│       │   ├── bin/node
│       │   └── lib/...
│       └── darwin-arm64/
│           ├── bin/node
│           └── lib/...
├── scripts/
│   ├── build-native.cjs           # 已有：koffi 物化
│   ├── fetch-node.cjs             # ★ 新增：精简拷贝 Node 运行时（本地已有发行包，仅在线兜底）
│   └── ...
├── electron-builder.yml           # 改：extraResources 打包 node-runtime
└── src/main/dsh-process.ts        # 改：resolveSystemNode 优先内置 Node
```

#### 3.1.1 现成二进制（重要）

`electron-app/node/` 目录下**已存在**解压好的三份官方 Node **v24.19.0** 发行包
（版本已统一，实测 `node.exe --version` = v24.19.0），满足 dsh 要求 `>=24`：

| 目录 | 平台 | node 可执行文件 | 版本 |
|------|------|------------------|------|
| `node-v24.19.0-win-x64/` | Windows x64 | `node.exe`（89M） | v24.19.0 |
| `node-v24.19.0-darwin-x64/` | macOS Intel | `bin/node`（118M） | v24.19.0 |
| `node-v24.19.0-darwin-arm64/` | macOS Apple Silicon | `bin/node`（116M） | v24.19.0 |

> 三份均为 v24.19.0（已从 24.18.1 统一升级），ABI = NODE_MODULE_VERSION 137。
> 目录含大量构建用不上的文件（include/share/node_modules 等，~190MB/份），
> 由 `fetch-node.cjs` 精简后拷入 `vendor/`。这些目录**不入 git**（大二进制）。

### 3.2 `scripts/fetch-node.cjs`（新增）

职责：按目标平台从镜像站下载官方 Node 二进制，解压后**精简**到 `vendor/node/<platform>-<arch>/`。

```js
/**
 * 下载并精简 Node.js 运行时（打包前置步骤）
 * ------------------------------------------------------------
 * 目的：为桌面端捆绑一个精简版 Node，让子进程不依赖用户系统 Node。
 *
 * 平台产物（Node 官方 dist）：
 *   win-x64       node-v24.x.x-win-x64.zip
 *   darwin-x64    node-v24.x.x-darwin-x64.tar.gz
 *   darwin-arm64  node-v24.x.x-darwin-arm64.tar.gz
 *
 * 下载源：npmmirror（国内快）https://registry.npmmirror.com/-/binary/node/
 * 精简：只保留运行 dsh 必需的文件（bin/node + lib），删除 npm/npx/include/share 等
 */

const NODE_MAJOR = '24'; // 跟随 dsh 要求 ^22.19 || >=24，取当前 LTS 大版本

// 目标平台矩阵：electron-builder 的 --mac --x64 --arm64 与 --win
const TARGETS = process.argv.includes('--win')
  ? ['win-x64']
  : process.argv.includes('--mac')
    ? ['darwin-x64', 'darwin-arm64']
    : []; // 未指定时按本机平台

async function fetchNode(target) {
  // 1. 查询 dist/index.json 拿到最新 v24 LTS 版本号（或直接写死已知版本）
  // 2. 下载 zip/tar.gz
  // 3. 解压到临时目录
  // 4. 精简：
  //    macOS:  保留 bin/node、lib/（node_modules 除外）、LICENSE
  //    Windows: 保留 node.exe（+ 必需的 dll）
  // 5. 拷入 vendor/node/<target>/
  // 6. 清理临时文件
}
```

**精简清单**（macOS 示例，Windows 类似）：

```
保留：
  bin/node                      # 主可执行文件
  lib/node_modules/...          # 内建模块（按需，见 3.3）
  LICENSE / README.md（可选）
删除：
  bin/npm  bin/npx               # dsh 不依赖 npm 命令
  lib/node_modules/npm/          # npm 自带几百个包，体积大头
  include/  share/               # 头文件与文档
  CHANGELOG.md 等
```

### 3.3 内建模块取舍（关键决策）

dsh 是 ESM 包，运行时通过 `import` 加载内建模块（`node:fs` 等）。**Node 的 `bin/node` 自带全部内建模块**（编译进二进制），`lib/node_modules/` 里只有 `npm`/`corepack` 这类 CLI 包。

→ **结论：精简后 `lib/node_modules/` 可整体删除**，`bin/node` 已含全部内建能力。这一步能把 macOS 体积从 ~90MB 压到 ~55-60MB。

> 验证方式：精简后执行 `内置node -e "require('node:fs'); console.log('ok')"` 确认核心模块可用。
> 注意：dsh 依赖的是第三方包（@deepseek-ai/*），它们来自 `app.asar.unpacked/node_modules`，与内置 Node 无关。

### 3.4 `electron-builder.yml`（改动）

```yaml
extraResources:
  # 内置 Node 运行时：按目标平台拷贝对应 vendor 目录
  - from: vendor/node/${os}-${arch}
    to: node-runtime
    filter:
      - "**/*"
```

> `${os}` 宏：win / mac / linux；`${arch}` 宏：x64 / arm64。
> 这样 Windows 打包只带 `vendor/node/win-x64`，mac arm64 只带 `darwin-arm64`，天然分平台，不重复。

**vendor 是否入 git？** 建议**不入**（`vendor/`、`node/` 加入 `.gitignore`）：
- Node 二进制 ~60MB/平台 × 3 = ~180MB，仓库膨胀
- 由 `fetch-node.cjs` 构建时按需生成（优先复用本地 `node/` 发行包），可复现
- 参考 `dist-electron/` 的处理方式

### 3.5 `src/main/dsh-process.ts`（改动）

`resolveSystemNode()` 增加「内置 Node」最优先分支：

```ts
function resolveSystemNode(config: DshConfig): string | null {
  // 0. ★ 内置 Node 运行时（打包版优先，v0.2.0 新增）
  //    electron-builder extraResources 拷到 resources/node-runtime/
  const bundledRoot = path.join(process.resourcesPath, 'node-runtime');
  const bundledNode = process.platform === 'win32'
    ? path.join(bundledRoot, 'node.exe')
    : path.join(bundledRoot, 'bin', 'node');
  if (app.isPackaged && fs.existsSync(bundledNode)) {
    log.info(`使用内置 Node 运行时: ${bundledNode}`);
    return bundledNode;
  }

  // 1. 用户显式配置（最可靠，README 会引导填写）
  if (config.nodePath && fs.existsSync(config.nodePath)) {
    return config.nodePath;
  }

  // 2. 常见安装路径探测 ...（保持不变）
  // 3. nvm 扫描 ...（保持不变）
}
```

> 开发模式（`app.isPackaged === false`）仍走原有探测，行为不变。

### 3.6 `package.json` scripts（改动）

```json
{
  "scripts": {
    "build:electron": "npm run build:native && node scripts/fetch-node.cjs && npm run build && electron-builder",
    "build:electron:win": "npm run build:native && node scripts/fetch-node.cjs --win && npm run build && electron-builder --win",
    "build:electron:mac": "npm run build:native && node scripts/fetch-node.cjs --mac && npm run build && electron-builder --mac --x64 --arm64"
  }
}
```

---

## 4. 体积分析

| 包 | 当前（v0.1.x） | 内置精简 Node 后（估算） |
|----|----------------|--------------------------|
| Windows .exe | ~118MB | ~175-185MB（+55~65MB） |
| macOS .dmg（arm64） | ~146MB | ~200-210MB（+55~65MB） |
| macOS .dmg（x64） | ~148MB | ~200-210MB |

> 精简后实测为准；若超预期，可进一步：只保留 `bin/node`（去掉 lib 目录），但需回归验证。

---

## 5. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| **原生模块 ABI 不匹配**：node-pty/koffi 的预编译二进制必须匹配捆绑 Node 的 NODE_MODULE_VERSION | 高 | ① 实施前先验证：`node_modules/node-pty/prebuilds/` 与 koffi 是否有 darwin-arm64/win-x64 的对应 NODE_MODULE_VERSION（v24 = 137）；② 用**系统 Node 同版本**先跑通，再切内置 |
| dsh 对 Node 版本的具体行为差异 | 中 | 捆绑 v24 LTS，与 dsh 要求的 `>=24` 一致；在 Win + Mac 双端实测 |
| 精简后内建模块缺失 | 中 | 精简后跑 `内置node` 的模块自检脚本，覆盖 `node:fs/path/child_process/url` 等 |
| 包体积翻倍影响下载 | 中 | 配合 v0.2.0 的 electron-updater 增量更新；首次安装才全量 |
| macOS 未签名 + 内置 Node 的 Gatekeeper 限制 | 中 | 内置 node 二进制随 app 一起被 ad-hoc 签名（electron-builder 默认处理）；必要时在安装指南补充说明 |

---

## 6. 验证清单

- [ ] `fetch-node.cjs` 三平台产物都能下载、精简、落盘
- [ ] Windows：`npm run build:electron:win` → 安装后**卸载系统 Node** 仍能启动 dsh
- [ ] macOS x64：同上去除/隐藏系统 Node 后能启动
- [ ] macOS arm64：交给 M4 用户（jiapeng）实测
- [ ] 内置 node 版本确认：`process.resourcesPath/node-runtime/bin/node -v` == v24.x
- [ ] 错误信息仍可用：若内置 Node 缺失，错误对话框展示 stderr + 提示 nodePath 配置
- [ ] 回归：`npm run dev` 开发模式行为不变（走系统 Node）

---

## 7. 实施顺序建议

1. 先做**验证**（5.1 原生模块 ABI）——不通过则暂停，重新评估捆绑版本
2. 写 `fetch-node.cjs`，本机（win-x64）跑通下载+精简
3. 改 `electron-builder.yml` extraResources + `dsh-process.ts` resolveSystemNode
4. Windows 全链路验证（卸载系统 Node 场景）
5. macOS x64 验证 → arm64 交给 M4 用户
6. 同步 electron-updater（自动更新）到同一版本

---

## 8. 关联改动（同版本可一并做）

- **electron-updater 自动更新**：`electron-builder.yml` `publish` 配 GitHub provider，主进程加 `autoUpdater.checkForUpdatesAndNotify()`；产物需含 `latest.yml` / `latest-mac.yml`
- 发版脚本 `publish-lib.mjs` 已支持子目录扫描（v0.1.1 已改），mac 产物在 `mac/` 子目录可直接上传

---

*本文档为 v0.2.0 设计稿，实施过程中如有变更，同步更新此处。*
