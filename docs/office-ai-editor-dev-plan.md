# Office AI 编辑器 — 开发计划（由简到难）

> 目标：在 dsh 桌面壳右侧面板内，提供「预览 + 轻编辑 + AI 修改」Word/Excel/PPT/PDF；AI 能创建真实 `.docx/.xlsx/.pptx`，用户点击产物展开编辑面板、选取区域生成文本引用（`月度支出!C11`），AI 据此修改并落盘真实格式。
>
> 详细方案见 `docs/office-ai-editor-plugin.md`；本文件是**可勾选的执行计划**，按里程碑递增难度，每步含验收标准。

---

## 现状核查（已核实）

- 桌面壳接入点：`src/main/profile-init.ts` 的 `PLUGIN_BUNDLES`（junction 链接）+ 根 `package.json` 的 `watch:plugins` 脚本 + 正式发布时声明 npm 依赖。
- 已有插件模板：`extensions/dsh-schedule-view`（Typert Remote 双半范例）、`extensions/dsh-vision-toggle`（settings.section + remote 范例）、`extensions/im-gateway`（host+client 双半）。
- **`dsh-file-manager` 已存在但 Office 三件套只走 `UnsupportedViewer`（仅下载提示，无内嵌预览）** — 预览半仍需我们新建插件。
- 参考项目：`dsh-plugin-better-sidebar-plugin-office`（渲染/转换层，由简到难直接用）；`DSH-better-sidebar`（调度/字节/兜底范式，语义换 Typert Remote）。
- **右侧面板挂载方式（对齐 dsh-term / file-manager）**：二者都是 client 侧对 `[data-dsh-frame]` 网格 `appendChild` 追加一列 DOM（非官方 slot）；会话 header 工具坞按钮走官方 slot `conversation.session.header.utilities` 注册，用跨插件事件 `dsh-dock:toggle-<name>` / `<name>-state` 开关（见 `dsh-term/src/client/index.ts`、`file-manager/src/client/index.ts` + `DockItem.tsx`）。我们的 office 编辑面板**照此挂载**：右列 = office 编辑器宿主，header dock = 开关注。
- 加载方式：本地开发用 `npm run dev`（`watch:plugins` 并行 tsdown --watch + electron 启动）；client 改动硬刷新生效，host 改动需重启。

---

## 里程碑总览

| # | 里程碑 | 难度 | 交付物 |
|---|---|---|---|
| M0 | 插件骨架 + 双半打通 | 低 | 空插件可加载，Typert Remote + settings.section 跑通 |
| M1 | 文件字节服务 + 多格式分发 | 低 | host `readFileBytes` + client 分发骨架 + 下载兜底 |
| M2 | PDF 预览（最简闭环） | 低 | pdf.js 渲染 + turnTail 产物卡片 |
| M3 | xlsx 预览 + 轻编辑 | 中 | SheetJS→Univer 渲染 + 点选引用 |
| M4 | AI 修改 xlsx 写回 | 中 | office_execute 工具 + SheetJS 写回真实 xlsx |
| M5 | docx 预览 + 字节保真写回 | 中高 | docx-engine + docx-preview |
| M6 | pptx 预览 + 写回 | 中 | pptx-renderer + pptx-engine |
| M7 | 打磨 + 发布 | 低 | 发布 npm + 接入桌面壳 |

> PDF（M2）最容易先跑通完整闭环（AI 生成→面板显示→AI 修改），作为验证「宿主骨架 + 面板 + 引用」的样板。xlsx（M3/M4）是用户最关心的「月度支出!C11」核心场景。

---

## M0 插件骨架 + 双半打通

**目标**：新建 `extensions/dsh-office`，空插件可在 `npm run dev` 下加载，Typert Remote + 设置页 section 验证双半通信。

**任务**
- [ ] 新建 `extensions/dsh-office` 工程骨架：`package.json` / `tsdown.config.ts` / `tsconfig.json` / `cordis.patch.yml`（对齐 `dsh-vision-toggle`，见方案 §3 的 package.json）。
- [ ] host 半 `src/index.ts`：`export const name/inject/apply`，空实现先能加载。
- [ ] client 半 `src/client/index.ts`：注入一个占位 `settings.section`（空标题），验证 client bundle 装载。
- [ ] 注册到工程：根 `package.json` 加 `watch:dsh-office`（`cd extensions/dsh-office && tsdown --watch`）+ 挂进 `watch:plugins`；`profile-init.ts` 的 `PLUGIN_BUNDLES` 加 `@lijian-ui/dsh-office`（本地先 file: 链接）。
- [ ] 打通 host→client Remote：host `remote.ts` 注册 `TypertRemoteService`（照抄 `dsh-schedule-view/src/remote.ts` 的 CONTRIBUTION + codec），client 侧 `remote.$mount` 调用一次返回版本号，settings.section 显示「office 0.x.y」。

**验收**：`npm run dev` 起，设置页出现「Office 编辑器」分区并显示来自 host Remote 的版本号；改 host 代码重启生效，改 client 代码硬刷新生效。

---

## M1 文件字节服务 + 多格式分发

**目标**：打通「client 要字节 → host 安全读取」链路 + 多格式匹配 + 下载兜底。

**任务**
- [ ] host `remote.ts` 增加 `readFileBytes(scope: { cwd, path }, opts): Promise<{ data: string /* base64 */ | ArrayBuffer, size, truncated? }>`。语义复刻 `DSH-better-sidebar` `/sidebar/file`：信任围栏（resolve 后必须落在 cwd 内）→ `stat` 是文件 → `size <= mediaLimit`（默认 20MB）→ 原始字节。
- [ ] （可选）`fsTree` / `isWithin` 工具：从 `src/fs-tree.ts`（参考项目）移植 `isWithin` + `resolveWithin` 纯函数用于围栏校验，避免路径穿越与 Windows 大小写误判。
- [ ] client 侧新建 `src/client/editors/registry.ts`：`{ exts, priority, detect?, load(scope,path), component }[]` + `matchEditor(path, head?)` 单趟优先级裁决（裁剪自 `DSH-better-sidebar` `matchFileViewer`）。
- [ ] 兜底 viewer：未知/失败类型渲染「下载查看」链接（`downloadBytes` 走 Remote base64→Blob 下载）。
- [ ] 一个最简真实 viewer 验证链路：如 `text`/`json` viewer（Remote 读字节 → textarea 展示），证明「字节链路 + registry + 兜底」闭环。

**验收**：右侧 office 面板能打开一个文本/JSON 文件并显示内容（用 `dsh-dock:toggle-office` 展开，或手工指定路径）；越权路径（`../`、乱 href）被拒；超大文件提示 + 下载兜底。

---

## M2 PDF 预览（最简完整闭环）

**目标**：AI 生成 PDF 产物 → 右侧面板渲染 →（后续）用户查看。作为「宿主骨架 + 产物卡片」样板。

**任务**
- [ ] 加 `pdfjs-dist` 依赖，实现 `src/client/editors/PdfEditor`（canvas 渲染，加载/错误/下载兜底三态，对齐参考项目 `office-view.tsx` 生命周期）。
- [ ] registry 注册 `{ exts: ['pdf'], priority: 0, ... }`。
- [ ] **turnTail 产物卡片**：client slot `conversation.chat.turnTail` 注入，检测回合产物含 office 类附件（.pdf/.docx/.xlsx/.pptx）时渲染可点击卡片，点击 → 在右侧 office 面板打开。
- [ ] **右侧面板容器（对齐 dsh-term）**：client 侧对 `[data-dsh-frame]` 网格 `appendChild` 追加右列作为 office 编辑器宿主（`findFrame()` + 幂等挂载，参考 `dsh-term/src/client/index.ts` 的 frame 探测），列内有「打开的 tab + 关闭」；会话 header 用官方 slot `conversation.session.header.utilities` 注册 dock 开关注（事件 `dsh-dock:toggle-office`），与 file-manager/dsh-term 平级。
- [ ] 验证闭环：给 LLM 一个生成 PDF 的任务，产物出现 → 点卡片 → 右列面板渲染。

**验收**：AI 生成 PDF → 产物卡片 → 面板渲染，页面能正常翻页/缩放。

---

## M3 xlsx 预览 + 轻编辑 + 引用标记

**目标**：对齐 WorkBuddy「月度支出!C11」：打开真实 `.xlsx` → Univer 渲染 → 点选选区生成文本引用。

**任务**
- [ ] 新增依赖：`xlsx`（SheetJS）、`@univerjs/presets`、`@univerjs/preset-sheets-core`（版本对齐参考项目 `dsh-plugin-better-sidebar-plugin-office/package.json` 的 `0.25.1`）。
- [ ] 移植 `xlsx-to-univer.ts` 纯转换函数（参考项目该文件，含单元格/公式/合并/列宽行高 → `IWorkbookData`）。
- [ ] 移植 `XlsxView` 渲染组件 → `src/client/editors/SheetEditor`；处理 Univer dispose（防 canvas/worker 泄漏）与错误降级下载。
- [ ] registry 注册 `{ exts: ['xlsx'], priority: 0 }`。
- [ ] 选区 → 文本引用：监听 Univer selectionChange，把选区 {sheetName, startRow/Col, endRow/Col} 转 `工作表名!C11` 或 `工作表名!A4:C5`，通过注入的 hook 冒泡到面板顶部（显示当前引用）+ 可一键插入输入框。
- [ ] 轻编辑：Univer 单元格编辑后，回收编辑后数据模型 → 前端内存态（编辑不落盘，仅用于后续 AI 修改的基线）。

**验收**：打开任意 `.xlsx` 正常渲染（公式计算、合并、多 sheet）；点选单元格/区域，面板显示 `月度支出!C11` 格式的引用文本并可复制插入输入框。

---

## M4 AI 修改 xlsx 写回真实文件

**目标**：模型拿到文本引用 → 调用编辑工具 → 写回真实 xlsx。

**任务**
- [x] host 侧工具 `office_execute`（对齐方案 §4.1 的 `defineTool` 规范：`parameters` + `output.schema`(对象带 `additionalProperties`) + `output.render` + `ctx.tools.register`，`inject=['tools']`）。
- [x] 编辑执行器：接收 `{ file, ref, value }`（如 `月度支出!C11 = 123`），用 SheetJS 内存模型读回 → 按 ref 解析行列（实现 `A1`/`A4:C5` 解析，参考 `xlsx-to-univer.ts` 的 `decodeAddr`）→ 写入 → `XLSX.write` 落盘。
- [x] 字节保真：改写仅在 target sheet 的单元格做 copy-on-write，其余 sheet 与 zip 条目原样保留（SheetJS `XLSX.write({ bookType:'xlsx' })`，评估是否需 exceljs 提升样式保真）。
- [x] skill `office` / `office-sheet`（`SKILL.md`）：教模型用 `sheet!ref` 语法定位，强调用结构化工具改、不直接改盘。
- [ ] 引用→AI 改→落盘 闭环联调：选择 月度支出!C11 → 拖入输入框 → 让 AI 改值 → 文件更新 → 重新打开面板看到新值。

**验收**：模型能根据 `月度支出!C11` 引用正确读取/修改单元格并落盘；用 Excel/官方打开验证格式未破、其他 sheet 未损坏。

---

## M5 docx 预览 + 字节保真写回

**目标**：Word 级排版预览 + AI 段落/表格修改 + 字节保真落盘。

**任务**
- [x] 依赖：`docx-preview`（预览，复用参考项目 `DocxView`）。写入引擎采用**自包含 JSZip**（`jszip`）手术式改 `word/document.xml` 单段文本，其余段落/zip 条目原样保留；暂不引入 GenOffice docx-engine（其依赖 pptx-engine+utif2，成本高），后续精细排版再升级。
- [x] `src/client/editors/DocEditor`：docx-preview 渲染 + 缩放（alt+滚轮 + 滑块）+ 加载/错误/下载三态。
- [x] registry 注册 `{ exts: ['docx'], priority: 0 }`。
- [ ] 引用标记：选中段落/表格可视化，转换成便于定位的标记（如段落索引或表格坐标，回退 `docx!段落N`）。
- [x] host `docx-engine` 封装：`parseDocxRef`（`段落N` 或段落内文本）+ `patchDocxText`（JSZip 字节保真改写，保留段落级样式与首 run 字体）。
- [x] `office_execute` 扩展支持 docx（按扩展名分派 `.xlsx/.docx`），skill `office-doc`（`src/host/skills/office-doc/SKILL.md`）。

**验收**：打开 `.docx` 保真渲染（样式/图片/表格）；让 AI 改一个段落文字或表格单元格，保存后 Word 打开不破版、其余内容不变。

---

## M6 pptx 预览 + 写回

**目标**：PPT 幻灯片预览 + AI 生成/修改幻灯片。

**任务**
- [x] 依赖：`@aiden0z/pptx-renderer`（预览，复用参考项目 `PptxView` 翻页导航）+ GenOffice `packages/pptx-engine`（本里程碑自包含 `src/host/engine/pptx.ts`，未引入 GenOffice）。
- [x] `src/client/SlideEditor.ts`（翻页预览 + 加载/错误/下载三态）+ registry 注册 `{ exts: ['pptx'], priority: 0 }` + FileView 分发 + i18n `slide.loading`。
- [x] host `pptx-engine`（parsePptxRef + patchPptxText，JSZip 改写 slideN.xml 目标 a:t）+ `office_execute` 支持 + skill `office-slide` + package.json 加 `@aiden0z/pptx-renderer`。
- [x] `npm run typecheck` + `npm run build` 通过（client bundle 因 renderer 内联 JSZip/ECharts 增至约 24MB，M7 可视体积再评估分包）。

**验收**：打开 `.pptx` 翻页预览正常；AI 能新增/修改幻灯片文本并落盘，官方 PowerPoint 打开不破版。

---

## M7 打磨 + 发布

**目标**：接入桌面壳正式发布，完成 i18n / 样式 / 设置开关 / 打包。

**任务**
- [ ] i18n：中英双语（对齐 `dsh-vision-toggle` 的 `client-i18n.ts` 模式）。
- [ ] 样式：统一用 `var(--dsw-alias-*)` token + 内联 SVG（对齐方案 §6 规范与 `docs/plugin-ui-style-guide.md`）。
- [ ] 设置开关：settings.section 提供各格式启用开关（对齐 finance M0 的 section）。
- [ ] 自查清单过一遍：对照 `docs/office-ai-editor-plugin.md` §9（tools schema / host inject / client 无 JSX / Typert Remote 不进 settings 白名单 / bundle 纯度）。
- [ ] 构建 + 发布 npm（官方源 `--access public`）+ 更新根 `package.json` 依赖为 `latest` + `profile-init.ts` PLUGIN_BUNDLES + `npm install`。
- [ ] 桌面壳重新提交 GitHub；插件仓库单独提交/发布。

**验收**：打包产物可安装即用，右侧面板 Office 三件套 + PDF 全部可用，设置开关生效，i18n 正常。

---

## 风险与依赖（执行时注意）

- **xlsx 样式保真**：SheetJS/exceljs 对字体/填充/边框保真有限；若商用场景要求高保真，再评估 GenOffice `apps/sheets` Rust sidecar（方案 §5.2 可选优化）。
- **docx 字节保真 UI**：Word 级分页/修订/批注映射浏览器编辑器是精细活，优先「文本/表格改动 + 保真落盘」，不做批注/修订 UI。
- **Univer/docx-preview 体积**：随动态 import 打进 client bundle，已验证参考项目可行；沿用其 tsdown browser-entry alias 处理（SheetJS/JSZip CJS 降级残留 Node builtin）。
- **GenOffice 未发布 npm**：起步复制 `src` 进 `vendor/`，后续再评估子依赖/发布。