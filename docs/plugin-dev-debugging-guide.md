# dsh 插件与桌面端联调指南

> 本文档以 `im-gateway` 插件为参考，说明插件开发期间如何与 dsh-desktop 桌面壳进行本地联调，以及插件发版后桌面端如何引用。**开发新插件时可直接参照本指南。**

---

## 目录

1. [整体架构](#1-整体架构)
2. [本地联调流程](#2-本地联调流程)
3. [插件 package.json 关键字段](#3-插件-packagejson-关键字段)
4. [桌面壳侧的配置](#4-桌面壳侧的配置)
5. [构建配置 tsdown](#5-构建配置-tsdown)
6. [联调验证步骤](#6-联调验证步骤)
7. [发版与客户端引用](#7-发版与客户端引用)
8. [常见问题](#8-常见问题)

---

## 1. 整体架构

dsh-desktop 采用**方案 A：spawn 官方 dsh 子进程**。桌面壳（Electron 主进程）不直接 import dsh 运行时，而是通过子进程启动 `dsh web`，插件随 dsh 子进程加载：

```
┌──────────────────────────────────────────────────────────┐
│  Electron 主进程 (dsh-desktop)                            │
│                                                            │
│  1. ensureImGatewayProfile()                              │
│     → 在 ~/.dsh/profiles/web/ 部署 profile 模板           │
│     → 建立 junction: profile/node_modules/@scope/plugin   │
│       → 桌面壳 node_modules/@scope/plugin (插件实体)       │
│                                                            │
│  2. spawn dsh web --profile web --host 127.0.0.1 --port 0 │
│     → 系统 Node 运行 dsh 的 bin.js                        │
│     → NODE_PATH 包含桌面壳 node_modules (依赖解析兜底)     │
└──────────────────────┬───────────────────────────────────┘
                       │ spawn
                       ▼
┌──────────────────────────────────────────────────────────┐
│  dsh 子进程 (Node.js)                                      │
│                                                            │
│  1. 读取 ~/.dsh/profiles/web/package.json                 │
│  2. reconcilePlugins: 扫描 dependencies 中声明            │
│     dsh.bundle 的包 → 并入层栈                            │
│  3. 加载插件 Host 端: lib/index.js (ESM)                  │
│  4. 加载插件客户端: lib/client.js (CJS, 浏览器加载)        │
│  5. 启动 HTTP 服务，Electron 窗口加载该地址               │
└──────────────────────────────────────────────────────────┘
```

### 为什么用子进程而非 import

官方主包 `@deepseek-ai/dsh` 只暴露 CLI（`bin: dsh`），没有可 import 的运行时 API。子进程方式让：
- 原生模块（node-pty / koffi）的加载与 ABI 兼容由 dsh 自己承担
- Node 版本要求（`^22.19 || >=24`）由系统 Node 满足，而非 Electron 内置 Node
- 内部 API 的破坏性变更随 `npm update` 跟随，桌面端主进程零原生模块负担

---

## 2. 本地联调流程

### 2.1 目录结构

插件源码放在桌面壳仓库的 `extensions/` 目录下：

```
dsh-desktop/
├── extensions/
│   └── your-plugin/          ← 插件源码
│       ├── src/
│       │   ├── index.ts      ← Host 端入口
│       │   ├── client/
│       │   │   └── index.ts  ← 客户端入口
│       │   └── gateway/
│       ├── lib/              ← 构建产物（gitignore）
│       ├── tests/
│       ├── package.json
│       └── tsdown.config.ts
├── package.json              ← 桌面壳根 package.json
├── config.json               ← 桌面壳运行配置
└── src/main/
    ├── profile-init.ts       ← junction 部署逻辑
    ├── dsh-process.ts        ← dsh 子进程管理
    └── config.ts             ← 配置读取
```

### 2.2 声明桌面壳依赖

在桌面壳根 `package.json` 的 `dependencies` 中声明插件：

```json
{
  "dependencies": {
    "@your-scope/dsh-your-plugin": "^0.1.0"
  }
}
```

然后执行 `npm install`。npm 会在 `node_modules/@your-scope/dsh-your-plugin` 创建包。

### 2.3 建立 junction 链接

**开发期需要手动建立 junction**，让 `node_modules` 中的插件包指向 `extensions/` 下的源码目录，这样每次构建后改动立即生效：

```powershell
# Windows (PowerShell，管理员权限)
# 先删除 npm install 创建的普通目录/链接
Remove-Item -Recurse -Force "E:\Project\dsh-desktop\node_modules\@your-scope\dsh-your-plugin"
# 建立 junction（相当于符号链接，但不需要管理员权限）
New-Item -ItemType Junction -Path "E:\Project\dsh-desktop\node_modules\@your-scope\dsh-your-plugin" -Target "E:\Project\dsh-desktop\extensions\your-plugin"
```

```bash
# macOS / Linux
ln -sf ../../extensions/your-plugin node_modules/@your-scope/dsh-your-plugin
```

**验证 junction：**
```powershell
Get-Item "E:\Project\dsh-desktop\node_modules\@your-scope\dsh-your-plugin" | Select-Object FullName, LinkType, Target
```

应输出 `LinkType: Junction`，`Target` 指向 `extensions\your-plugin`。

### 2.4 构建插件

在插件目录下执行构建：

```bash
cd extensions/your-plugin
npx tsdown
```

构建产物：
- `lib/index.js` — Host 端 ESM bundle（dsh 子进程加载）
- `lib/index.d.ts` — TypeScript 类型声明
- `lib/client.js` — 客户端 CJS bundle（浏览器加载，wrapped in loader factory）

### 2.5 运行测试

```bash
npm test
```

测试用 `node:test` 内置测试运行器，`.test.mjs` 文件从 `../lib/index.js` 导入。

### 2.6 启动桌面壳

```powershell
# 方式一：npm start（如果 electron shim 正常工作）
npm start

# 方式二：直接运行 Electron 二进制（推荐，避免 shim 问题）
Start-Process "E:\Project\dsh-desktop\node_modules\electron\dist\electron.exe" -WorkingDirectory "E:\Project\dsh-desktop" -ArgumentList "."
```

Electron 主进程启动后会：
1. 调用 `ensureImGatewayProfile()` 在 `~/.dsh/profiles/web/` 部署 profile
2. 在 profile 的 `node_modules/` 下建立 junction 指向桌面壳 `node_modules/` 中的插件实体
3. spawn dsh 子进程，dsh 加载 profile 中声明的所有插件

### 2.7 修改后重新联调

修改插件源码后，重复以下步骤：

```bash
# 1. 重新构建
cd extensions/your-plugin
npx tsdown

# 2. 重启 Electron（关闭窗口后重新启动，或杀进程后重启）
Stop-Process -Name "Electron" -Force
Start-Process "E:\Project\dsh-desktop\node_modules\electron\dist\electron.exe" -WorkingDirectory "E:\Project\dsh-desktop" -ArgumentList "."
```

> **注意**：只需重启 Electron，不需要重新 `npm install`。junction 链接保证 `node_modules` 中的插件始终指向 `extensions/` 下的最新构建产物。

---

## 3. 插件 package.json 关键字段

```jsonc
{
  "name": "@your-scope/dsh-your-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",           // Host 端入口
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "default": "./lib/client.js"  // 客户端入口
    },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/**/*.js",
    "lib/**/*.d.ts",
    "cordis.patch.yml",
    "README.md"
  ],
  "scripts": {
    "build": "tsdown",
    "watch": "tsdown --watch",
    "test": "node --test tests/*.test.mjs",
    "prepare": "npm run build"      // npm publish 前自动构建
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"  // cordis 层栈 patch 文件
    },
    "client": {
      "inject": [                     // 客户端依赖的平台模块
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-gateway"
      ],
      "platform": "web",             // 客户端平台
      "immediately": true            // 立即加载（不等用户打开设置页）
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.6",
    "@deepseek-ai/dsh-settings": "*"
    // ... 对 dsh 核心包的依赖，版本由宿主决定
  },
  "dependencies": {
    // 插件自身需要的第三方依赖（如 ws、qrcode 等）
  }
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `main` | Host 端入口，dsh 子进程通过此路径加载插件 |
| `exports["./client"]` | 客户端入口，浏览器通过此路径加载 UI bundle |
| `dsh.bundle.patch` | cordis 层栈 patch 文件路径，声明插件对 dsh 配置的覆盖/注入 |
| `dsh.client.inject` | 客户端运行时依赖的平台模块列表 |
| `dsh.client.platform` | 客户端平台，固定 `"web"` |
| `dsh.client.immediately` | `true` 表示页面加载时立即注入客户端 bundle |
| `peerDependencies` | 对 dsh 核心包的依赖，版本范围由宿主环境决定 |
| `dependencies` | 插件自身需要的第三方依赖，随 `npm install` 进入桌面壳 `node_modules` |
| `files` | npm 发布时包含的文件（`lib/` 产物 + 文档 + patch 文件） |
| `prepare` | `npm publish` 前自动执行 `npm run build`，确保发布的包含最新产物 |

---

## 4. 桌面壳侧的配置

### 4.1 根 package.json

在桌面壳根 `package.json` 的 `dependencies` 中声明插件：

```json
{
  "dependencies": {
    "@your-scope/dsh-your-plugin": "^0.1.0"
  }
}
```

### 4.2 profile-init.ts

在 `src/main/profile-init.ts` 中注册插件 bundle 名称：

```typescript
/** 全部自研插件（逐个建立 profile junction + 层栈声明） */
export const PLUGIN_BUNDLES: string[] = [
  '@lijian-ui/dsh-im-gateway',
  '@lijian-ui/dsh-session-cleaner',
  '@lijian-ui/dsh-file-manager',
  '@lijian-ui/dsh-term',
  '@your-scope/dsh-your-plugin',  // ← 添加你的插件
]
```

`ensureImGatewayProfile()` 会在 dsh 启动前自动：
1. 在 `~/.dsh/profiles/web/` 创建 profile 模板（如果不存在）
2. 把插件补齐到 profile 的 `package.json`（dependencies + bundles 数组）
3. 建立 junction: `profile/node_modules/@your-scope/dsh-your-plugin` → 桌面壳 `node_modules/@your-scope/dsh-your-plugin`

### 4.3 config.json

桌面壳运行配置（项目根目录，已在 `.gitignore` 中忽略）：

```json
{
  "profile": "web",
  "port": 0,
  "apiKey": "sk-..."
}
```

| 字段 | 说明 |
|---|---|
| `profile` | dsh profile 名称，默认 `"web"`，对应 `~/.dsh/profiles/web/` |
| `port` | dsh 监听端口，`0` 表示由系统分配空闲端口 |
| `apiKey` | DeepSeek API Key，通过环境变量注入子进程 |
| `nodePath` | 系统 Node.js 路径（macOS GUI 启动时 PATH 不完整，需显式指定） |

---

## 5. 构建配置 tsdown

插件需要构建两个 bundle：Host 端（ESM）和客户端（CJS）。

```typescript
// tsdown.config.ts
import { defineConfig } from 'tsdown'

// 客户端 external：浏览器平台种子模块，运行时通过 loader 的模块表解析
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  // ... 其他平台模块
]

// Host 端：ESM library + .d.ts
const hostConfig = {
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: true,
}

// 客户端：CJS bundle，wrapped in loader factory handoff format
const clientConfig = {
  name: '@your-scope/dsh-your-plugin/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,  // 不能 clean，否则会擦掉 Host 端产物
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "@your-scope/dsh-your-plugin", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostConfig, clientConfig])
```

### 关键点

- **Host 端**用 ESM 格式，dsh 子进程通过 `import` 加载
- **客户端**用 CJS 格式，wrapped in `window.__ModuleLoader__.load({ id, factory })` 工厂格式，浏览器通过 loader 加载
- 客户端的 `clean` 必须为 `false`，否则会擦掉 Host 端的产物
- 客户端的 `external` 列出平台模块（react、cordis 等），这些模块运行时由 loader 提供，不打包进 bundle
- `noExternal` 确保非平台模块全部 inline 打包

---

## 6. 联调验证步骤

### 6.1 构建与测试

```bash
cd extensions/your-plugin
npx tsdown          # 构建无错误
npm test            # 全部测试通过
```

### 6.2 启动验证

```powershell
# 启动 Electron
Start-Process "E:\Project\dsh-desktop\node_modules\electron\dist\electron.exe" -WorkingDirectory "E:\Project\dsh-desktop" -ArgumentList "."

# 等待 5 秒后检查进程
Start-Sleep -Seconds 5
Get-Process -Name "Electron" -ErrorAction SilentlyContinue | Select-Object Id, StartTime
```

应看到 4 个 Electron 进程（main + renderer + GPU + utility）。

### 6.3 日志验证

dsh 子进程的 stdout/stderr 会透传到 Electron 主进程的控制台输出，格式为 `[dsh] ...`。检查：

- 无 `插件 profile 部署失败` 警告
- 无 `MODULE_NOT_FOUND` 错误
- 插件加载日志（如 `[im-gateway] active` 或自定义的启动日志）

### 6.4 UI 验证

- 打开 dsh 界面，确认插件的设置页面出现在左侧导航
- 点击进入设置页面，确认 UI 正常渲染
- 测试增删改查等交互功能
- 检查 Host 端功能（如 IM 消息收发、命令响应等）

### 6.5 热重载（可选）

使用 `tsdown --watch` 可以在文件修改时自动重新构建：

```bash
cd extensions/your-plugin
npx tsdown --watch
```

但构建后仍需重启 Electron 才能加载新产物（dsh 子进程不会热重载插件）。

---

## 7. 发版与客户端引用

### 7.1 发版流程

```bash
cd extensions/your-plugin

# 1. 确保构建和测试通过
npx tsdown
npm test

# 2. 更新版本号（package.json 的 version 字段）
npm version patch   # 0.1.0 → 0.1.1
# 或 npm version minor  # 0.1.0 → 0.2.0
# 或 npm version major  # 0.1.0 → 1.0.0

# 3. 发布到 npm registry
npm publish
```

> `prepare` 脚本会在 `npm publish` 前自动执行 `npm run build`，确保发布的包包含最新构建产物。

### 7.2 发版后的引用方式

#### 方式一：随桌面壳打包分发（内置插件）

这是自研插件的主要分发方式。插件随桌面壳安装包一起分发，用户无需手动安装。

**流程：**

```
npm publish (@your-scope/dsh-your-plugin@0.1.1)
    ↓
桌面壳 package.json 声明 "@your-scope/dsh-your-plugin": "^0.1.1"
    ↓
npm install (从 registry 拉取到 node_modules/)
    ↓
electron-builder 打包 (node_modules 全量解包到 app.asar.unpacked/)
    ↓
用户安装桌面壳 → 首次启动时 profile-init.ts 自动建立 junction → dsh 加载插件
```

**用户视角：** 下载安装包即用，无需任何额外操作。

**关键代码路径：**

| 步骤 | 代码位置 | 说明 |
|---|---|---|
| npm install 拉取 | 桌面壳根 `package.json` dependencies | 从 registry 拉取指定版本 |
| 打包解包 | `electron-builder` 配置 `asarUnpack` | `node_modules` 全量解包到 `app.asar.unpacked/` |
| 运行时定位 | `profile-init.ts:resolveBundledNodeModules()` | 打包期返回 `app.asar.unpacked/node_modules` |
| junction 部署 | `profile-init.ts:ensurePluginLink()` | `profile/node_modules/@scope/plugin` → 实体 |
| dsh 加载 | dsh 的 `reconcilePlugins` | 扫描 profile package.json 中声明 `dsh.bundle` 的依赖 |

#### 方式二：用户手动安装（第三方插件）

第三方插件可以通过 dsh 的插件管理界面安装，dsh 会将其放入 profile 的 `node_modules/` 并加入层栈。此方式不需要修改桌面壳代码。

### 7.3 版本管理

| 场景 | 操作 |
|---|---|
| 插件 bug 修复 | `npm version patch` + `npm publish`，桌面壳 `npm update` |
| 插件新增功能 | `npm version minor` + `npm publish`，桌面壳更新版本范围 |
| 破坏性变更 | `npm version major` + `npm publish`，桌面壳显式升级 |
| 桌面壳集成新版本 | 修改根 `package.json` 版本号 → `npm install` → 测试 → 打包 |

### 7.4 打包配置

桌面壳的 `electron-builder` 配置需要确保 `node_modules` 被 asarUnpack：

```jsonc
// electron-builder 配置（通常在 package.json 的 build 字段或 electron-builder.yml）
{
  "build": {
    "asarUnpack": [
      "node_modules/**/*"        // 全量解包，保证原生模块和插件可用
    ]
  }
}
```

---

## 8. 常见问题

### 8.1 插件修改后不生效

**原因**：忘记重新构建或重启 Electron。

**解决**：
```bash
cd extensions/your-plugin && npx tsdown   # 重新构建
# 然后重启 Electron
```

### 8.2 dsh 启动报 MODULE_NOT_FOUND

**原因**：junction 链接未建立或指向错误。

**排查**：
```powershell
# 检查 junction
Get-Item "E:\Project\dsh-desktop\node_modules\@your-scope\dsh-your-plugin" | Select-Object FullName, LinkType, Target

# 检查 profile 中的 junction
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@your-scope\dsh-your-plugin" -ErrorAction SilentlyContinue | Select-Object FullName, LinkType, Target
```

**解决**：重新建立 junction（见 [2.3 建立 junction 链接](#23-建立-junction-链接)）。

### 8.3 客户端 UI 不显示

**原因**：`dsh.client` 配置缺失或 `inject` 数组不完整。

**排查**：
- 确认 `package.json` 中有 `dsh.client` 字段
- 确认 `exports["./client"]` 指向 `./lib/client.js`
- 确认 `lib/client.js` 文件存在
- 确认 `inject` 数组包含所有依赖的平台服务（如 `'slots'`、`'locale'`）

### 8.4 npm start 启动失败

**现象**：`TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`

**原因**：`npm start` 的 `electron .` 命令可能未正确解析本地 Electron 二进制。

**解决**：直接运行 Electron 二进制：
```powershell
Start-Process "E:\Project\dsh-desktop\node_modules\electron\dist\electron.exe" -WorkingDirectory "E:\Project\dsh-desktop" -ArgumentList "."
```

### 8.5 插件依赖找不到

**原因**：插件的第三方依赖（如 `ws`、`qrcode`）未安装到桌面壳 `node_modules`。

**解决**：确保插件的 `dependencies` 在桌面壳根 `package.json` 中也能解析到。由于 junction 的物理目标在桌面壳 `node_modules`，Node 的模块解析会从物理路径向上查找，自动命中桌面壳 `node_modules` 中的依赖。

### 8.6 打包后插件不工作

**原因**：`electron-builder` 未将 `node_modules` asarUnpack。

**解决**：确认 electron-builder 配置中 `asarUnpack` 包含 `node_modules/**/*`。

---

## 附录：参考文件

| 文件 | 说明 |
|---|---|
| `src/main/profile-init.ts` | junction 部署逻辑，`ensureImGatewayProfile()` |
| `src/main/dsh-process.ts` | dsh 子进程管理，`DshManager` 类 |
| `src/main/config.ts` | 配置读取，`DshConfig` 接口 |
| `config.json` | 桌面壳运行配置 |
| `package.json` (根) | 桌面壳依赖声明 |
| `extensions/im-gateway/package.json` | 插件 package.json 参考 |
| `extensions/im-gateway/tsdown.config.ts` | 构建配置参考 |