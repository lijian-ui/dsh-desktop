# DeepSeek Harness 桌面端 v0.3.0

> 发布日期：2026-08-16

## 核心亮点

**🎉 IM 网关离线集成——内置钉钉 / QQ / 个人微信，下载即用**

v0.3.0 将 IM 网关插件（@lijian-ui/dsh-im-gateway）完整内置进桌面端，插件及其全部依赖随安装包分发，首次启动自动完成部署，**无需联网、无需手动安装插件**：

- **钉钉**：出站 WebSocket 长连接，群聊 + 单聊，**AI 卡片流式输出**（边生成边回复），@ 提及过滤
- **QQ**：官方 SDK WebSocket 网关，私聊 + 群聊，**扫码绑定机器人**（免去开放平台手动创建），私聊流式消息
- **个人微信**：iLink 长轮询协议，**扫码登录 + 配对码**，媒体收发

使用：设置 → 「IM 通道」→ 添加通道 → QQ / 微信扫码绑定，或钉钉填 AppKey/AppSecret → 保存即生效。

> 插件同时以独立形式发布（npm / GitHub 双通道）：`dsh plugin --profile web add @lijian-ui/dsh-im-gateway`，不用桌面端也能接入。

## 新增与改进

- **IM 网关离线集成**
  - 插件内置：`@lijian-ui/dsh-im-gateway`（npm 0.1.x）随包分发，依赖离线解析（`nodeLinker: hoisted` + NODE_PATH 兜底）
  - 首次启动自动部署：`src/main/profile-init.ts` 创建 dsh profile、写入插件依赖与层栈、junction 链接插件实体，控制台可见 `im-gateway profile 就绪`
  - 多机器人实例：同一渠道可配置多个 bot，各自独立凭据
- **自动更新**：接入 electron-updater（GitHub Release 通道），新版本自动检测与更新（设置 → 关于 → 检查更新）
- **依赖守护**：verify-deps 打包前自动校验并补齐缺失的 peer 依赖，杜绝 `ERR_MODULE_NOT_FOUND`
- **原生依赖拆分包**：build-native 按目标平台（win / mac）补齐 sharp / libvips / koffi 等平台包
- **DSH_HOME 显式化**：统一指向 `~/.dsh`，消除父进程残留环境变量的不确定性（credentials 读取更稳）
- **信号退出兜底**：Ctrl+C / kill 时清理 dsh 子进程树，不再残留孤儿进程

## 支持平台

| 平台 | 架构 | 安装包 |
|---|---|---|
| Windows | x64 | NSIS 安装程序（.exe） |
| macOS | x64 / arm64 | DMG |

## 环境要求

- **无需预装 Node.js**（v0.2.0 起内置精简版运行时）
- Windows 10+ / macOS 12+

## 已知限制

- macOS 安装包未做 Apple 开发者签名，首次打开需右键「打开」或按 README 指引放行 Gatekeeper
- IM 网关的扫码登录依赖网络访问 QQ / 微信官方服务

## 反馈

遇到问题请到 [GitHub Issues](https://github.com/lijian-ui/dsh-desktop/issues) 提交反馈，附上错误日志与复现步骤。
