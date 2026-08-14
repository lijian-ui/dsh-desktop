# DeepSeek Harness 桌面端 v0.1.0

> 发布日期：2026-08-14

## 简介

DeepSeek Harness 官方 Web 形态的 Electron 桌面壳。基于官方 npm 包 `@deepseek-ai/dsh` 构建，不引用、不改动官方任何源码，跟随官方 `npm update` 自动升级。

## 新增功能

- **完整桌面化**：Electron 壳 + 官方 dsh WebUI，独立窗口运行，无需浏览器
- **系统托盘常驻**：点击右上角关闭按钮最小化到系统托盘（Windows / macOS 同步），托盘菜单支持「显示主窗口 / 重启服务 / 退出」
- **中文菜单栏**：文件 / 编辑 / 视图 / 窗口 / 帮助，含「重启 dsh 服务」「关于」等桌面端专属动作
- **健壮性设计**：
  - dsh 子进程崩溃自动重启（指数退避，最多 5 次）
  - 端口冲突自动顺延（最多 10 次）
  - 页面加载超时 / 失败展示中文错误页，一键「重新连接」
  - 退出时按进程树清理，无孤儿进程
- **官方品牌图标**：DeepSeek Harness 黑色鲸鱼图标（多尺寸，Windows .ico / macOS 自动转换 icns）

## 支持的平台

| 平台 | 架构 | 安装包 |
|---|---|---|
| Windows | x64 | NSIS 安装程序（.exe） |
| macOS | x64 / arm64 | DMG / ZIP |

## 环境要求

- **系统 Node.js** `^22.19.0 || >=24.0.0`（dsh 官方硬性要求，由子进程使用）
- Windows 10+ / macOS 12+

## 已知限制

- 当前为 0.1.0 预览版，`@deepseek-ai/dsh` 处于 rc 阶段，官方升级可能带来破坏性变更，建议锁定版本
- 自动更新通道尚未接入，后续版本将通过 GitHub Release 提供

## 反馈

遇到问题请到 [GitHub Issues](https://github.com/lijian-ui/dsh-desktop/issues) 提交反馈，附上错误日志与复现步骤。
