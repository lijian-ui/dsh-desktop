# DeepSeek Harness 桌面端开发方案

> 最后更新：2026-08-13
> 状态：方案 A（spawn 官方 `dsh web` 子进程）已确认方向，待搭骨架

---

## 〇、核心约束（用户要求，最高优先级）

1. **本地源码只作参考**：`C:\Project\dsh-desktop\deepseek-harness\` 是官方开源代码的本地副本，**不作为依赖、不 import、不构建**。它仅用于我们理解 dsh 的架构与集成契约。
2. **消费官方 npm 包**：桌面端运行 dsh 走官方发布的包 `@deepseek-ai/dsh`（即 `npx @deepseek-ai/dsh web` 背后的包）。
3. **零改动官方代码**：不修改官方包、官方源码的任何内容。
4. **跟随官方更新**：用 npm 包意味着官方发版后我们 `npm update` 即获得更新，避免维护 fork / 搬运源码。

这四条直接决定了下面的方案选择——**不能 import 本地 dsh 源码，也不能 import 官方主包的运行时**（见第一节），所以方案 A 落地为"进程外 spawn 官方 CLI"。

---

## 一、调研结论（官方包形态，已核实）

| 项 | 结论 | 来源 |
|----|------|------|
| 官方包真实存在 | `@deepseek-ai/dsh@0.1.0-rc.6`，ESM，Developer Preview（破坏性变更频繁） | `npm view` |
| 主包**只暴露 CLI** | `bin: { dsh: 'lib/bin.js' }`，无可编程的运行时 API 导出 | `npm view` |
| boot 运行时可独立安装 | `@deepseek-ai/dsh-app-boot@0.1.0-rc.6` 独立发布，导出 `boot`/`loadProfile` 等底层 API | `npm view` |
| `dsh web` 参数 | `--host`（默认 `127.0.0.1`；`0.0.0.0` 被安全拒绝）、`--port`（传 `0` 让 OS 分配空闲端口）、`--trusted-host` | 源码 `packages/bundle/web-app/src/startup.ts` |
| **不自动打开浏览器** | `dsh web` 只 `console.log` 打印 URL，无任何调用系统浏览器的逻辑 | 源码分析 |
| 原生模块 | 依赖 `node-addon-require-builtin`（node-pty / koffi 等） | `npm view` 依赖列表 |

### 关键推论

- **不能"进程内 import Host"**：官方主包只给 CLI，没有可 import 的 `runProfile` 入口（`runProfile` 只在 `@deepseek-ai/dsh-app-boot` 之外、CLI 包内部，未发布到主包 exports）。
- **spawn 子进程 = 用系统 Node 跑 dsh**：子进程运行在用户机器标准 Node 上（满足 `node ^22.19.0 || >=24.0.0`），原生模块 ABI 完全由官方包 + 系统 Node 负责。**Electron 这边零原生模块负担，不需要 `electron-rebuild`。**

---

## 二、方案决策：方案 A = 进程外 spawn 官方 `dsh web`

### 架构

```
Electron 桌面壳（一个进程组）
├── 主进程（Electron）
│     ├── spawn 官方 dsh web 子进程（用系统 Node 运行 @deepseek-ai/dsh）
│     └── 管理生命周期（启动 → spawn；退出 → kill 子进程树）
├── BrowserWindow（渲染进程）
│     └── 加载 http://127.0.0.1:<port>，显示 dsh 原生 React UI（零改动）
└── dsh web 子进程（系统 Node）
      ├── HTTP server 127.0.0.1:<port>（--port 0 → OS 分配）
      ├── Agent 核心 / 会话 / LLM / 工具 / 终端
      └── 原生模块由系统 Node 承担，与 Electron 无关
```

通信：BrowserWindow ↔ dsh 子进程，全部走 loopback 的 HTTP + WebSocket（dsh 原生前端已封装好，无需我们处理）。

### 为什么是 spawn，而不是"进程内 import"

| 路径 | 可行性 | 代价 |
|------|--------|------|
| **A1 spawn CLI（采用）** | ✅ 官方主包只给 CLI，契约稳定 | 多一个子进程；需解析端口、管理生命周期 |
| A2 import `@deepseek-ai/dsh-app-boot` | ⚠️ 技术上可行 | 需把原生模块在 Electron 内置 Node 上 `electron-rebuild` 重编译；且该 API 是 dev-preview，破坏性变更频繁 |

A1 用系统 Node 跑官方包，**彻底绕开 Electron 内置 Node 的 ABI / 原生模块兼容问题**，且 CLI 子命令比内部 API 稳定，完全满足第〇节的四条约束。

### 核心集成代码（主进程示意，CommonJS）

```js
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const treeKill = require('tree-kill')

let mainWindow
let dshProcess

function startDsh() {
  // 官方包的可执行入口（npm 安装后位于 node_modules）
  const binPath = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  // 关键：用系统 Node（非 Electron 内置），保证原生模块 ABI 兼容
  const nodeBin = process.env.DSH_NODE_BIN || 'node'
  dshProcess = spawn(nodeBin, [binPath, 'web', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env }, // 可在此注入 DEEPSEEK_API_KEY 等
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // dsh web 启动后打印：dsh web: http://127.0.0.1:<port>
  dshProcess.stdout.on('data', (buf) => {
    const m = buf.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/)
    if (m && mainWindow && !mainWindow.webContents.getURL()) {
      mainWindow.loadURL(`http://127.0.0.1:${m[1]}`)
    }
  })
  dshProcess.stderr.on('data', (b) => process.stderr.write(b))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  // 先给一个加载页；端口解析到后由 stdout 监听加载真实 UI
  mainWindow.loadURL('http://127.0.0.1:3080').catch(() => {})
}

app.whenReady().then(() => { startDsh(); createWindow() })
app.on('quit', () => { if (dshProcess?.pid) treeKill(dshProcess.pid) })
```

> 实际骨架会处理端口解析时序（先等 stdout 拿到端口再 loadURL，避免竞态），此处为说明结构。

### 关键集成点（已确认）

- **端口**：spawn 传 `--port 0`，解析子进程 stdout 的 `dsh web: http://127.0.0.1:<port>` 拿实际端口，避免 3080 冲突。
- **host**：`--host 127.0.0.1`（默认即此，不暴露网络；`0.0.0.0` 被官方拒绝）。
- **API Key**：spawn 时通过环境变量注入（如 `DEEPSEEK_API_KEY`），或在 dsh 的 UI 内填写。
- **生命周期**：`app.on('quit')` 用 `tree-kill` 杀掉 dsh 整个子进程树（dsh 会拉自己的子进程）。
- **原生模块**：由 dsh 子进程的系统 Node 承担，Electron 无需处理。

---

## 三、与方案 B（IPC / file://）的关系

官方 `packages/host/webserver/src/index.ts` 第 8 行注释已预见终态：

> "Web shape only — Electron loads dist over file:// and carries fetch over an IPC bridge."

即官方最终设想是：Electron 用 `file://` 加载 dist，用 IPC 桥接 fetch / WebSocket，**完全不用 HTTP server**（方案 B 形态）。这与我们的方向一致——但对我们而言是**后续演进目标**，不是起点：

- 当前（方案 A）：spawn CLI + loopback HTTP，最快跑起来、零改动、零 ABI 风险。
- 未来（方案 B）：等官方发布正式的 **embed / SDK** API 后，再把传输层从 HTTP 换成 IPC，前端代码仍零改动（因为 `__DSH_BOOT__` 和 API 调用路径都是封装好的）。

**不要在官方 SDK 成熟前自造 IPC 桥接**——那等于重写方案 B，且要动原生模块重编译，违背"不改官方代码、跟随更新"的原则。

---

## 四、架构参考（来自本地源码分析，仅理解用，桌面端不依赖）

> 以下内容基于对 `deepseek-harness/` 本地副本的静态分析，**仅用于理解 dsh 的运行机制**，桌面端代码不 import 这些文件。

### 当前 web 运行模式

```
dsh web → boot("web" profile) → Cordis 插件树
  ├── dsh-base bundle: agent 核心 (session, LLM, tools, persistence, sandbox)
  └── dsh-web-app bundle: web 表面层
       ├── WebServer (node:http, 127.0.0.1:port)
       ├── FrontendStatic (服务 dist/ 静态文件)
       ├── API Gateway (JSON-RPC dispatch)
       ├── ClientConnection (/api 路由 + WebSocket events)
       └── ClientModules (扫描插件 → 组装 window.__DSH_BOOT__ → 注入 index.html)
```

### 关键通信链路（BrowserWindow ↔ dsh 子进程）

| 通道 | 用途 | 实现 |
|------|------|------|
| `GET /` + 静态文件 | 加载前端 HTML/JS/CSS | FrontendStatic 插件 |
| `window.__DSH_BOOT__` | 插件清单注入 | ClientModules tapIndex |
| `GET /plugins/<id>/client.js` | 浏览器端插件包加载 | ClientModules serveBundle |
| `POST /api/<method>` | JSON-RPC 请求/响应 | ClientConnection + API Gateway |
| `WS /mux-events` | 多路会话事件流 | ClientConnection WebSocket |
| `WS /host-events` | 主机级事件流 | ClientConnection WebSocket |

这些链路在方案 A 下**完全由 dsh 子进程自身提供**，我们无需实现，只需 BrowserWindow 连对地址。

---

## 五、推荐项目结构

```
dsh-desktop/                          # 桌面端项目根目录
├── deepseek-harness/                 # 官方源码副本（仅参考，不依赖、不构建）
├── electron-app/                     # ← 新建：Electron 桌面壳
│   ├── package.json                  # 依赖 electron + @deepseek-ai/dsh（官方包）
│   ├── src/
│   │   ├── main.js                   # 主进程：spawn dsh web + 端口解析 + 窗口
│   │   └── preload.js                # 预加载（方案 A 暂为空壳）
│   ├── resources/
│   │   └── icon.png
│   └── electron-builder.yml          # 打包配置（后续）
└── DEVELOPMENT.md                    # 本文件
```

> `electron-app` 与 `deepseek-harness` 平级，独立成项目；通过 npm 依赖官方包，而非 workspace 引用本地源码。

---

## 六、实施路线

### Phase 1：方案 A 最小闭环（搭骨架）
1. 在 `dsh-desktop/electron-app/` 创建 Electron 项目。
2. `package.json` 依赖 `electron` 与 `@deepseek-ai/dsh`（官方包）。
3. 主进程 spawn `dsh web --host 127.0.0.1 --port 0`，解析 stdout 端口。
4. BrowserWindow 加载 `http://127.0.0.1:<port>`，显示 dsh 原生 UI。
5. `app.on('quit')` 用 tree-kill 清理 dsh 子进程树。
6. 本地验证：装好系统 Node（≥22.19）与 `DEEPSEEK_API_KEY`，`npm install && npm start`。

### Phase 2：桌面体验增强
1. 加载态页面（端口解析前）。
2. 窗口图标、标题、最小化到托盘、全局快捷键唤起。
3. 应用菜单、关于面板、API Key 配置入口。
4. 自动更新（electron-updater，跟随官方 npm 版本）。
5. 打包（electron-builder）。

### Phase 3：方案 B（待官方 SDK 成熟）
1. 等官方发布 embed / SDK API。
2. 将传输层从 loopback HTTP 换成 IPC（file:// + IPC 桥接）。
3. 前端代码零改动。

---

## 七、关键注意事项

1. **系统 Node 版本**：dsh 要求 `node ^22.19.0 || >=24.0.0`。spawn 时用系统 Node（不是 Electron 内置），需确保用户机器装了合规版本。`process.env.DSH_NODE_BIN` 可覆盖。
2. **原生模块**：由 dsh 子进程的系统 Node 承担，**Electron 无需 `electron-rebuild`**——这是 spawn 方案的最大红利。
3. **端口冲突**：永远传 `--port 0` 让 OS 分配，不要硬编码 3080。
4. **API Key**：通过环境变量注入 spawn，或在 dsh UI 内填；桌面端可加配置入口写环境变量。
5. **生命周期**：务必在 quit 时 tree-kill dsh 子进程树，否则会残留进程占用端口。
6. **dev preview 风险**：`@deepseek-ai/dsh` 处于 Developer Preview，破坏性变更频繁。建议锁版本（如 `0.1.0-rc.6`），升级前看 changelog。
7. **不改动官方**：任何定制需求优先通过 dsh 的 patch / profile 机制（`--patch`、`$DSH_HOME/cordis.patch.yml`），而非改官方包。
