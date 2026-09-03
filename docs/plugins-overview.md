# 插件一览

本文档汇总桌面端集成各插件的功能说明（基于各插件 package.json / README）。

## 桌面端插件

| 插件 | 版本 | 类型 | 核心功能 |
|---|---|---|---|
| **dsh-schedule-view** (`@lijian-ui/dsh-schedule-view`) | 0.1.1 | ⏰ 定时任务 | 基于 cron/间隔的**定时任务**调度：Web 设置页纯 UI 管理、跨会话定时器、多级通知（任务触发/跳过/失败）；支持工作目录、模型/Provider 指定、补跑策略（错过后跳过或补跑）、单次任务自动禁用、运行历史 |
| **dsh-skill-manage** (`@lijian-ui/dsh-skill-manage`) | 0.1.4 | 🧩 技能管理 | 设置页**技能管理**面板：技能列表 / 启用停用 / 删除 / 添加、工作区技能扫描、技能详情预览、技能包 zip 导入、按会话维度管理 |
| **dsh-term** (`@lijian-ui/dsh-term`) | 0.3.2 | 🖥️ 终端 | 设置面板式**本地终端**：node-pty 真实 PTY、xterm.js 多标签页、默认工作目录开壳，支持终端内容引用到对话输入框 |
| **dsh-file-manager** (`@lijian-ui/dsh-file-manager`) | 0.2.3 | 📁 文件管理 | Web 右侧**文件管理面板**：Explorer + Preview 双栏（像素级对标 FileManager）、文件树、文件名搜索、git 变更视图、10+ 格式多标签预览；支持文件内容选择引用到对话输入框 |
| **im-gateway** (`@lijian-ui/dsh-im-gateway`) | 0.2.3 | 💬 IM 网关 | **多通道即时消息网关**：钉钉 / QQ / 个人微信(iLink) 接入，扫码绑定、流式回复、统一 `ctx.imGateway` 服务；多实例通道、通道状态管理 |
| **dsh-session-cleaner** (`@lijian-ui/dsh-session-cleaner`) | 0.1.5 | 🗂️ 会话管理 | **会话管理**设置页：会话列表（含标题）、点击预览最近消息、**真删除**（二次确认弹窗，非回收站）、官方归档能力（即时生效）/ 封存恢复、全部 / 已归档 / 游离分组 |
| **dsh-plugin-hub** (`dsh-plugin`) | 1.3.6 | 🏪 插件市场 | **社区插件市场**：Web 设置页内嵌应用商店，浏览 / 搜索 / 一键安装 4000+ 人工精选社区插件；内置 FIFO 串行安装队列、进度/日志流、取消/重试、待重启生效提示；依赖官方 `dsh plugin` CLI 与桌面壳内置 pnpm，无需用户预装环境 |

## 共同特点

- 全部以 **cordis 插件 + Typert RPC** 方式接入 dsh（host 服务 + Web client 双端包），热插拔，不改 dsh 源码
- 安装命令：`dsh plugin add <插件名>`（或 Web 设置面板 / 插件市场一键安装）
- 每个插件均附带中/英文 README，独立 Git 仓库 + npm 发布