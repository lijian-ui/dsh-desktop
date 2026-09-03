# DeepSeek Harness 桌面端 v0.5.0

> 发布日期：2026-09-03

## 核心亮点

**📄 办公文件高保真预览（OfficeCLI 集成）**

v0.5.0 内置 OfficeCLI 二进制，Word / PPT / Excel 预览从「渲染失真」升级为**原样高保真**：单元格填充色、日期/货币格式、合并单元格等细节完整还原，无需用户预装任何 Office 组件即可直接预览。

## 新增与改进

### 办公文件预览

- **内置 OfficeCLI**：桌面壳在打包时把单文件二进制放入 `resources/officecli/`，运行前自动注入到 dsh 子进程 PATH（开发版走项目根 `vendor/officecli/`，打包版走 `resources/officecli/`），用户零安装即用

- **Excel / Word / PPT 高保真预览**（file-manager 0.2.4）：经 `officecli view <file> html` 服务端渲染，在 iframe 中原样展示填充、日期、货币格式与合并单元格

- **Excel 区域选区引用**：只读 Excel 预览中单击单元格或拖选一片范围，即可「引用到对话」生成 `相对路径!Sheet名!Range` 引用

  <br />

### 自研插件内置

- **dsh-vision-toggle**：模型视觉能力开关插件内置，按模型单独切换视觉能力（镜像 npm `0.1.0`）

- **dsh-term**：PTY 终端插件内置（支持 npm 依赖加载方式）

- **pnpmp/浏览器探测**：打包内置 pnpm shim 与本机浏览器探测，`dsh web` 子进程自动识别可用的渲染浏览器

### 构建与依赖

- 全部自研插件统一以 **npm 依赖**形式接入（`latest` 自动跟随发布），发版后无需手动同步插件代码

- 固化 `--legacy-peer-deps`，解决 npm 静默崩溃与 peer 冲突

- 新增 `scripts/fetch-officecli.cjs`，打包前按 `win-x64 / mac-x64 / mac-arm64` 下载并分置 OfficeCLI 二进制（PS：macOS 分架构打包，非 universal）

## 支持平台

| 平台      | 架构          | 安装包             |
| ------- | ----------- | --------------- |
| Windows | x64         | NSIS 安装程序（.exe） |
| macOS   | x64 / arm64 | DMG             |

## 环境要求

- **无需预装 Node.js**（内置精简版运行时），也**无需预装 Office / OfficeCLI**

- Windows 10+ / macOS 12+

- 从源码构建的开发者请注意：Node.js 堆内存建议 ≥ 8GB（`NODE_OPTIONS=--max-old-space-size=8192`），且 `npm install` 需携带 `--legacy-peer-deps`

## 已知限制

- `.xls` / `.ods` 等旧格式暂以 SheetJS 只读表格展示（不支持区域选区引用）；`.xlsx` 走 OfficeCLI 高保真预览

- macOS 打包为 `x64`/`arm64` 分开产物，未提供 `universal` 通用包；若改用 `--universal` 打包需补充对应的 `mac-universal` OfficeCLI 目录

- macOS 安装包未做 Apple 开发者签名，首次打开需右键「打开」或按 README 指引放行 Gatekeeper

## 反馈

遇到问题请到 [GitHub Issues](https://github.com/lijian-ui/dsh-desktop/issues) 提交反馈，附上错误日志与复现步骤。
