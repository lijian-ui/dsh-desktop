# DeepSeek Harness 桌面端 v0.4.0

> 发布日期：2026-08-26

## 核心亮点

**🔧 内核对齐 DSH 官方 0.1.1-rc.2，构建链路全面加固**

v0.4.0 是一个维护性版本：运行时内核与官方 deepseek-harness 最新发布版（0.1.1-rc.2）完整对齐，同时修复了 Windows 环境下的构建脚本兼容性问题，并补全了一批此前靠「侥幸」生效的幽灵依赖声明，打包产物的完整性从此有制度保证。

## 新增与改进

### 运行时与依赖

- **DSH 内核对齐 0.1.1-rc.2**：全部 `@deepseek-ai/*` 依赖统一至官方最新 rc 版本
- **跟进官方包拆分**：预置 `dsh-file-reference` / `dsh-session-reference` / `dsh-tool-todo` / `dsh-client-ui-layout` 等新版拆分包
- **消除幽灵依赖**：源码直接引用的 `dsh-base`、`dsh-web-app` 此前未在 dependencies 中声明（靠 npm 提升机制侥幸生效），现已显式声明，electron-builder 打包不再有缺包风险
- **补充构建依赖**：`lightningcss` 进入根 devDependencies（扩展插件 tsdown 配置所需）

### 开发体验

- **插件热更新完善**：`npm run dev` 自动并行监听全部 6 个扩展插件，改代码即自动构建
- **Windows 脚本兼容修复**：watch 脚本改为 `cd <目录> && tsdown --watch` 写法——旧写法使用 POSIX 分号分隔符并以 node 直接执行 sh 包装脚本，在 cmd.exe 下必然失败（「系统找不到指定的路径」）
- **安装脚本治理**：通过 `npm approve-scripts` 显式批准 electron / node-pty / koffi 等原生模块的安装脚本，符合新版 npm 安全策略

## 支持平台

| 平台 | 架构 | 安装包 |
|---|---|---|
| Windows | x64 | NSIS 安装程序（.exe） |
| macOS | x64 / arm64 | DMG |

## 环境要求

- **无需预装 Node.js**（内置精简版运行时）
- Windows 10+ / macOS 12+
- 从源码构建的开发者请注意：Node.js 堆内存建议 ≥ 8GB（`NODE_OPTIONS=--max-old-space-size=8192`），且 `npm install` 需携带 `--legacy-peer-deps`

## 已知限制

- macOS 安装包未做 Apple 开发者签名，首次打开需右键「打开」或按 README 指引放行 Gatekeeper
- IM 网关的扫码登录依赖网络访问 QQ / 微信官方服务
- 官方 SDK（`@deepseek-ai/dsh-sdk-client`）尚处 pre-release 阶段，本版本暂不基于它构建，桌面壳继续沿用 spawn web 子进程方案

## 反馈

遇到问题请到 [GitHub Issues](https://github.com/lijian-ui/dsh-desktop/issues) 提交反馈，附上错误日志与复现步骤。
