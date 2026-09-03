# dsh 内置 AI 办公编辑器插件（Office AI Editor Plugin）开发文档

> 目标：在 dsh 桌面壳的右侧面板内，提供可**预览 + 轻编辑 + AI 修改** Word/Excel/PPT/PDF 的能力。
> 核心诉求：对标 WorkBuddy——AI 能创建**真实 Office 文件**（`.docx/.xlsx/.pptx`），用户点击产物在右侧展开预览编辑面板，用户可选取区域 / 输入文本引用（如 `月度支出!C11`），AI 据此修改对应行/列/段落并落盘为真实格式。
>
> 本文档为「从简到难」的实施路线，详细到文件路径与代码片段，供后续接续开发使用。所有路径基于 `e:\Project\dsh-desktop`。

---

## 1. 背景与决策记录

### 1.1 为什么不用参考项目 `dsh-univer-office`

该参考项目已完成「Univer 作为 viewer 寄生进 dsh 的 host/client 分层、skill/tool 让 AI 操作、worktree 审阅、右侧面板」的完整架构，**架构本身正确、值得沿用**。但：

- 它依赖 **`@univerjs-pro/*`（Univer 商业版）** 做真实 `.xlsx/.docx/.pptx` 的导入导出与协同，见 `src/gateway-app/exchange/gateway-exchange-service.ts` 的 `exportSnapshotToBuffer`。
- 仓库带的是 **90 天开发试用 license**（`src/viewer-support/render-preset/license.ts` 注明 *"90-day development license for browser rendering"*），**没有商业授权时无法长期使用**。
- 它的工作对象是 `.univer` **私有格式**，不是直接产出真实 `.xlsx/.docx/.pptx` 文件内容。

**结论**：参考项目只借架构，不借 Pro 授权；真实格式读写改用 GenOffice 的 Apache-2.0 引擎替代。

### 1.2 为什么选 GenOffice

来源 `e:\Project\dsh-desktop\参考项目\genoffice`（Apache-2.0，`README.md` 第 111~131 行「Engine packages」）：

| 引擎包 | 职责 | 技术特性 |
|---|---|---|
| `packages/docx-engine` | docx 解析→块树 + OOXML 片段生成 + 字节级段落 patch | 纯 TS、无 Electron 依赖、100+ 单测 |
| `packages/pptx-engine` | pptx 模型与渲染 | 纯 TS、母版/图表/动画/表格 |
| `packages/pdf2docx` | PDF→docx/xlsx/pptx 本地转换（PDFium） | 纯 TS/Node |
| `packages/file-parse` | office 附件文本提取（供 AI 引用） | 纯 TS |
| `apps/sheets` | xlsx 读写走 **Rust sidecar**（calamine + IronCalc）+ **OOXML copy-on-write gateway** | 唯一有原生依赖 |

**关键决策**：
- docx / pptx / PDF：引擎**纯 TS，可直接打进 dsh client**，无需服务端。
- xlsx：**预览与轻编辑优先走纯 JS**（参考项目 `dsh-plugin-better-sidebar-plugin-office` 的 SheetJS→Univer 链路，见 1.5/5.2），`apps/sheets` 的 **Rust sidecar 降级为可选优化项**（仅当需要样式保真 / 超大型表 / 复杂协同时才引入），不作为阶段 2 的前置依赖。
- 全部 Apache-2.0 无授权坑。

### 1.5 复用参考项目 `dsh-plugin-better-sidebar-plugin-office`（预览半现成）

来源 `e:\Project\dsh-desktop\参考项目\dsh-plugin-better-sidebar-plugin-office`（Agent-调研结论）：

| 资产 | 位置 | 复用价值 |
|---|---|---|
| SheetJS→Univer 转换 | `src/client/xlsx-to-univer.ts` | 用开源 SheetJS 读**真实 .xlsx**，转 Univer `IWorkbookData`（值/公式/合并/列宽行高）；证明 xlsx 预览**全程无原生依赖** |
| Univer sheets 渲染组件 | `src/client/office-view.tsx` 的 `XlsxView` | 自包含（props 仅 `scope/path/title`），含 dispose/worker 清理、错误降级下载，可直接移植到 `editors/SheetEditor.ts` |
| docx 保真渲染 | 同上 `DocxView`（docx-preview） | 预览半现成，可复用为阶段 3 的浏览层 |
| pptx 渲染 | `src/client/PptxView.tsx`（pptx-renderer） | 预览半现成，可复用为阶段 4 的浏览层 |
| tsdown 打包坑 | `tsdown.config.ts` | SheetJS/JSZip 的 browser-entry alias（CJS 降级残留 Node builtin），Office 库打包必踩，照抄省排查 |

**注意**：该插件是 **只读预览**，耦合 better-sidebar 的 `registerFileViewer`（非桌面壳 slot 体系）。→ 我们只复用**组件/转换层**，集成层换成 `conversation.input.dock` slot；「编辑交互 + AI 修改 + 真实格式写回」仍是本项目的核心增量，GenOffice 负责写回。

### 1.6 复用参考项目二 `DSH-better-sidebar`（调度 / 字节 / 兜底范式）

来源 `e:\Project\dsh-desktop\参考项目\DSH-better-sidebar`（MIT），它是 1.5 那个 office 插件的**宿主**（office 插件靠 `ctx.betterSidebar.registerFileViewer` 挂进去）。我们不抄它的右侧栏本体，抄它经过验证的三层范式：

| 范式 | 位置（参考项目） | 移植要点（桌面壳版） |
|---|---|---|
| **多格式匹配调度** | `src/client/service.ts` 的 `matchFileViewer`：priority 降序单趟，`detect`(content sniff, 前 4KB head) → `exts`；内置 image/pdf=0、binary-download=-50、code 兜底=-100 | 我们的多格式分发按「priority + exts/detect」单趟裁决，未知/失败落到「下载」兜底 |
| **字节读取纪律** | `src/index.ts` `#L540-L584` `/sidebar/file` 媒体路由：信任围栏 `isWithin(cwd, path)`(403) → `stat` 是文件 + `size<=mediaLimit`(默认 20MB) → 二进制安全回原始字节 + 未知类型 fallback `application/octet-stream` → `?download=1` 转附件 | 桌面壳无 HTTP 路由，语义用 **Typert Remote `readFileBytes(scope, path)`** 复刻：同样带信任围栏 + 大小上限 + 错误降级下载 |
| **失败统一兜底** | AGENTS.md §3.5 类：所有预览失败分支附下载链接，保证用户总能拿到文件 | 编辑器每种格式的错误态都带「下载查看」出口 |

**辅助参考**：
- **bundle 纯度 + 懒加载**（AGENTS.md §7）：client 禁 value-import 别的插件，`import type {}` 擦除不触发门禁；重依赖（Univer/CodeMirror/xterm）走独立 chunk 按需下发——印证我们对 Office 库的 tsdown 处理方向。
- **声明式设置**（AGENTS.md §5）：tab/viewer 自动进设置页清单，开关持久化 `prefs.viewersEnabled[id]`；`settings.pluginToggles` / `settings.render` 做插件自有设置——我们的编辑器各格式启用开关可对齐此模式（对齐 dsh 的 settings.section 而非 better 的 prefs）。

**综合分工（两参考项目 + 我们）**：
1. 渲染组件 + SheetJS→Univer 转换层 → 抄 `dsh-plugin-better-sidebar-plugin-office`（1.5）。
2. 多格式匹配、字节读取纪律、错误兜底 → 抄 `DSH-better-sidebar`（1.6），语义换 Typert Remote。
3. 编辑交互 + AI 修改 + 真实格式写回 → 本项目增量，GenOffice 负责写回。

### 1.3 交互目标（对齐 WorkBuddy 的引用方式）

WorkBuddy 的「引用→AI 改」**不是传选区对象，而是文本化地址标记**，简单可靠：

```
月度支出!C11            → 单元格 C11
月度支出!A4:C5          → 区域 A4:C5
```

模型拿到文本引用 → 调用编辑 skill 直接定位并写入。无需复杂拖拽选区传对象交互。

### 1.4 四个文件类型的难易排行

```
PDF(易) → xlsx(中，唯一带 Rust) → docx(中) → pptx(中)
```

四个类型共用同一套「右侧渲染一个文件编辑面板 + 暴露文本引用给 AI」的宿主骨架，**骨架搭一次、四类复用**，而非各写一套 UI。

---

## 2. 总体架构（沿用参考项目的寄生分层）

dsh 插件分为 **host（主进程侧）** 和 **client（浏览器渲染侧）** 两侧。参考项目中最值得沿用的三个寄生点：

| 寄生点 | 位置（参考项目） | 作用 |
|---|---|---|
| host skill 注册 | `src/host/skills/plugin.ts` → `ctx.skills.registerProvider()` | 给 LLM 领域操作手册 |
| host tool 注册 | `src/host/tools/plugin.ts` + `src/host/tools/definitions/*.ts` → `defineTool()` | 让 LLM 真正动手 |
| client slot 注入 | `src/client/index.tsx` → `ctx.slots.inject()` | 右侧面板 UI |

### 2.1 宿主（host）与客户端（client）职责

```
Host（主进程 / Node.js）
  ├─ 引擎层（docx-engine / pptx-engine / pdf…）
  ├─ xlsx Rust sidecar（进程或 wasm）
  ├─ tools 定义（office_execute / office_import / office_export …）
  └─ skills 注册（office / office-doc / office-sheet / office-slide / office-pdf）
                           │  (DSH 将 skill+tool 暴露给模型)
                           ▼
Client（浏览器渲染 / 右侧面板）
  ├─ 渲染层（每格式一个编辑器组件）
  ├─ slots: conversation.chat.turnTail   → 产物卡片
  ├─ slots: conversation.input.dock      → 右侧可编辑面板
  └─ 引用标记逻辑（把选区/文本 → 「表格名!C11」）
```

---

## 3. 目录规划（在 extensions 下新建插件）

建议新建 `e:\Project\dsh-desktop\extensions\dsh-office`，参照现有插件（如 [`extensions\dsh-vision-toggle`](file:///e:/Project/dsh-desktop/extensions/dsh-vision-toggle)、`extensions\dsh-skill-manage`）与参考项目结构。

```
extensions/dsh-office/
├── package.json
├── tsdown.config.ts
├── tsconfig.json
├── cordis.patch.yml
├── src/
│   ├── index.ts                  # host 入口
│   ├── host/
│   │   ├── tools/
│   │   │   ├── plugin.ts         # 注册所有 office_* 工具
│   │   │   └── definitions/*.ts  # 每个工具一个文件
│   │   ├── skills/
│   │   │   ├── plugin.ts         # ctx.skills.registerProvider(...)
│   │   │   └── office/SKILL.md
│   │   ├── service/              # 文件生命周期 / 读写 / worktree
│   │   └── engine/               # 封装 GenOffice 引擎
│   │       ├── docx.ts           # parseDocx / saveDocx
│   │       ├── pptx.ts           # pptx-engine
│   │       ├── xlsx.ts           # Rust sidecar 封装
│   │       └── pdf.ts            # pdfium/pdf.js
│   └── client/                   # client half：无 JSX，文件用 .ts（不用 .tsx）
│       ├── index.ts              # client 入口，注入 slots
│       ├── remote.ts             # Typert Remote $mount（对齐规范 10.1）
│       ├── components/
│       │   ├── preview-card.ts   # 回合尾部产物卡片
│       │   └── office-dock.ts    # 右侧编辑面板
│       └── editors/              # 各格式渲染组件
│           ├── DocEditor.ts
│           ├── SheetEditor.ts
│           ├── SlideEditor.ts
│           └── PdfEditor.ts
│
参考（改自 GenOffice）：
参考项目/genoffice/packages/docx-engine → 复制到 vendor 或作为 npm 依赖
参考项目/genoffice/packages/pptx-engine → 同上
参考项目/genoffice/apps/sheets 的 Rust 链路 → 作为参考移植
```

package.json（host + client 双半，对齐规范 9.2 的 bundle 结构 + 10.1 的 `dsh.client` 声明）：

```json
{
  "name": "@lijian-ui/dsh-office",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-gateway"
      ],
      "platform": "web",
      "immediately": true
    }
  },
  "dependencies": {
    "@deepseek-ai/dsh-skill": "^0.x",
    "@deepseek-ai/dsh-tools": "^0.x",
    "docx-engine": "file:vendor/docx-engine",
    "pptx-engine": "file:vendor/pptx-engine"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-settings": "*",
    "@deepseek-ai/dsh-typert-protocol": "*"
  }
}
```

> **规范要点（对齐 9.2 / 10.1）**：
> - 双半同包：`main` = host 入口，`exports["./client"]` + `dsh.client` 声明浏览器半。**不要**新增独立的 client loader entry（如 `name: '@lijian-ui/dsh-office/client'`），让现有 host entry 承载即可，否则 `require.resolve('<pkg>/client/package.json')` 失败。
> - `dsh.client.inject` 只列 client **包名**，是可传递的（`dsh-api-gateway` 会带出 typert-registry + connection）；`immediately: true`、`platform: "web"` 都要。
> - 第三方 client 的配置写入走 **Typert Remote**（不碰 settings 白名单，见 10.1 大坑）。

---

## 4. host 侧关键代码片段

### 4.1 注册 tool（对齐规范第 6 节）

> 规范关键点：`defineTool` 的 `execute` 返回 `output.schema` 声明的**规范值（canonical value）**，`output.render` 才转成面向模型的内容；`output` 的 `schema` 与 `parameters` 用同一套 DSL，**对象必须显式声明 `additionalProperties`**。工具最终用注入的 `tools` 服务注册，`export const inject = ['tools']` 让框架等待工具表就绪。

以「执行一段编辑 / 修改文件」为例（`office_execute`），与参考项目 `univer_execute` 对齐：

```ts
// src/host/tools/definitions/execute.ts
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { diffThinkPlan } from '../engine/...'      // 真实的文件编辑逻辑，见第 5 节

export function officeExecuteTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'office_execute',
    description:
      'Execute an edit against a real .docx/.xlsx/.pptx/.pdf file and commit mutations. '
      + 'Provide code for small snippets; prefer codeFile for multi-line operations. '
      + 'Exactly one of code or codeFile is required.',
    timeoutMs,
    parameters: {
      file: { type: 'string', required: true, description: 'Workspace-relative or absolute path to the office file.' },
      code: { type: 'string', description: 'Small edit snippet. Mutually exclusive with codeFile.' },
      codeFile: { type: 'string', description: 'Path to a JS edit body file. Preferred for multi-line; mutually exclusive with code.' },
      ref: {
        type: 'string',
        description: 'Text reference, e.g. "月度支出!C11" or "月度支出!A4:C5". Used to target the edit location.',
      },
    },
    output: {
      // 成功结果执行时强制校验的规范输出 schema（对象必须声明 additionalProperties）
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          changed: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      // 纯函数：把已校验的规范值渲染成面向模型的 ContentBlock
      render: (_args, value) => [{ type: 'text', text: `[${value.ok ? 'ok' : 'err'}] ${value.file}: ${value.summary}` }],
      // 可选：为 UI 卡片回放提供元数据
      presentationMeta: (_args, value) => ({ ok: value.ok, file: value.file, summary: value.summary }),
    },
    isConcurrencySafe: () => false,               // 有副作用，不与兄弟调用并行
    async execute(args, exec) {
      // args 已按 parameters schema 校验并推断类型
      const result = await diffThinkPlan(ctx, exec, {
        file: args.file, code: args.code, codeFile: args.codeFile, ref: args.ref,
      })
      return result                                 // 返回 output.schema 声明的规范值
    },
  })
}
```

在 tools 插件里注册：

```ts
// src/host/tools/plugin.ts
import type { Context } from '@deepseek-ai/cordis'
import { officeExecuteTool } from './definitions/execute'

export const name = 'office-tools'
export const inject = ['tools']                    // 等待 tools 服务就绪

export function apply(ctx: Context): void {
  ctx.tools.register(officeExecuteTool(ctx, 60_000))
  // ... 其余 office_import / office_export / office_screenshot ...
}
```

### 4.2 注册 skill（参考 `src/host/skills/plugin.ts`）

Skill 是 Markdown 操作手册，教模型何时用哪个 tool、执行顺序、错误恢复。五类文件各一个 skill：

```ts
// src/host/skills/plugin.ts
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'office'
const INVOCATION = { modelInvocable: true, userInvocable: true } as const

const DEFINITIONS = [
  { name: 'office', description: 'Create / inspect / edit real Office files (.docx/.xlsx/.pptx/.pdf). Load before the matching format skill.' },
  { name: 'office-doc', description: 'Word .docx editing: paragraphs, text, tables, images, headers, byte-preserving round trip.' },
  { name: 'office-sheet', description: 'Excel .xlsx editing: cells, ranges, formulas, tables, charts, ref like "sheet!C11".' },
  { name: 'office-slide', description: 'PowerPoint .pptx: slides, masters, layouts, text, shapes, charts.' },
  { name: 'office-pdf', description: 'PDF view/edit: text reflow, images, conversion to docx/xlsx/pptx.' },
] as const

const CANDIDATES: readonly SkillCandidate[] = DEFINITIONS.map((d) => {
  const url = new URL(`../skills/${d.name}/SKILL.md`, import.meta.url)
  return {
    ...d,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`../skills/${d.name}/`, import.meta.url)) },
    rank: BUNDLED_SKILL_RANK,
    locator: url,
  }
})

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
  async get(candidate): Promise<SkillDefinition> {
    if (!(candidate.locator instanceof URL)) throw new Error('office skill locator must be a URL')
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      ...(candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase }),
      content: stripFrontmatter(await readFile(candidate.locator, 'utf8')),
    }
  },
}

export const name = 'office-skills'
export const inject = ['skills']

export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}

function stripFrontmatter(value: string): string {
  if (!value.startsWith('---\n')) return value
  const end = value.indexOf('\n---\n', 4)
  return end === -1 ? value : value.slice(end + 5)
}
```

> Skill 文件示例 `skills/office-sheet/SKILL.md`，必须强调：**用结构化 `office_*` 工具，绝不直接改磁盘文件、绝不用 openpyxl/python-docx 替代**。参考 `参考项目/dsh-univer-office/skills/univer/SKILL.md` 的措辞（"Do not invoke a global CLI, don't edit the file directly"）。

### 4.3 host 入口（对齐规范第 4 节：注入 + 组合）

插件加载时 cordis 会按 `inject` 保证依赖服务就绪；注册能力一律走 `ctx`（卸载自动清理）。用 `ctx.plugin(...)` 把子插件编排起来（规范 9.7 组合优于继承）：

```ts
// src/index.ts（host）
import type { Context } from '@deepseek-ai/cordis'
import { officeSkillPlugin } from './host/skills/plugin'
import { officeToolPlugin } from './host/tools/plugin'

export const name = 'dsh-office'
// 声明依赖：让框架等待 service 就绪；若能力缺失则本插件不加载
export const inject = ['skills', 'tools', 'settings']

export function apply(ctx: Context): void {
  ctx.plugin(officeSkillPlugin)
  ctx.plugin(officeToolPlugin)
  // 若需要把读写能力作为服务暴露给其它插件，用类形式 + declare module 合并类型（见规范 4.3/4.4）
}
```

---

## 5. 各格式引擎封装（核心：真实文件读写）

### 5.1 WORD（docx）—— 用 GenOffice `docx-engine`

参考 `参考项目/genoffice/packages/docx-engine/src/index.ts` 的公开 API：

```ts
import {
  parseDocx,       // 解析 → ParsedDocFull（docxIndex 锚点块树）
  saveDocx,        // 落盘：只重写脏块，其余字节原样
  buildBlankDocx,  // 新建空白 docx
  generateParagraphXml,
  generateTableXml,
  // ... 大量生成/修补函数
} from './docx-engine'

// 读取
const parsed = await parseDocx(buffer)          // 得到块树 + 样式
// 字节保真保存：SaveBlock[] 描述 preserved(original) / regenerated(dirty)
const saveBlocks: SaveBlock[] = [
  { kind: 'original', docxIndex: 0 },            // 未动的块，原字节
  { kind: 'generated', block: newParagraph },    // 改动块，重建
]
const out = await saveDocx(originalZip, parsed, saveBlocks, options)
```

**字节保真哲学**（来自 README 第 154~168 行）：原文件是唯一事实源，`saveDocx` 只对 `generated` 块生成 OOXML 片段，其余块以 `original` 原样 splice 回 `word/document.xml`，其它 zip 条目逐字节拷贝，故 Word 打开不破版。

### 5.2 EXCEL（xlsx）—— 首选纯 JS（SheetJS→Univer），Rust sidecar 为可选

**首选链路（无需原生依赖）**：参考项目 `dsh-plugin-better-sidebar-plugin-office/src/client/xlsx-to-univer.ts`。

- 读：开源 **SheetJS**（`import('xlsx')`）`XLSX.read(buf, { type: 'array' })` 解析**真实 .xlsx**。
- 渲染：`xlsxWorkbookToUniver(wb, '0.25.1', locale)` 把 workbook 转成 Univer `IWorkbookData`（值 / 公式 / 合并单元格 / 列宽行高），用 Univer **开源** sheets preset 渲染。
- 写：SheetJS `XLSX.write()`（CE 版支持基本写回）或 **exceljs**（Apache-2.0，样式保真更好）。封装为统一 `WorkbookAdapter`：

```ts
// src/host/engine/xlsx.ts
import * as XLSX from 'xlsx'
import { xlsxWorkbookToUniver } from '../vendor/xlsx-to-univer'   // 自参考项目移植

export interface WorkbookAdapter {
  load(buf: ArrayBuffer): Promise<{ snapshot: unknown }>   // 给 Univer 渲染
  getCell(ref: string): Promise<unknown>                   // "sheet!C11" 定位读取
  setCell(ref: string, value: unknown): Promise<void>      // 轻编辑写回
  save(): Promise<ArrayBuffer>                             // 落盘真实 .xlsx
}

export const initSheetJsAdapter = {
  async load(buf: ArrayBuffer) {
    const wb = XLSX.read(buf, { type: 'array' })
    return { snapshot: xlsxWorkbookToUniver(wb, '0.25.1', 'zhCN') }
  },
  // getCell/setCell/save 基于 wb 的内存模型实现
}
```

**可选优化项**：仅当需要样式保真 / 超大型表 / 复杂协同时，再引入 `apps/sheets` 的 **Rust sidecar**（calamine + IronCalc + OOXML copy-on-write gateway），编为 wasm 或原生二进制随 dsh 分发：

```
React 壳 + Univer(开源UI)   ← 渲染层
        │
  typed preload bridge + IPC
        │
  Rust xlsx sidecar (calamine + IronCalc)  ← 进阶真 xlsx 读写
        │
  copy-on-write OOXML gateway             ← 手术式只改目标 sheet
```

> 渲染层统一用 Univer 开源核心（Apache-2.0）；读/写由纯 JS 适配器（主线）或 sidecar（进阶）承担。

### 5.3 PPT（pptx）—— 用 GenOffice `pptx-engine`

参考 `packages/pptx-engine/src/index.ts`（已确认有 parse / generate / patch / insert / chart 等大量导出）。API 与 docx-engine 同构：读入解析 → 修改模型 → 保存字节保真。

### 5.4 PDF —— pdf.js + pdf-lib + PDFium wasm

参考 `参考项目/genoffice/apps/pdf` 与 `packages/pdf2docx/src/index.ts`：

```ts
import { convertPdfToDocx, convertPdfToPptx, convertPdfToXlsx, extractIrDocument } from './pdf2docx'
```

PDF 的**浏览渲染**用 pdf.js（Apache-2.0，浏览器直跑，天然可嵌入 dsh client）；**文本/图片编辑**重写页面内容流用 PDFium wasm（BSD-3）；**PDF→Word/Excel/PPT** 转换用 pdf2docx。这是四类中最独立、最容易先跑通的。

---

## 6. client 侧关键代码片段（右侧面板 + 引用标记）

> **对齐规范第 10 节（dshClient）**。client 是浏览器端 bundle，约束：
> - **无 JSX / 无 TSX**：用 `React.createElement` 构建（规范 10.4，文件扩展名应为 `.ts`，不用 `.tsx`）。
> - **注入 hooks 命名**：`ctx.slots.register({ ..., inject: () => ({ hooks: { sheetEditor: scope } }) })`，组件通过 `slot.props.useSheetEditor((s) => s)` 取（`'use' + 首字母大写`，规范 10.3）。
> - **hooks 只能在组件函数体顶层调用**（规范 10.2），不能放进 `useMemo`/`useEffect`/循环。
> - **样式**：内联 `style` + `var(--dsw-alias-*)` token 适配明暗主题（规范 10.5），图标用内联 SVG。
> - **数据/配置给第三方 client**：不要碰 settings 白名单，用 **Typert Remote**（host 注册 Remote 服务 + client `remote.$mount`），参考 `dsh-vision-toggle` 的 remote.ts 与 `extensions/im-gateway/src/remote.ts`。

参考 `参考项目/dsh-univer-office/src/client/index.tsx` 的 slot 注入模式，改为组件化 + hooks 注入：

```ts
// src/client/index.ts
import { OfficePreviewCard } from './components/preview-card'
import { OfficeDock } from './components/office-dock'
import { officeTurnDefinition } from './conversation/office-turn-definition'

export const inject = ['slots', 'locale', 'conversationEvents']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.conversationEvents.register(officeTurnDefinition), 'office: turn')

  // 回合尾部产物卡片：AI 生成产物后展示
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -10,
    inject: () => ({}),          // 需要选项目时在此注入 hooks
  }, OfficePreviewCard)), 'office: turn preview')

  // 右侧浮动面板：加载真文件并编辑
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'office-dock',
    order: 400,
    inject: () => ({
      hooks: {
        sheetEditor: ctx.get('remote.office')   // annotate: 通过 Typert Remote 暴露读/写/选区能力
      },
    }),
  }, OfficeDock)), 'office: dock')
}
```

组件用 `React.createElement` 接收注入的 hooks：

```ts
// src/client/components/office-dock.ts（示意，实际用 React.createElement 构建 DOM）
export const OfficeDock: ComponentClass = {
  // 由 slots 渲染器绑定：hooks: { sheetEditor } → props.useSheetEditor
  displayName: 'OfficeDock',
  render(props) {
    const editor = props.useSheetEditor((s) => s)   // ✅ 顶层调用，prop 名按 use 规则
    if (!editor) return null
    return editor.render()                            // 渲染当前文件编辑器
  },
}
```

> <span style="color:red">**不要**在 client 里用 `window.dispatchEvent(CustomEvent)` 这类全局事件来做文件间通信</span>（规范 10 明确禁止，且是运行时崩溃高发点）。跨组件共享一个 `editor` 状态时，把它放进 slot 的注入 `hooks`（如上），由 slots 渲染器下发，而不是自己造全局事件总线。

### 6.1 引用标记逻辑（`月度支出!C11`）

在编辑器组件内，用户点选单元格 / 文本时，把选区转成**文本标记**；通过注入 slot 的 `hooks` 回调（而非全局事件）把标记写回冒泡给宿主，让点击「引用」时该标记可插入输入框：

```ts
// src/client/editors/SheetEditor.ts（示意，无 JSX，用 React.createElement）
import { h } from '@deepseek-ai/dsh-client-web-react'   // 具体工厂函数以该包导出为准

function onSheetSelection(selection: { sheet: string; ref: string }): string {
  // 返回文本标记（"sheet!C11"），供宿主插入输入框 / 作为 office_execute 的 ref
  return `${selection.sheet}!${selection.ref}`
}
```

> 该标记字符串即传入 `office_execute` 的 `ref` 参数（见 4.1），模型据此定位行列。无需复杂选区对象传递——**引用就是一个纯字符串**，前端只负责拼出来 + 塞进输入框，改动定位交给模型 + skill 解析。

---

## 7. 分阶段实施路线（从简到难）

### 阶段 0：搭宿主骨架

- 新建 `extensions/dsh-office` 工程（package.json / tsdown.config.ts / tsconfig / cordis.patch.yml），注册到根 `package.json` 的 `watch:plugins` 与 `src/main/profile-init.ts` 的 `PLUGIN_BUNDLES`（沿用 vision-toggle 的接入方式）。
- 打通 client 的 `input.dock` 右侧空面板 + `turnTail` 产物卡片占位。
- 打通 host 的 `office_execute` 占位工具 + `office` skill。
- 打通 host 的 **Typert Remote 文件字节服务** `readFileBytes(scope, path)`（语义复刻 better-sidebar `/sidebar/file` 路由：信任围栏 `isWithin(cwd, path)` → 是文件 + `size<=mediaLimit` → 原始字节，见 1.6），并加 client 侧「多格式匹配 + 下载兜底」分发骨架（对齐 1.6 的 `matchFileViewer` 范式）。

### 阶段 1：PDF（最容易，先验证闭环）

- 用 pdf.js 在右侧面板渲染 PDF。
- 接 pdf2docx 做 PDF→Word/Excel 转换（AI 生成的转换产物）。
- 验证：AI 生成 → 面板显示 → 用户查看 → AI 修改文稿。

### 阶段 2：xlsx（你最关心的引用示例）

- 移植参考项目 `dsh-plugin-better-sidebar-plugin-office` 的 **SheetJS→Univer** 链路（`xlsx-to-univer.ts` + `XlsxView`）到 client，打开**真实 .xlsx** 渲染（预览半现成，无原生依赖）。
- 实现「点选 → `sheet!C11` 引用 → AI 改 → SheetJS/exceljs 写回真实 xlsx」的核心闭环。
- 若后续遇到样式保真 / 超大型表瓶颈，再评估上 `apps/sheets` 的 Rust sidecar（可选优化）。

这是对齐 WorkBuddy「月度支出!C11」的闭环。相较原方案，阶段 2 门槛显著降低：预览与写回都不再强依赖 Rust sidecar。

### 阶段 3：docx（Word 级排版 + 字节保真）

- 用 `docx-engine` 解析/生成，自搭浏览器渲染层（Tiptap/ProseMirror）。
- 接 AI 修改：段落/表格/图片 + 字节保真落盘。

### 阶段 4：pptx

- 用 `pptx-engine` 解析/渲染/保存，接 AI 生成与修改。

---

## 8. 关键决策与风险清单

| 决策点 | 结论 | 备注 |
|---|---|---|
| 编辑器内核 | 沿用参考项目「寄生 dsh」架构，但替换 Pro 授权为 GenOffice 引擎 | 只借架构，不借 license |
| xlsx 读写 | **首选纯 JS**（SheetJS→Univer 预览 + SheetJS/exceljs 写回），**Rust sidecar 降级为可选** | 见 5.2；四类基本无原生依赖 |
| docx/pptx/PDF | 纯 TS 引擎可直接打进 client | 无需服务端 |
| 预览半 | 复用 office 插件的 `xlsx-to-univer.ts` / `XlsxView` / `DocxView` / `PptxView`；调度/字节/兜底范式抄 better-sidebar | 见 1.5+1.6 |
| 引用交互 | 文本标记 `sheet!C11`，不走选区对象 | 简单可靠，对齐 WorkBuddy |
| 渲染编辑 UI | 需自搭浏览器层（参考项目在 Electron 内，无法当 npm 包） | 工作量主要集中点 |
| 参考项目 | 90 天试用 license，不可长期商用 | 只作架构参考 |

### 风险

1. **xlsx 样式保真**：SheetJS/exceljs 对样式/条件格式/图表保真有限。若实际需要，再引入 Rust sidecar 解决（此时需 cargo 编译产物随包分发，mac/Win 各平台分别编）。
2. **docx 字节保真 UI 接线**：Word 级排版（分页/样式/修订/批注）映射到浏览器编辑器的复杂度高，是精细活。
3. **GenOffice 引擎未发布为 npm 包**：起步先复制 `src` 进 `vendor/`，之后再评估发布/子依赖。
4. **编辑 UI 重建**：GenOffice 的编辑界面在 Electron 内，无法直接嵌入，需在 client 重建——这是最大工作量项。

### 下一步（接续开发起点）

从 **阶段 0 骨架 + 阶段 1 PDF** 开始：先在本机 `npm run dev` 跑通「右侧面板空壳 + 产物卡片 + 一个 PDF 渲染」，再横向扩展到 xlsx。

---

## 9. 对齐插件开发规范的自查清单

> 本文档是**方案设计 + 调研记录**，落地写码时必须对照工程规范 `docs/plugin-development.md`（工程规范）与 `docs/plugin-dev-debugging-guide.md`（调试）。以下是从规范提炼的、本插件必须满足的检查点：

| 检查点 | 规范出处 | 本插件落实情况 |
|---|---|---|
| 工具用 `defineTool` + `ctx.tools.register`，`inject=['tools']` | 规范 6.1 | 见 4.1 |
| 工具必须有 `output.schema`（对象显式 `additionalProperties`）+ `output.render`，execute 返回规范值 | 规范 6.2/6.4 | 见 4.1 |
| host 注册能力走 `ctx`，依赖用 `inject` 声明，组合用 `ctx.plugin(...)` | 规范 3/4/9.7 | 见 4.3 |
| 非内部可调参数做成配置字段 + `@deepseek-ai/schemastery` 的 `Schema.object` | 规范 7 | 阶段 0 补 config |
| bundle 目录含 `package.json`(dsh.bundle) + `cordis.patch.yml` + 构建产物，`patch` 用 `insert` | 规范 9.2 | 见第 3 节 |
| profile 接入：`dsh plugin --profile web add ./extensions/dsh-office` 或 `--patch` | 规范 11.1/11.2 | 阶段 0 |
| client 无 JSX、无 CSS modules、无图标库（用内联 SVG），样式用 `--dsw-alias-*` token | 规范 10.4/10.5 | 见第 6 节 |
| client 注入 hooks 命名按 `'use'+首字母大写`；hooks 只在组件顶层调用 | 规范 10.2/10.3 | 见第 6 节 |
| 第三方 client 数据/配置写走 **Typert Remote**，不碰 settings 白名单 | 规范 10.1 大坑 | 见第 6 节 |
| client 构建：`format:'cjs'`、`platform:'browser'`、`dts:false`、`clean:false`、只 external 平台模块、包 `window.__ModuleLoader__.load` 壳 | 调试指南第 3 节 | 阶段 0 落 tsdown.config.ts |

### 参考文档
- 工程规范：`docs/plugin-development.md`
- 调试指南：`docs/plugin-dev-debugging-guide.md`
- 参考实现：`extensions/im-gateway/`（host+client 双半范例）、`extensions/dsh-vision-toggle/`（typert remote + settings.section 范例）、`extensions/dsh-skill-manage/`