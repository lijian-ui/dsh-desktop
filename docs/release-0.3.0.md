# DeepSeek Harness 桌面端 v0.3.0 发版说明

> 发布日期：2026-08-16 ｜ 上版本：v0.2.0

## 🎉 亮点：IM 网关离线集成（下载即用）

v0.3.0 将 **IM 网关插件（@lijian-ui/dsh-im-gateway）内置进桌面端**——安装包自带插件及其全部依赖，首次启动自动完成部署，**无需联网、无需手动装插件**：

- **钉钉**：出站 WebSocket 连接，群聊 + 单聊，**AI 卡片流式输出**（边生成边回复），@ 提及过滤
- **QQ**：官方 SDK WebSocket 网关，私聊 + 群聊，**扫码绑定机器人**（免去开放平台手动创建），私聊流式消息
- **个人微信**：iLink 长轮询协议，**扫码登录 + 配对码**，媒体收发

使用方式：设置 → 「IM 通道」→ 添加通道 → QQ/微信扫码绑定 或 钉钉填 AppKey/AppSecret → 保存即生效。

> 插件同时以独立形式发布：`dsh plugin --profile web add @lijian-ui/dsh-im-gateway`（npm / GitHub 双通道），不用桌面端也能接入。

## ✨ 新增功能

- **electron-updater 自动更新**：接入 GitHub Release 通道，新版本发布后应用内自动检测并更新（设置 → 关于 → 检查更新）
- **verify-deps 依赖守护**：打包前自动校验并补齐缺失的 peer 依赖，避免打包产物启动即缺模块
- **build-native 平台拆分包**：按目标平台（win / mac）补齐 sharp / libvips / koffi 等原生依赖拆分包

## 🛠️ 技术改进

- **profile 离线部署机制**（`src/main/profile-init.ts`）：首次启动自动创建 dsh profile、写入插件依赖与层栈、junction 链接插件实体——依赖从安装包内 node_modules 离线解析（`nodeLinker: hoisted` + NODE_PATH 兜底）
- **DSH_HOME 显式化**：统一指向 `~/.dsh`，消除父进程残留环境变量的不确定性（credentials 读取更稳）
- **信号退出兜底**：Ctrl+C / kill 时清理 dsh 子进程树，不再残留孤儿进程

## 📦 安装包

- Windows：`DeepSeek-Harness-0.3.0-Setup.exe`
- macOS：`DeepSeek-Harness-0.3.0-{x64|arm64}.dmg`

> 首次启动会自动完成 IM 插件部署（数秒内），控制台可见 `im-gateway profile 就绪` 日志。
