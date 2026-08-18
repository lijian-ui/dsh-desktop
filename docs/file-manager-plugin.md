# 文件管理插件（dsh-file-manager）开发文档

> 目标：在 dsh-web（DeepSeek Harness 桌面端）里做一个文件管理插件，提供
> ① 右侧「文件管理」面板（编辑 + 预览）；② 以「会话 cwd」为根的懒加载目录树
> （点击打开、右键复制路径）；③ 文件内容选中后引用进输入框；④ 输入框 `@` 引用
> 文件/文件夹（同样是懒加载树，根 = 会话 cwd）。
>
> 本文档所有代码路径、插槽名、服务契约均来自两个已存在参考项目的真实实现：
> - `参考项目/dsh-web-ui/packages/dsh-aionui-panel` —— 完整的「右侧文件管理面板 + 预览/编辑」实现
> - `参考项目/DSH-better-sidebar` —— 侧边栏文件树 + `@` 引用 + 写入输入框草稿
> - `参考项目/deepseek-harness/packages/client/ui-input-trigger` —— 输入框 `@` 触发扩展点

---

## 0. 需求 → 实现映射

| 需求 | 关键能力 | 主参考 | 复用程度 |
|---|---|---|---|
| 1. 按钮 → 右侧面板（编辑+预览） | 把两列 DOM 挂到 harness 的 `[data-dsh-frame]` 网格右侧；React root 渲染 Explorer + Preview | dsh-aionui-panel `layout.ts` + `mount.tsx` + `PreviewPanel` | **整体搬运** |
| 2. 懒加载目录树（根=cwd），点击打开，右键复制路径 | store 的 `ensureDir` 按需拉目录；TreeRow 整行展开；context menu 走 `navigator.clipboard.writeText` | dsh-aionui-panel `store.ts` + `ExplorerPanel.tsx` | **整体搬运** |
| 3. 文件内容选中 → 引用到输入框 | 选区拖入 composer（`FILE_DRAG_MIME`）或 `@` 按钮调 `appendToDraft` | DSH-better-sidebar `conversation-draft.ts` + `ExplorerView.tsx` | **整体搬运** |
| 4. 输入框 `@` 引用文件/文件夹（懒加载树） | 注册 `ctx.inputTriggers` 的 `@` 来源，`candidates()` 懒加载目录树，选中后用 `ReferenceInsert`/`text` 落到草稿 | harness `ui-input-trigger` + better-sidebar `ExplorerView` 思路 | **新写注册 + 复用树加载** |

> ⚠️ **一个必须提前知道的事实**：dsh-aionui-panel 的右侧面板**不是 harness 官方插槽**，
> 而是直接操作 `[data-dsh-frame]` 的 `grid-template-columns`（追加 2 条 grid track，
> 把面板列 `appendChild` 到 frame 上）。这与我们"不改官方代码"的原则**不冲突**
> （它只改自己注入的 DOM，没碰 ui-sidebar 源码），但意味着它依赖 harness 渲染出的
> `[data-dsh-frame]` 元素存在。方案 A 直接复用这个 DOM 注入；方案 B 走
> `DSH-better-sidebar` 的 `registerTab`（纯插件、零官方改动）把文件树放进侧边栏 tab。

---

## 1. 两个参考项目的可复用资产（文件清单）

### 1.1 `dsh-aionui-panel`（首选：右侧面板形态，最贴合需求 1/2）

| 文件 | 作用 | 本插件是否复用 |
|---|---|---|
| `packages/dsh-aionui-panel/src/index.ts` | **host 半**：workspace gate + `FsService` + `GitService` + `/aionui-panel/*` 路由 + `mountOnce` | ✅ 改路径即可复用 |
| `packages/dsh-aionui-panel/src/host/fs-service.ts` | 受控文件系统：`list`/`read`/`write`/`search`/`delete`/`watch`，**含路径穿越防护**（resolveInsideRoot 校验不能逃出 root） | ✅ 一字不改复用 |
| `packages/dsh-aionui-panel/src/host/gate.ts` | workspace gate：`createWorkspaceGate(ctx)` 解析会话 cwd 并 canonical 化 | ✅ 复用 |
| `packages/dsh-aionui-panel/src/host/routes.ts` | 把 `FsService` 挂成 `POST /aionui-panel/list` 等 JSON 路由 + SSE `events` 流 | ✅ 复用（改前缀避免冲突） |
| `packages/dsh-aionui-panel/src/client/layout.ts` | **右侧面板布局控制器**：找到 `[data-dsh-frame]`，追加 preview/explorer 两列 + 拖拽把手 + 浮动展开按钮 | ✅ 核心复用 |
| `packages/dsh-aionui-panel/src/client/mount.tsx` | 把 `ExplorerPanel`/`PreviewPanel` 渲染进 `[data-aionui-explorer-col]`/`[data-aionui-preview-col]`（MutationObserver 等待壳挂载） | ✅ 复用 |
| `packages/dsh-aionui-panel/src/client/ExplorerPanel.tsx` | **懒加载树 + 右键菜单（复制路径/复制名称/在文件管理器打开/重命名/新建/删除）** | ✅ 核心复用 |
| `packages/dsh-aionui-panel/src/client/store.ts` | 4 个 store（layout/explorer/scm/preview），`useSyncExternalStore` 外部状态；`ensureDir` 按需拉目录；`runFsRefresh` 合并 fs 事件 | ✅ 核心复用 |
| `packages/dsh-aionui-panel/src/client/api.ts` | `PanelApi`：`fetch /aionui-panel/*` + `subscribePanelEvents`（SSE） | ✅ 复用 |
| `packages/dsh-aionui-panel/src/client/chat/file-ref.ts` | 聊天区文件名点击 → 在 Explorer 展开 + Preview 打开（即"引用/定位文件"） | 🔶 部分复用（需求 3 反向用） |
| `packages/dsh-aionui-panel/src/client/preview/*` | `PreviewPanel`/`PreviewTabs`/`content`/`markdown`：多格式预览 + 分屏编辑 + 保存 | ✅ 编辑/预览需求复用 |

### 1.2 `DSH-better-sidebar`（首选：需求 3/4 的"写输入框" + 侧边栏 tab 备选）

| 文件 | 作用 | 本插件是否复用 |
|---|---|---|
| `src/client/ExplorerView.tsx` | **以 cwd 为根的懒加载树**；行 hover 出现 `@引用` 按钮；右键复制相对/绝对路径 | ✅ 核心复用（树 + 复制 + @按钮） |
| `src/client/conversation-draft.ts` | `appendToDraft(ctx, sessionId, text)`：经 `ctx.sessions.scope(id)` + `ctx.get('conversation').input.setDraft` 把文本写进 composer 草稿 | ✅ 核心复用（需求 3/4 落点） |
| `src/client/service.ts` | `BetterSidebarService`：`registerTab`/`openTab`/`openFile`/`getSnapshot`，发布为 `ctx.betterSidebar` | 🔶 方案 B 用（侧边栏 tab 入口） |
| `src/client/builtins/tabs.tsx` | 内置 explorer tab 如何接 `scope.sessionId`、`scope.cwd`、`onReferenceFile` → `appendToDraft` | ✅ 接线范式复用 |
| `src/client/api.ts` | `SidebarApi`：`session.cwd`/`fs.tree`/`fs.read`/`fs.write` 走 `/sidebar/api/*` | 🔶 若用 better-sidebar 的 host 路由则复用 |
| `dsh.plugin.json` | bundle manifest：`client.main` + `engines.dsh` | ✅ 脚手架复用 |

### 1.3 harness 原生扩展点（需求 4 关键）

- `ctx.inputTriggers`（`@deepseek-ai/dsh-client-ui-input-trigger`）：`registerSource(src)` 注册 `@`/`/` 触发来源
  - 类型见 `deepseek-harness/packages/client/ui-input-trigger/src/types.ts`
  - `candidates(session, {query, position, signal})` → `InputTriggerCandidate[]`（**异步、按 query 懒加载树**）
  - `onPick(pick)` → `PickOutcome`（`{ insert: ReferenceInsert }` / `{ text }` / `{ claim }` / `'handled'` / `undefined`）
  - 可选 `matchSpace` / `matchEnter` / `warm` / `lexicon` / `subscribeLexicon` / `codec`

---

## 2. 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│  dsh-web 浏览器（host 进程跑官方 harness + 本插件 client 半）          │
│                                                                    │
│   [data-dsh-frame] 网格（harness 渲染）                              │
│   ┌────────┬──────────┬─────────┬────────────┬───────────────┐    │
│   │sidebar │ center    │ details │ preview-col │ explorer-col  │    │  ← 本插件追加 2 列
│   │(官方)  │(聊天区)   │(官方)   │ (Preview)   │ (Explorer树)  │    │
│   └────────┴──────────┴─────────┴────────────┴───────────────┘    │
│                                                                    │
│   输入框：用户输入 "@" → ui-input-trigger 调本插件的 @source.candidates │
│        → 懒加载目录树候选 → 选中 → ReferenceInsert 落到草稿            │
└──────────────────────────────────────────────────────────────────┘
        │                                   ▲
        │  POST /filemgr/list|read|write     │  SSE /filemgr/events
        ▼                                   │
┌──────────────────────────────────────────────────────────────────┐
│  host 进程（本插件 host 半，随 dsh web 子进程加载）                    │
│   - WorkspaceGate：解析会话 cwd、canonical、防穿越                    │
│   - FsService：list/read/write/search/delete/watch（受控）           │
│   - routes：/filemgr/* JSON + SSE                                    │
└──────────────────────────────────────────────────────────────────┘
```

数据流：**cwd 从哪来**？两条路——
- dsh-aionui-panel 路线：host `gate` 用 `ctx.workspaceRegistry` 拿到会话工作目录；client 通过 `layoutSetRoot(store, root)` 设置。
- better-sidebar 路线：client 用 `SessionScope = { sessionId, cwd }`，cwd 来自 `api.session.cwd(scope)` 或 harness 会话列表摘要。

**本插件建议**：host 走 dsh-aionui-panel 的 `gate.ts`（`createWorkspaceGate(ctx)` 一行搞定 cwd + 防穿越），client 树加载走它自带的 `PanelApi`（比 `/sidebar/api/*` 少一层依赖，不必装 better-sidebar）。

---

## 3. 插件脚手架

### 3.1 目录结构（放在 `extensions/file-manager/`，与 im-gateway / session-cleaner 同级）

```
extensions/file-manager/
├── package.json                      # name: @lijian-ui/dsh-file-manager
├── cordis.patch.yml                 # 声明 bundle 层（插入 web profile）
├── tsconfig.json
├── tsdown.config.ts                 # 构建 lib/（dsh 子进程读 lib/index.js）
└── src/
    ├── index.ts                     # host 半：gate + FsService + routes + 按钮入口
    ├── host/
    │   ├── gate.ts                  # 复制 dsh-aionui-panel 的 createWorkspaceGate
    │   ├── fs-service.ts            # 复制（改前缀，见下）
    │   └── routes.ts                # POST /filemgr/* + SSE /filemgr/events
    └── client/
        ├── index.ts                 # client 半 apply：挂面板 + 注册 @source
        ├── layout.ts                # 复制 dsh-aionui-panel 的 PanelLayoutController
        ├── mount.tsx                # 复制 mountPanels
        ├── store.ts                 # 复制 4 store（改 api 前缀）
        ├── api.ts                   # PanelApi → /filemgr/* ；subscribePanelEvents
        ├── ExplorerPanel.tsx        # 复制（懒加载树 + 右键复制路径）
        ├── FileTypeIcon.tsx / icons.tsx / overlay.tsx / a11y.ts   # 复制
        ├── preview/                 # 复制 dsh-aionui-panel 的 PreviewPanel 全家
        ├── drag.ts / drag/          # 复制（需求 3 选区拖入输入框）
        ├── chat/file-ref.ts         # 复制（文件名点击定位）
        ├── reference.ts             # 【新写】appendToDraft（从 better-sidebar 搬）
        ├── mention.tsx              # 【新写】@ 来源的 candidates/onPick 实现
        ├── persist.ts / fileType.ts / locales.ts / styles/*.css   # 复制
        └── types.ts (core)          # 复制 DirListing/FileRead/FsEntry 等
```

### 3.2 `package.json`（关键字段，照搬 `dsh-aionui-panel/package.json`）

```json
{
  "name": "@lijian-ui/dsh-file-manager",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "platform": "web"
    }
  }
}
```
> `dsh.client.inject` 列出了 client 半需要的官方服务（conversation 用于需求 3/4 写草稿，settings 用于开关）。

### 3.3 `cordis.patch.yml`（照搬 `dsh-aionui-panel/cordis.patch.yml` 写法）

```yaml
- insert:
    - id: ui-dsh-file-manager
      name: '@lijian-ui/dsh-file-manager'
```
> 安装：`dsh plugin --profile web add @lijian-ui/dsh-file-manager`（或联调期 `link:`/`workspace:*`）。

---

## 4. 功能一：右侧「文件管理」面板（按钮 → 展开，编辑 + 预览）

### 4.1 面板挂载（DOM 注入，复刻 `dsh-aionui-panel/src/client/layout.ts`）

dsh-aionui-panel 的做法**不是 harness 插槽**，而是找到 `[data-dsh-frame]` 网格、把两列
`appendChild` 进去，并重写 `grid-template-columns` 追加 2 条 track：

```ts
// 出自 dsh-aionui-panel/src/client/layout.ts (PanelLayoutController.attach 节选)
const previewCol = document.createElement('div')
previewCol.dataset.aionuiPreviewCol = ''   // 我们用 data-filemgr-preview-col
previewCol.style.minWidth = '0'; previewCol.style.overflow = 'hidden'
previewCol.style.display = 'flex'; previewCol.style.flexDirection = 'column'
previewCol.style.borderLeft = '1px solid var(--aion-bg-3, #e5e6eb)'

const explorerCol = document.createElement('div')
explorerCol.dataset.aionuiExplorerCol = '' // 我们用 data-filemgr-explorer-col
explorerCol.style.minWidth = '0'; explorerCol.style.overflow = 'hidden'
explorerCol.style.display = 'flex'; explorerCol.style.flexDirection = 'column'
explorerCol.style.borderLeft = '1px solid var(--aion-bg-3, #e5e6eb)'

frame.appendChild(previewCol)
frame.appendChild(explorerCol)
// 五轨：sidebar / center / details / preview / explorer
frame.style.gridTemplateColumns =
  `${this.shellTracks[0]} minmax(0,1fr) ${this.shellTracks[2]} ${Math.round(preview)}px ${Math.round(explorer)}px`
```
> ⚠️ 本插件要把 `data-aionui-*` 全部改成 `data-filemgr-*`，并把 `aionui-` 类名/CSS 一并改名，避免和 dsh-aionui-panel 冲突（若二者共存）。

### 4.2 按钮入口（需求：桌面端提供按钮点击展开）

dsh-aionui-panel 没有独立"按钮"，它用一个**浮动展开按钮**（`floatingButton`，固定在右上角，
explorer 折叠时显示，点击 `toggleExplorer()`）。本插件同理：点击 → `layout.toggleExplorer()`
或 `layout.setPreviewOpen(true)` 展开面板。也可在 harness 设置页（参考 `AionUiSettingsCard.tsx`
+ `installSettingsSection`）加一个总开关 `fileManager.enabled`，默认开。

```ts
// 浮动按钮（复刻 layout.ts createHandle 附近的 floatingButton 逻辑）
this.floatingButton = document.createElement('button')
this.floatingButton.className = 'filemgr-floating-expand'
this.floatingButton.setAttribute('aria-label', '展开文件管理器')
this.floatingButton.addEventListener('click', () => this.toggleExplorer())
document.body.appendChild(this.floatingButton)
```

### 4.3 编辑 + 预览（复刻 `client/preview/*`）

`PreviewPanel` 负责多 tab 预览：markdown/html/code/diff/csv/pdf/office/图片/文本，支持
源码↔预览切换、分屏编辑、保存。核心 store 动作（`store.ts` 的 `PreviewStore`）：

```ts
// 来自 dsh-aionui-panel/src/client/store.ts（节选）
openFile(root, path)   // 打开文件为新 tab（dedup 聚焦已有 tab）
updateContent(id, content)  // 编辑中更新（dirty=true）
saveTab(id)            // api.write(root, path, content, mtime) → 冲突检测
reloadTab(id)          // 重新从磁盘读
```
> 预览/编辑是 dsh-aionui-panel 最完整的部分，**整体复制 `client/preview/*` 即可**，无需重造。

---

## 5. 功能二：懒加载目录树（根=cwd）、点击打开、右键复制路径

### 5.1 懒加载（复刻 `store.ts` 的 `ensureDir` + `ExplorerPanel` 的 `TreeRow`）

**按需拉目录**：只有展开某目录时才 `api.list(root, rel)`，命中缓存/正在加载则跳过。

```ts
// 来自 dsh-aionui-panel/src/client/store.ts (ensureDir)
const ensureDir = async (root: string, rel: string): Promise<void> => {
  const state = handle.getSnapshot()
  if (state.root !== root || state.dirs[rel] !== undefined || state.loading.includes(rel)) return
  handle.update((prev) => ({ ...prev, loading: [...prev.loading, rel] }))
  const result = await api.list(root, rel)              // ← POST /filemgr/list
  handle.update((prev) => {
    if (prev.root !== root) return prev
    if (rel !== '' && !prev.expanded.includes(rel)) {    // 展开后又折叠：丢弃陈旧结果
      return { ...prev, loading: prev.loading.filter((i) => i !== rel) }
    }
    const dirs = { ...prev.dirs }
    if (result.ok) dirs[rel] = result.value.entries
    else delete dirs[rel]
    return { ...prev, dirs, loading: prev.loading.filter((i) => i !== rel) }
  })
}
```

**整行点击展开目录 / 点击文件打开预览**（复刻 `ExplorerPanel.tsx` `TreeRow`）：

```ts
const handleClick = (): void => {
  if (entry.isDir) { explorer.toggleDir(entry.path); return }   // 整行切换展开
  explorer.select(entry.path)
  preview.openFile(root, entry.path)                            // 打开预览 tab
}
```

### 5.2 右键复制路径（复刻 `ExplorerPanel.tsx` `openMenu`）

```ts
const absolutePath = (entry: FsEntry): string => {
  const basePath = state.root.replace(/[\\/]+$/, '')
  const sep = state.root.includes('\\') ? '\\' : '/'
  return entry.path === '' ? basePath : `${basePath}${sep}${entry.path.split('/').join(sep)}`
}
const copyText = async (text: string): Promise<void> => {
  try { await navigator.clipboard.writeText(text); toast(t('common.copied')) }
  catch { toast(t('explorer.opFailed')) }
}
// 右键菜单项（节选）：
{ key: 'copy-path', label: t('explorer.menu.copyPath'), onSelect: () => void copyText(absolutePath(entry)) },
{ key: 'copy-name', label: t('explorer.menu.copyName'), onSelect: () => void copyText(entry.name) },
```
> better-sidebar 的 `ExplorerView.tsx` 也实现了同样的"右键复制相对/绝对路径 + @引用按钮"，
> 用 `writeClipboard(text)`（来自 `@deepseek-ai/dsh-client-ui-primitives`）。两套任选，推荐用
> dsh-aionui-panel 的 `navigator.clipboard` 版（依赖更少）。

### 5.3 host 端：受控 list（复刻 `fs-service.ts` 的 `list` + 防穿越）

```ts
// 来自 dsh-aionui-panel/src/host/fs-service.ts (list)
async list(root: string, rel: string): Promise<DirListing | PanelError> {
  const gated = await this.gate(root)
  if (!gated.ok) return gated.error
  const resolved = await resolveInsideRoot(gated.canonical, rel)   // ⚠️ 防路径穿越
  if (!resolved.ok) return resolved.error
  const dirents = await readdir(resolved.abs, { withFileTypes: true })
  // 目录排前、字母序；跳过 .git；返回 { root, entries }
}
```
> **必带 `resolveInsideRoot` 防护**：否则 `rel = "../../etc"` 会逃出 cwd 读系统文件。`gate.ts` 也
> 要 canonical（realpath）避免 symlink 逃逸。这是安全底线，不能省。

---

## 6. 功能三：文件内容选中 → 引用到输入框

两种手法，DSH-better-sidebar 都已实现，直接搬：

### 6.1 手法 A：「@文件」按钮（行 hover 出现，复刻 `ExplorerView.tsx`）

每棵树行右侧一个 `@引用` 按钮，点击把 `@<相对路径>` 追加进 composer 草稿：

```tsx
// 来自 DSH-better-sidebar/src/client/ExplorerView.tsx (rowActions)
<button
  type="button" className={css.explorerRef} aria-label={t('referenceFile')}
  onClick={(e) => { e.stopPropagation(); onReferenceFile(entry.path) }}
>{t('referenceFile')}</button>
```
`onReferenceFile` 在 tab 接线处接到 `appendToDraft`（见 6.3）。

### 6.2 手法 B：选区拖入 composer（复刻 dsh-aionui-panel `drag/file-drag.ts` + `ExplorerPanel` 的 `onDragStart`）

文件行 `draggable`，拖拽时设 `dataTransfer` 携带相对路径，composer 接收即引用：

```ts
// 来自 dsh-aionui-panel/src/client/components/ExplorerPanel.tsx (TreeRow.onDragStart)
const onDragStart = (event: DragEvent): void => {
  if (entry.isDir) return
  event.dataTransfer.setData(FILE_DRAG_MIME, entry.path)
  event.dataTransfer.setData('text/plain', entry.path)
  event.dataTransfer.effectAllowed = 'copy'
}
```
> composer 接收端由 harness 提供（文件拖入输入框即生成引用），本插件只需发出正确 MIME。

### 6.3 落点：`appendToDraft`（复刻 `DSH-better-sidebar/src/client/conversation-draft.ts`）

```ts
// 来自 DSH-better-sidebar/src/client/conversation-draft.ts
import type { Context } from '../context-types.ts'
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    input.setDraft(draft.trim() === '' ? text : `${draft} ${text}`)
    return true
  } catch (error) {
    console.warn('[dsh-file-manager] draft insert failed:', error)
    return false
  }
}
```
> 这是把"引用"真正写进输入框的**唯一官方通路**——经 `ctx.sessions.scope(id)` 拿到会话作用域，
> 再用 `conversation.input.for(actx).setDraft()`。直接改 DOM 输入框是 hack，别走。

---

## 7. 功能四：输入框 `@` 引用文件/文件夹（懒加载树，根=cwd）

### 7.1 注册 `@` 来源（harness 扩展点，复刻 ui-commands 的 `registerSource` 调用形态）

`ctx.inputTriggers.registerSource(src)` 的 `src` 形如：

```ts
// 参考 deepseek-harness/ui-commands/src/client/service.ts 的 registerSource 形态
import type {
  InputTriggerSource, InputTriggerCandidate, CandidateRequest,
  InputTriggerPick, PickOutcome, ReferenceInsert,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const fileSource: InputTriggerSource = {
  trigger: '@',                      // 绑定 @ 触发
  name: 'file-manager',              // 组内唯一；重复会 throw
  order: 50,
  // 输入 "@xxx" 时异步懒加载目录树，返回候选（根 = 会话 cwd）
  async candidates(session, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
    const cwd = await resolveCwd(session.sessionId)   // 见 7.3
    const listing = await api.fsTree(cwd, req.query)  // 复用 store 的目录加载
    return listing.entries
      .filter((e) => e.name.toLowerCase().includes(req.query.toLowerCase()))
      .map((e) => ({ name: e.path, description: e.isDir ? '目录' : '文件', icon: e.isDir ? 'folder' : 'file' }))
  },
  onPick(pick: InputTriggerPick): PickOutcome {
    const rel = pick.candidate.name
    const insert: ReferenceInsert = {
      source: 'file-manager',
      ref: rel,
      label: rel.split('/').pop() ?? rel,
      clipboardText: `@${rel}`,           // 复制/持久化形态
    }
    return { insert }
  },
  // 输入稳定后把 "@path" 渲染成 chip（同步，禁止 fetch）
  lexicon(session) { return currentLexicon(session.sessionId) },  // 可选
  codec: { clipboardText: (ref) => `@${ref}`, serialize: async (ref) => `@${ref}` },
}
// 接线（client apply 里）：
ctx.effect(() => ctx.inputTriggers.registerSource(fileSource))
```

### 7.2 关键类型（`deepseek-harness/.../ui-input-trigger/src/types.ts`）

```ts
export type TriggerChar = '/' | '@'
export interface InputTriggerCandidate { readonly name: string; readonly description?: string; readonly icon?: string; readonly hint?: string }
export interface CandidateRequest { readonly query: string; readonly position: TriggerPosition; readonly signal: AbortSignal }
export interface InputTriggerPick { readonly candidate: InputTriggerCandidate; readonly session: ClientSessionContext; readonly position: TriggerPosition; readonly via: PickVia; readonly span: TokenSpan }
export interface ReferenceInsert { readonly source: string; readonly ref: string; readonly label: string; readonly clipboardText: string }
export type PickOutcome = { readonly claim: CommandClaim } | { readonly insert: ReferenceInsert } | { readonly text: string } | 'handled' | undefined
export interface InputTriggerSource {
  readonly trigger: TriggerChar
  readonly name: string
  readonly order?: number
  candidates(session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]>
  onPick(pick: InputTriggerPick): PickOutcome
  matchSpace?(session: ClientSessionContext, token: string): PickOutcome          // 同步、热状态
  matchEnter?(session: ClientSessionContext, line: string, signal: AbortSignal): Promise<PickOutcome>
  warm?(session: ClientSessionContext): void
  lexicon?(session: ClientSessionContext): readonly string[] | undefined           // 同步装饰
  subscribeLexicon?(session: ClientSessionContext, listener: () => void): () => void
  readonly codec?: ReferenceCodec
}
```

### 7.3 cwd 怎么拿（复刻 better-sidebar `api.session.cwd`）

```ts
// 来自 DSH-better-sidebar/src/client/api.ts
sessionCwd: (scope) => call('session.cwd', scopePayload(scope, {}))
// 返回 { sessionId, cwd, root, parent }
```
> 若本插件 host 半已用 dsh-aionui-panel 的 `gate`，client 也可从 `layout.root` 直接读
> （`stores.layout.getSnapshot().root`），不必再发一次请求。**推荐**：面板和 @ 来源共享同一个
> `root` store，统一来源。

### 7.4 懒加载树与面板树共用一套加载

需求 4 的 `@` 候选树，和需求 2 的面板树**是同一份数据**，都走 `api.fsTree(cwd, rel)`：
- 面板树：`ExplorerPanel` 的 `ensureDir` 逐目录展开加载。
- `@` 候选：`candidates()` 把当前 `@query` 当成"当前目录的过滤"，按需 `fsTree(cwd, dirOf(query))`
  再 `filter(name.includes(query))`。两者可共用 `ExplorerStore` 的 `dirs` 缓存，避免重复请求。

---

## 8. host 路由（复刻 `dsh-aionui-panel/src/host/routes.ts`，改前缀）

```ts
// 来自 dsh-aionui-panel/src/host/routes.ts 形态（registerPanelRoutes）
// 本插件改用 /filemgr/* 前缀，避免与 dsh-aionui-panel 冲突（若共存）
POST /filemgr/list      { root, path }      → FsService.list
POST /filemgr/read      { root, path, asImage } → FsService.read
POST /filemgr/write     { root, path, content, baseMtime? } → FsService.write
POST /filemgr/search    { root, query }      → FsService.search
POST /filemgr/delete    { root, path }       → FsService.delete
POST /filemgr/rename    { root, path, newName } → FsService.rename
POST /filemgr/mkdir     { root, path }       → FsService.mkdir
POST /filemgr/new-file  { root, path }       → FsService.newFile
GET  /filemgr/events?root=  → SSE 推送 fs/git 变更（订阅 FsService.watch）
```
> host 半 `index.ts` 接线（复刻 `dsh-aionui-panel/src/index.ts`）：
> `inject = ['webServer','subprocess','workspaceRegistry','systemPrompt']`；
> `apply` 里 `createWorkspaceGate(ctx)` → `new FsService(gate)` → `registerPanelRoutes(ctx, fs)`。

---

## 9. 落地步骤（建议顺序）

1. **脚手架**：建 `extensions/file-manager/`，填 `package.json`（§3.2）、`cordis.patch.yml`（§3.3）、
   `tsdown.config.ts`、`tsconfig.json`。
2. **host 半**：复制 `gate.ts` + `fs-service.ts`（**含 `resolveInsideRoot` 防穿越**）+ `routes.ts`，
   前缀改 `/filemgr/*`；`index.ts` 接线 `apply`。
3. **client 基础设施**：复制 `store.ts` / `api.ts`（前缀改 `/filemgr/*`）/ `persist.ts` / `fileType.ts` /
   `locales.ts` / `styles/*.css` / `icons.tsx` / `overlay.tsx` / `a11y.ts` / `FileTypeIcon.tsx` /
   `core/types.ts`。
4. **面板挂载**：复制 `layout.ts` + `mount.tsx`，把所有 `aionui` 命名改为 `filemgr`（§4.1）。
5. **目录树 + 预览**：复制 `ExplorerPanel.tsx` + `client/preview/*`（功能 1/2 完成）。
6. **写输入框**：复制 `conversation-draft.ts`（→ `client/reference.ts`）+ 树行 `@引用` 按钮 +
   选区拖拽 `drag/*`（功能 3 完成）。
7. **@ 来源**：新写 `client/mention.tsx`，`registerSource` 注册 `@` 来源，复用 `ExplorerStore.dirs`
   缓存做懒加载候选（功能 4 完成）。
8. **联调**：`extensions/file-manager` 用 `workspace:*` 接进桌面 dev profile → `npm run build`
   → `npm run dev`（**两步必走**：build 生成 `lib/`，再 dev 让 dsh 子进程重新 require）。

---

## 10. 风险与注意

| 风险 | 说明 | 应对 |
|---|---|---|
| 右侧面板非官方插槽 | dsh-aionui-panel 直接改 `[data-dsh-frame]` 网格，依赖 harness 渲染该元素 | 保留 `findFrame()` 的 fallback（找 `[class*="sidebarCol"]` 父级）；HMR/重载时重挂 |
| 与 dsh-aionui-panel 共存 | 都用 `data-aionui-*` / `aionui-*` 类名会冲突 | 本插件全量改名 `filemgr-`；或二选一只装一个 |
| 路径穿越 | 文件读取必须限制在 cwd 内 | 必带 `resolveInsideRoot` + `gate` canonical；拒绝 `.git`/`..` |
| `@` 来源重复注册 | `(trigger,name)` 重复会 throw | `name` 用唯一 `file-manager`；放 `ctx.effect` 自动 dispose |
| build/dev 不同步 | dsh 子进程读 `lib/`，改 src 不 build 不生效 | 改完必 `npm run build` + 重启 `npm run dev`（见工作流约定） |
| cwd 来源不统一 | 面板树和 @ 来源各读各的会不一致 | 共享 `layout.root` / `ExplorerStore`，单一真源 |

---

## 11. 一句话总结

**不要从零写**。把 `dsh-aionui-panel` 的 host（gate+fs+routes）和 client（layout+store+Explorer+Preview+
drag）整体搬运并改名 `filemgr-`，再补两块新代码：① 从 better-sidebar 搬来的
`appendToDraft`（文件名/选区 → 输入框）；② 基于 harness `ctx.inputTriggers` 新写的 `@` 来源
（`candidates` 懒加载树、`onPick` 返回 `ReferenceInsert`）。需求 1/2/3 基本是复制粘贴，需求 4
是唯一的"新写"，且复用同一套树加载缓存。
