# DeepSeek Harness 桌面端 v0.2.0

> 发布日期：2026-08-14

## 核心亮点

**🎉 内置 Node.js 运行时——开箱即用，无需用户安装 Node**

v0.2.0 在安装包内捆绑了精简版 Node.js 运行时（v24.19.0），彻底解决用户环境的 Node 依赖问题：

- 用户**不再需要预装 Node.js**，安装即用
- 不再受 nvm / Homebrew / 系统旧版 Node 的路径与版本问题困扰
- 子进程优先使用内置 Node，版本永远满足 dsh 的 `^22.19 || >=24` 要求

## 新增与改进

- **内置 Node 运行时**：打包版自动携带，用户环境零依赖
- **Node 路径探测增强**：
  - 内置 Node → `config.json` 的 `nodePath` → nvm → Homebrew → 官方路径，按序解析
  - 每个候选自动做版本校验，旧版（如系统 v18）自动跳过
- **修复 M 芯片（Apple Silicon）启动失败**：
  - koffi 平台拆分包自动补齐（`@koromix/koffi-darwin-arm64` 等）
  - sharp / libvips 平台包自动补齐（`@img/sharp-*`）
- **修复依赖收集遗漏**：dsh 的 108 个 peer 依赖（`@deepseek-ai/cordis-plugin-group` 等）全部随包分发，不再出现 `ERR_MODULE_NOT_FOUND`
- **错误信息更友好**：dsh 启动失败时直接展示其真实输出（最近 10 行），方便排查
- **系统托盘常驻**：关闭窗口最小化到托盘（Windows / macOS 同步），托盘菜单支持显示/重启/退出
- **中文菜单栏**：文件 / 编辑 / 视图 / 窗口 / 帮助，含「重启 dsh 服务」「关于」
- **健壮性设计**：子进程崩溃自动重启（指数退避）、端口冲突自动顺延、加载失败中文错误页 + 一键重连、退出按进程树清理

## 支持平台

| 平台 | 架构 | 安装包 |
|---|---|---|
| Windows | x64 | NSIS 安装程序（.exe） |
| macOS | x64 / arm64 | DMG |

## 环境要求

- **无需预装 Node.js**（v0.2.0 内置）
- Windows 10+ / macOS 12+

## 已知限制

- macOS 安装包未做 Apple 开发者签名，首次打开需右键「打开」或按 README 指引放行 Gatekeeper
- 自动更新通道尚未接入，后续版本将通过 GitHub Release 提供

## 反馈

遇到问题请到 [GitHub Issues](https://github.com/lijian-ui/dsh-desktop/issues) 提交反馈，附上错误日志与复现步骤。
