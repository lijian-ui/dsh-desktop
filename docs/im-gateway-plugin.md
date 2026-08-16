# DSH IM 网关插件开发文档

> 目标：在 dsh（deepseek-harness）桌面前端中，以**单一 npm bundle 插件**形式扩展 IM 网关能力，接入 **钉钉 / 个人维修 / QQ** 三个渠道，支持每渠道**多实例**（如多个钉钉机器人）。
> 方案来源：充分调研旧项目 `C:\Project\dsh-desktop\参考项目\pi-desk-top\` 的 IM 模块提炼设计契约，并结合 dsh 官方 cordis 插件框架落地。
> 前置阅读：本仓库 `docs/plugin-development.md`（cordis 插件基础：Service / Provider / Consumer 分层、事件、`defineTool`、配置、打包）。

---

## 0. 背景与核心决策

### 0.1 旧项目的成熟设计（直接复用）

`pi-desk-top` 已经有一套完整、经过实战打磨的 IM 模块，位于 `src/main/im/`：

| 文件 | 职责 |
| --- | --- |
| `im-gateway.ts` | 网关核心：渠道注册表、生命周期、会话路由、回复路由、斜杠命令解析、串行队列 |
| `types.ts` | 渠道无关契约：`ImChannelAdapter` / `ImInboundMessage` / `ImImage` / `ImStatus` |
| `im-config.ts` | 配置模型：`ImConfig` / `ImChannelInstance`（支持每渠道**多实例**） |
| `im-session-map.ts` | IM 会话 ↔ 底层会话文件的映射与持久化 |
| `dingtalk/*` | 钉钉适配器（WebSocket 长连接 + AI 卡片流式 + 媒体上传） |
| `qq/*` | QQ 适配器（QQ 开放平台 WebSocket + 内联键盘审批 + C2C 流式） |
| `weixin/*` | 微信适配器（iLink 长轮询 + 纯 `fetch` REST 封装 + 媒体加解密） |

**结论**：不要重写，要把这套设计"翻译"成 cordis 插件形态。契约（`types.ts`）、路由逻辑（`im-gateway.ts`）几乎可以原样搬进 `im-gateway` 插件；三个渠道适配器变成三个独立插件。

### 0.2 一个关键差异：旧项目没有"维修"渠道

旧项目只有 `dingtalk / weixin / qq` 三个渠道。**个人维修**渠道在旧代码里不存在。

处理方式：维修系统绝大多数是**自定义 REST/HTTP 接口**，因此以 `weixin/*` 适配器（纯 `fetch` 的 HTTP 长轮询客户端）为模板，而不是照抄钉钉/QQ 的 WebSocket 方案。文档第 3.3 节专门说明。

### 0.3 为什么收敛为**单一 bundle + 多实例 channels**（最终决定）

调研早期设想是"核心 + 每渠道独立 Provider 插件"，但实现时改为**单一 bundle `im-gateway` + channels 数组配置**，原因：

- **配置统一管理**：所有渠道配置在一个 settings namespace（`im-gateway`）下，用户 UI 一个页面就能管全部渠道实例。拆成三个独立插件意味着三个 settings namespace + 三个 web UI tab，用户体验分裂。
- **共享网关逻辑就一处**：ensureSession（live / resume / create 三查 + collision fallback）、模型选择注入、斜杠命令、会话路由——核心只一份。
- **多实例自然支持**：一个钉钉渠道可挂多个机器人（不同企业的多个钉钉群）；QQ 同理。channels 是 `Array<{id, type, name, enabled, config}>`，可任意增删实例，无需新发插件版本。
- **分发简单**：单一 npm 包 `dsh plugin add @lijian-ui/dsh-im-gateway` 一行安装，对齐 `dsh-skill-viewer` 的标准做法。

保留旧项目设计的精华：`ImChannelAdapter` 契约（types.ts）、串行队列、流式节流、回复路由——这些仍在 `im-gateway` 核心里以类/模块形式组织，**而不是独立插件包**。

---

## 1. 总体架构

```
                       ┌─────────────────────────────────────────────┐
                       │                dsh  host 进程                 │
                       │                                              │
  钉钉长连接 (出站 WS) │   im-gateway  (单一 bundle, Service+Consumer) │
  QQ 长连接 (出站 WS)  │   ├─ ctx.imGateway 服务                     │
  维修 REST (出站/ILink)│   │    registerChannel(adapter)              │
                       │   │    sendToChannel / status / 命令钩子     │
                       │   ├─ channels: Array<InstanceConfig>        │
                       │   │    ├─ dingtalk-6y0y (实例 1)             │
                       │   │    ├─ dingtail-2   (实例 2, 同型可多个) │
                       │   │    └─ qq-bot                            │
                       │   ├─ ensureSession 三查:                     │
                       │   │    ① ctx.agents.get(id) 复用            │
                       │   │    ② persistence 命中 → agents.resume    │
                       │   │    ③ fallback create + isIdCollision→resume│
                       │   ├─ 模型选择注入（installModelSelection）    │
                       │   │    ctx.agentDefaultModel.currentSelection│
                       │   ├─ 会话路由：im:<channelId>:<convId>      │
                       │   │    └─→ ctx.sessions (host 会话服务)      │
                       │   └─ 斜杠命令：/help /model /status /stop …  │
                       └─────────────────────────────────────────────┘

  钉钉 / QQ / 维修 → 各实现 ImChannelAdapter（同一 bundle 内的类）
                  → 启动时按 settings 配置实例化 + registerChannel
```

**三个角色（同一 bundle 内的模块边界）：**

| 角色 | 模块 | 职责 |
| --- | --- | --- |
| **Service Definition** | `gateway/types.ts` + `gateway/im-gateway.ts`（Service） | 定义 `ImChannelAdapter` 契约 + `ctx.imGateway` 服务 + 路由/命令/回复逻辑 |
| **Adapter Implementations** | `channels/dingtalk.ts` / `qq.ts` / `weixin.ts` | 实现 `ImChannelAdapter` 接口的不同渠道类，启动时按 `channels[]` 实例化 |
| **Consumer** | `gateway/im-gateway.ts` 内 | 消费底层 agent 会话事件，把回复送回渠道 |

扩展点（保留契约对外开放）：第三方插件可实现 `ImChannelAdapter` 接口后 `ctx.imGateway.registerChannel(myAdapter)`，无需 fork `im-gateway` 本身。

---

## 2. 网关核心插件：`im-gateway`

### 2.1 复用旧项目的契约（`types.ts` 原样搬入）

`ImChannelAdapter` 是整套设计的灵魂——**渠道只实现这个接口，其余全归网关**。完整字段（来自 `pi-desk-top/src/main/im/types.ts`）：

```ts
/** 渠道连接状态 */
export type ImStatus = "off" | "connecting" | "connected" | "error" | "expired";

/** 归一化后交给网关的图片（多模态输入） */
export interface ImImage {
  type: "image";
  data: string;        // base64
  mimeType: string;
}

/** 适配器归一化后的入站消息 */
export interface ImInboundMessage {
  channel: string;                          // 如 "dingtalk"
  sessionKey: string;                       // `${channel}:${instanceId}:${peer}`
  text: string;                             // 文本（媒体已被剥离为 images）
  images?: ImImage[];
  raw?: unknown;                            // 原始 payload，调试/扩展用
}

/** 一个渠道实例的连接 + 发送能力 */
export interface ImChannelAdapter {
  readonly channel: string;                 // 协议类型，如 "dingtalk"
  readonly instanceId: string;              // 每个机器人唯一，隔离会话
  readonly name: string;                    // UI 展示名

  start(): Promise<void>;                   // 连接（长连接/长轮询/扫码登录）
  stop(): Promise<void>;                    // 断开并释放资源
  getStatus(): ImStatus;

  /** 网关注册后注入 */
  onMessage?: (msg: ImInboundMessage) => void;
  onStatusChange?: (status: ImStatus) => void;

  /** 向 peer 发文本（target = sessionKey 里的原始 peer id） */
  sendText(target: string, text: string): Promise<void>;
  sendTyping?(target: string): Promise<void>;   // 可选"正在输入"

  /** 可选流式回复（如钉钉 AI 卡片）。text 为已累计的完整内容 */
  beginStream?(target: string): Promise<void>;
  streamText?(target: string, text: string, finished?: boolean): Promise<void>;
  endStream?(target: string, text: string): Promise<void>;

  /** 可选内联键盘审批（QQ 按钮）；无则回退纯文本 /allow /deny */
  sendKeyboard?(
    target: string,
    text: string,
    buttons: { id: string; label: string; style?: 1 | 2 }[],
  ): Promise<void>;
  /** 可选按钮点击回调（网关注入） */
  onInteraction?: (buttonId: string, userId?: string) => void;
}
```

### 2.2 网关服务定义（用 cordis `Service` 基类暴露 `ctx.imGateway`）

按官方"Service Definition"模式，`im-gateway` 继承 `Service`，对外提供注册与路由能力：

```ts
import { Service } from "@cordis/core";   // 或 @deepseek-ai/cordis 的导出

export interface ImGateway {
  /** Provider 插件调用：注册一个渠道实例 */
  registerChannel(adapter: ImChannelAdapter): void;
  /** 按 instanceId 找到适配器（用于主动推送，如定时任务完成通知） */
  adapterFor(instanceId: string): ImChannelAdapter | undefined;
  /** 渠道级 bash 审批请求 → 推到对应 peer */
  requestApproval(cwd: string, requestId: number, command: string): void;
  /** 查询所有渠道状态 */
  getStatus(): Record<string, ImStatus>;
  onStatusChange(cb: (s: Record<string, ImStatus>) => void): () => void;
}

export class ImGatewayService extends Service implements ImGateway {
  static readonly inject = [];   // 核心不依赖具体渠道；依赖 ctx.sessions（host 提供）
  // ... 内部实现见 2.4
}
```

**要点**：核心插件**不 import 任何渠道实现**。渠道通过 `ctx.imGateway.registerChannel(adapter)` 把自己挂上来（Provider → Service Definition 的标准做法，而非跨插件直接 import）。

### 2.3 配置：多实例模型（沿用旧设计）

旧 `im-config.ts` 的 `ImChannelInstance` 模型非常贴合 cordis：每个渠道可以有**多个机器人实例**，每个实例独立 `enabled`、独立凭据、独立默认工作区（`cwd`）。在 dsh 里，这份配置拆成两层：

- **核心插件**暴露一个轻量 `Config`：`{ channels: ChannelRegistration[] }`——只登记"装了哪些渠道实例 / 启用了哪些"，**不含任何密钥**。
- **每个渠道插件**暴露自己的 `Config`：`im-channel-dingtalk` 的 `Config` 是 `{ instances: [{ id, name, enabled, clientId, clientSecret, cwd?, approval? }] }`，密钥写在这里。

> 为什么密钥不进核心？因为 cordis 的 `Config` 按插件隔离、可被 `cordis.yml` patch 覆盖、且支持 HMR；把密钥锁在渠道插件里，既能单独开关又能单独配置，还天然适配你现有的"宿主注入环境变量 → 写入插件 Config"套路（见第 4.4 节）。

### 2.4 网关核心实现（对照 `im-gateway.ts`，移植要点）

把 `im-gateway.ts` 的 `ImGateway` 类逻辑搬进 `ImGatewayService`，关键模块：

**(a) 注册与生命周期**
```ts
private register(adapter: ImChannelAdapter) {
  adapter.onMessage = (m) => this.handleInbound(m).catch(err => console.error("[im]", err));
  adapter.onStatusChange = (s) => this.setChannelStatus(adapter.instanceId, s);
  adapter.onInteraction = (btn, uid) => this.handleApprovalInteraction(adapter, btn, uid);
  this.adapters.push(adapter);
}
```
- `applyConfig()`：`stopAll()` → 遍历启用的实例 → 校验凭据 → `adapter.start()`。
- 凭据校验（`hasValidConfig`）按 `channel` 分派：钉钉要 `clientId+clientSecret`；QQ/微信类扫码绑定要 `appId+appSecret` / `token+botId`。
- **🟡 配置变更重建（cordis 版实现）**：`src/sync.ts` 的 `syncChannels(ctx, fallback)` = 参考项目的 `applyConfig`——先 `ctx.imGateway.stopAll()`（`ImGatewayService.stopAll` 停止并清空所有 adapter）再按 settings 当前值重建注册。**boot 时 `index.ts` 的 `ctx.inject(['imGateway'])` 调一次；每次 `remote.saveConfig`（设置页保存）成功后也调一次**。缺了这个机制，扫码绑定保存配置后运行中的 adapter 仍是启动时的空凭据实例（`start()` 里 `credentials missing` 直接 return 永不连接），表现为"绑定成功但无法对话/消息到不了 im-gateway"。抽到独立 `sync.ts` 是因为 index → remote 双向 import 会成环。

**(b) 会话路由（与 dsh 的接缝，见第 2.5 节）**
- 旧代码：`sessionMap.ensureSession(key, cwd)` 创建底层会话文件，`piManager.prompt(...)` 驱动。
- dsh：用 `ctx.sessions.create(id, { meta: { cwd } })` + `session.prompt(parts, 'queue')`。
- `sessionKey` 约定不变：`${channel}:${instanceId}:${peer}`（钉钉 `conversationId`/staffId；QQ `c2c:openid`/`group:openid`；维修按系统返回的会话标识）。

**(c) 串行队列（群聊必备）**
旧代码 `queues: Map<sessionPath, QueuedInbound[]>`，同一会话（尤其群聊）的消息严格按到达顺序 A→B→C 处理，绝不交织。`drainQueue` 在 `prompt()` 的回合结束（`agent_end`）后才取下一条。**这段逻辑渠道无关，原样保留。**

**(d) 斜杠命令（网关级消费，绝不进 LLM）**
`handleCommand` 处理：`/help`、`/model [名称|编号]`、`/status`、`/stop`、`/reset|/clear|/new`、`/compact`、`/allow|/deny|/allow_session|/allow_always <id>`（bash 审批回复）。未知命令才 fall through 到 agent。钉钉/QQ 的 ActionCard/键盘按钮点击也会翻译为 `allow:3` 这类指令走同一通道。

**(e) 回复路由（流式回传）**
旧 `handlePiEvent` 监听 agent 事件，把回复送回渠道。**这是与 dsh 对接的另一半接缝**（事件名沿用 `message_start` / `message_update(text_delta)` / `tool_execution_start` / `agent_end`），见 2.5。

### 2.5 与 dsh agent 的集成接缝（最关键，务必对齐）

旧项目直接调 `PiDeskSessionManager`（`prompt/newSession/imForwarder`）。在 dsh 里，agent 由 **host 会话服务** 驱动。经调研 `参考项目/deepseek-harness` 确认：

| 旧 pi-desk-top | dsh cordis（host 提供） | 说明 |
| --- | --- | --- |
| `piManager.newSession(cwd)` | `ctx.sessions.create(id, { meta: { cwd } })` | 创建/确保会话绑定到工作区 |
| `piManager.prompt(text, images, cwd, sessionPath)` | `session.prompt(parts, 'queue')` | 喂一条用户消息 |
| `piManager.imForwarder = fn` 钩子 | 订阅**会话作用域**的 conversation 事件 | 接收流式回复 |

**入站消息 → agent：**
```ts
import type { PromptContentPart } from "@deepseek-ai/dsh-host-apiproxy/api";

// 旧 ImImage { type:'image', data: base64, mimeType }
// 直接映射为 dsh 的 PromptContentPart：
function toPromptParts(text: string, images?: ImImage[]): PromptContentPart[] {
  const parts: PromptContentPart[] = [{ type: "text", text }];
  for (const img of images ?? []) {
    parts.push({ type: "image", mediaType: img.mimeType as any, data: img.data });
  }
  return parts;
}

const session = ctx.sessions.get(sessionId)!;     // 或 create
await session.prompt(toPromptParts(userText, images), "queue");
```

`PromptContentPart` 的确切定义（`packages/host/apiproxy/src/api/sessions.ts:87`）：
```ts
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; data: string; name?: string };
```
> `data` 为 base64 字符串，与旧 `ImImage.data` 一致，无需转码。

**agent 回复 → 渠道（事件订阅）：**
旧 `im-gateway.handlePiEvent` 用的事件名（`message_start` / `message_update` 里的 `text_delta` / `tool_execution_start` / `agent_end`）与 dsh 的 agent 事件流同名。在 dsh 里，这些事件在**会话作用域**内可用（`conversationEvents` / 会话 scope 的 `ctx.on`）。网关在 `prompt` 前，对目标会话 scope 注册监听：

```ts
// 概念代码：对某一 sessionId 注册流式监听（具体 API 以 harness 会话作用域事件为准）
const scopedCtx = ctx.sessions.scope(sessionId);   // 取得会话作用域 ctx
scopedCtx.on("message_start", (e) => { /* assistant 回合开始 → beginStream */ });
scopedCtx.on("message_update", (e) => { /* text_delta → streamText（节流） */ });
scopedCtx.on("tool_execution_start", (e) => { /* 显示"正在调用工具" */ });
scopedCtx.on("agent_end", (e) => { /* 回合真正结束 → endStream 最终文本 */ });
```

> ⚠️ **待验证清单（这是唯一需要你对照 harness 实际 API 确认的接缝）**：
> 1. 会话作用域事件的确切订阅方式（`ctx.sessions.scope(id)` 是否返回带 `on` 的作用域 ctx，还是走 `conversationEvents.subscribe`）。
> 2. 事件载荷字段名是否与旧代码完全一致（`message?.role`、`assistantMessageEvent?.delta`、`toolName`、`messages`）。
> 3. 图片 `data` 的精确编码（base64 还是 data URL）。
> 4. `prompt` 的 `mode`：`'queue'`（追加到当前回合后）对应旧代码的普通消息；`'steer'`（打断当前回合）对应 `/stop` 后的新指令——按需选择。
>
> 这几点是"翻译"而非"重写"，旧 `handlePiEvent` 的节流（钉钉 800ms / 1K 帧）、卡片最终化、`agent_end` 才收尾等逻辑可直接复用。

**(f) bash 审批桥接（与 harness 审批事件对接）**
旧代码通过 `piManager.onChannelApprovalRequest` / `handleBashApprovalResponse` 把渠道变成 bash 命令的审批终端。在 dsh 里，网关应订阅 harness 的 `approval/requested` 会话事件，转成渠道消息（`sendKeyboard` 或 `/allow /deny` 文本），按钮/文本回传后调用 harness 的审批响应接口。这部分以 harness 的审批事件契约为准，结构照搬旧 `sendApprovalRequest` / `handleApprovalInteraction`。

---

## 3. 渠道插件（Provider）

### 3.1 通用骨架

每个渠道插件都是标准 cordis 插件，且**只关心自己平台的协议**：

```ts
import { defineConfig } from "@cordis/core";   // Schemastery
import { Context } from "@cordis/core";
import { ImChannelAdapter } from "im-gateway";   // 类型（类型可安全 import）

export const Config = defineConfig({
  instances: [{
    id: "dingtalk-default",
    name: "公司钉钉机器人",
    enabled: false,
    clientId: "",
    clientSecret: "",
    cwd: "",           // 可选默认工作区
    approval: "off",    // "on" | "off"
  }],
});

export function apply(ctx: Context, config: typeof Config) {
  const im = ctx.imGateway;   // inject im-gateway 服务
  for (const inst of config.instances) {
    if (!inst.enabled) continue;
    if (!inst.clientId || !inst.clientSecret) {
      ctx.logger.warn(`dingtalk ${inst.name} 缺少凭据，跳过`);
      continue;
    }
    const adapter = new DingtalkAdapter(inst);
    im.registerChannel(adapter);
    ctx.on("ready", () => void adapter.start().catch(...));
    ctx.on("dispose", () => void adapter.stop().catch(...));   // cordis 自动清理
  }
}
```

**关键收益（来自 cordis 生命周期）**：`adapter.stop`、`onMessage` 监听器等在插件卸载时被 cordis 自动回收（`ctx.effect`），不用像旧代码那样手写 `stopAll`——但**长连接/定时器/外部资源**仍需在 `stop()` 里显式释放（见旧 `DingtalkConnection.stop`）。

### 3.2 钉钉渠道：`im-channel-dingtalk`

**参考源码**：`pi-desk-top/src/main/im/dingtalk/*`
- `dingtalk-adapter.ts`：消息归一化（text/picture/richText/audio/file → `ImInboundMessage`）、媒体上传、AI 卡片流式。
- `dingtalk-connection.ts`：`dingtalk-stream` WebSocket 长连接（无需公网回调 URL）、心跳 10s/超时 20s、指数退避重连 + jitter、5 分钟 TTL 去重。
- `dingtalk-card.ts` / `dingtalk-reply.ts` / `dingtalk-media.ts`：AI 卡片流式、文本/图片/文件发送、媒体上传下载。

**移植要点：**
1. **连接是出站的**：`dingtalk-stream` 走 WebSocket 长连，业务机器人在内网/本机即可，**不需要在 dsh 里开 webhook**。直接复用 `DingtalkConnection`。
2. **AI 卡片流式限制**（钉钉特有坑）：单帧 ≤ ~1K、总内容 ≤ ~3K，超出会被 `***` 截断。旧代码用 `STREAM_THROTTLE_MS=800` 合并 delta、整段累加发送、`agent_end` 才 finalize。逻辑原样搬。
3. **媒体**：本地路径/Markdown 图片语法 → 上传为独立媒体消息（钉钉 markdown 不渲染内联图），文本替换为占位 note。复用 `collectAndSendMedia`。
4. **群聊 @**：群消息必须 @ 机器人（`isInAtList`）才处理；回复走 `sessionWebhook`（唯一尊重 `at` 的通道）。
5. **鉴权**：`clientId` / `clientSecret` → 由宿主环境变量注入进插件 `Config`（见 4.4）。

**Config schema 字段**：`id / name / enabled / clientId / clientSecret / cwd? / approval?`。

### 3.3 个人微信渠道：`im-channel-weixin`（iLink 协议，扫码登录）

**定位**：个人微信接入。iLink（`ilinkai.weixin.qq.com`）是微信官方的个人微信 bot 协议——扫码绑定一个个人微信号，单聊协议（一个 bot 绑一个号，无群聊）。**代码标识统一为 `weixin`（早期曾用 `weixiu`，2026-08-16 全局改名，含文件名 `weixin.ts`）**，显示名"个人微信"。

**参考源码**（pi-desk-top `weixin/*`）：
- `weixin-api.ts`：**零依赖纯 `fetch` 的 CGI 封装**（`apiGetFetch` / `apiPostFetch` / `getUpdates` 长轮询 / `sendMessage` / `getConfig` / `sendTyping` / `notifyStart` / `notifyStop`）。
- `weixin-adapter.ts`：长轮询循环（`schedulePoll` + `pollOnce`）、退避重连、上下文 token 持久化（`contextTokens`）、`sendMediaForText`（本地路径→上传）、`sendTyping` 心跳。
- `weixin-media.ts` / `markdown-filter.ts`：AES-128-ECB 媒体上传下载加解密、Markdown 过滤（微信不渲染 md）。
- `weixin-login.ts`：扫码登录 + 配对码（`get_bot_qrcode` → 长轮询 `get_qrcode_status` → confirmed 拿 token/botId）。

**接入形态**：纯出站长轮询，不需要 webhook，和钉钉/QQ 一样不依赖 dsh 的 webserver。HTTP 层用 `apiGetFetch`/`apiPostFetch`（含 `AbortController` 超时）。

**扫码登录流程**（设置页 → 添加通道 → 选"个人微信" → 「扫码登录」）：
1. host `remote.ts` `startQrLogin('weixin')` → `weixin-login.startLogin()`：请求 `get_bot_qrcode` 拿二维码 → `QRCode.toDataURL` 渲染成图片
2. client 轮询 `getQrLoginStatus`：`wait`→`scaned`→**`need_verifycode`（配对码，client 弹输入框）**→`confirmed`（token+ilink_bot_id+baseurl）
3. confirmed 后 client **自动填入 token/botId/baseUrl**，保存即生效
4. 二维码过期（`expired`）自动刷新最多 3 次；`scaned_but_redirect` 切换 baseUrl；`binded_redirect` 表示已绑定过
5. `session expired`（getupdates errcode -14）→ 暂停 5min + 状态标 error，UI 提示重新扫码

**Config schema 字段**：`id / name / enabled / token / botId / baseUrl / cdnBaseUrl / pollIntervalMs`。设置页**隐藏凭据输入框**（只扫码绑定，2026-08-16 起）。

### 3.4 QQ 渠道：`im-channel-qq`

**参考源码**：`pi-desk-top/src/main/im/qq/*`
- `qq-adapter.ts`：`@tencent-connect/qqbot-nodejs`（QQ 开放平台，WebSocket 传输）。c2c（单聊）与 group（群聊）区分；群聊仅处理 @ 机器人的消息；内联键盘审批；**C2C 流式**（`StreamSession`），群聊不支持流式（回退 `sendText`）。
- `qq-login.ts`：扫码绑定（写 `appId`/`appSecret` 到配置）。

**移植要点：**
1. **连接出站**：WebSocket，无需 webhook。
2. **`@bot` 过滤**：群消息只有 `mentions[].is_you === true` 才处理（避免噪声）。
3. **内联键盘审批**：`sendKeyboard` 用 `sendTextWithKeyboard`，按钮 `action.type=1` 触发 `interaction` 事件，网关在 `onInteraction` 里识别 `allow:3` 等。
4. **流式 replace-mode 坑**：QQ 流式为"整体替换"，模型改写历史前缀会 reject——旧代码捕获后禁用该流、回退 `sendText`。原样保留。
5. **鉴权**：`appId` / `appSecret`（扫码绑定写入配置），环境变量注入。

**Config schema 字段**：`id / name / enabled / appId / appSecret / cwd? / approval?`。

---

## 4. 配置与打包

### 4.1 单一 Config + channels 数组（多实例）

单一 bundle `im-gateway` 导出一个 Schemastery `Config`，所有渠道实例都登记在 `channels: Array<ChannelInstance>` 字段里。每条实例含：

```ts
{
  id: string           // 唯一 id，如 'dingtalk-6y0y' / 'qq-bot'
  type: 'dingtalk' | 'qq' | 'weixin'
  name: string         // 用户显示名
  enabled: boolean     // 单独开关该实例
  config: { ... }      // 该渠道该实例的具体凭据（clientId/secret/token/...）
}
```

`im-gateway` 的 `[Service.init]` 遍历 `channels`，按 `type` 实例化对应渠道 adapter（`new DingtalkAdapter(sctx, instance.config)` 等），`enabled=true` 的调 `ctx.imGateway.registerChannel(adapter)`。

**用户当前实例**（`~/.dsh/settings.yaml` 的 `im-gateway.channels`）：
```yaml
- id: dingtalk-6y0y
  type: dingtalk
  name: 钉钉1
  enabled: true
  config:
    clientId: dinguji8zdoaqyepp714
    clientSecret: ...
```
可继续追加同型新实例（如 `dingtail-2` 第二个钉钉机器人）或异型实例（`qq-bot`）。

### 4.2 bundle 打包（单一 bundle）

`extensions/im-gateway/` 是**单一 npm 包** `@lijian-ui/dsh-im-gateway`，`package.json` 声明 `dsh.bundle.patch` + `dsh.client` + `exports["./client"]`，按官方标准做法分发：

```bash
# 本地包（开发期联调，pnpm link 到本地源码目录）
dsh plugin --profile web add ./extensions/im-gateway

# 发布后
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

具体见 `plugin-development.md` §11.2 与 §9 节（bundle 概念）。

### 4.3 接入你的桌面壳

桌面壳 `config.json` 只需设 profile：

```json
{ "profile": "web", "port": 0 }
```

桌面壳 `buildDshEnv`（`src/main/config.ts`）会显式设 `DSH_HOME = ~/.dsh`（消除父进程 DSH_HOME 残留），并把 `DEEPSEEK_API_KEY` 环境变量（来自 `config.apiKey` 或系统环境）注入 dsh 子进程。

### 4.4 凭据注入（两路并存）

**途径 A：通过 `config.json` 的 `apiKey`**（明文，已 gitignore，**仅本地开发**）
```json
{ "profile": "web", "apiKey": "sk-..." }
```
桌面壳 buildDshEnv 注入 `DEEPSEEK_API_KEY` 环境变量。

**途径 B：通过 `~/.dsh/.credentials.yaml`**（web Models 页面写入，文件权限 0600）
```yaml
DEEPSEEK_API_KEY: sk-...
```
dsh-credentials-local 服务（`$DSH_HOME/.credentials.yaml`）自动读取。
3. 渠道插件只读 `config`，不碰环境变量——保持"配置与代码分离"。

---

## 5. 开发落地清单与关键坑

> 下列条目均来自旧项目实战，搬代码时逐条对照。

- [x] **🟢 钉钉 AI 卡片流式输出（beginStream/streamText/endStream 三方法生命周期）**：分层——**协议层** `src/channels/dingtalk-card.ts`（port 自参考项目，HTTP 用 node 全局 fetch 替代 axios）：`createDingtalkCard`（POST /v1.0/card/instances + /deliver，模板沿用钉钉官方 `02fcf2f4-5e02-4a85-b672-46d1f715543e.schema`）→ `streamDingtalkCard`（PUT /v1.0/card/streaming 增量帧，INPUTING 状态）→ `finishDingtalkCard`（FINISHED PUT 收尾）；全局 token bucket 20 QPS + QPS 错误 2s backoff 重试。**🟡 协议层超时/errcode 坑**：所有卡片 API 调用必须走 `cardFetch()` 统一封装——①**10s 硬超时**（AbortController）：无超时的话 FINISHED PUT 挂起 → `endStream` 的 await 永不 resolve → `.catch` 里的 sendText 兜底永不触发 → **agent 跑完但用户看不到任何回复（完全静默）**，这是"实现卡片后 LLM 不回复"的真凶；②**业务错误码检查**：钉钉经常 HTTP 200 + `errcode`/`errorCode` != 0，只查 `res.ok` 会把失败的 FINISHED 当成功，卡片永远转圈。**🟡 cordis logger 默认吞日志坑**：cordis `LoggerService` 构造时注册的默认 exporter **只把日志 push 进内存 buffer**（`cordis/lib/index.js` `self.buffer.push(message)`），全量搜 `@deepseek-ai` 下没有任何包注册终端/console exporter——`ctx.logger.*` 的日志**永远不会出现在 dsh 控制台**！插件必须在 apply 里注册 console exporter（见 `src/index.ts` 的 `installConsoleLoggerExporter`），把 message 转成 `console.*`（→ dsh 子进程 stderr → 桌面壳 `[dsh]` 前缀 → Electron 终端）。否则调试全靠猜。**契约层** `types.ts`：`ImChannelAdapter` 新增可选 `beginStream?(convId)` / `streamText?(convId, text, finished?)` / `endStream?(convId, text)`——不实现的渠道（QQ/维修）自动退化为 `sendText`。**渠道层** `dingtalk.ts`：`cards: Map<convId, AICardInstance|null>` 管理生命周期，创建失败 fallback `⏳ 正在思考…`，流式失败删卡、收尾时无卡则 `sendText` 兜底，群聊收尾加 `@昵称` 前缀。**网关层** `im-gateway.ts`：`turn/start` → 只重置累积器（**不 beginStream**——dsh 的 turn/start 在 agent 开始处理用户消息时就触发，此时 assistant 还没输出，开流会让 QQ 客户端挂连接中）；**第一个 `assistant/chunk` text-delta → `beginStream`**（对齐参考项目 `message_start` 语义，`streamStarted` Map 去重）；`assistant/chunk` text-delta → 累积 + `streamThrottleMs` 节流 → `streamText`；`tool/call` → 有流式渠道在卡片上覆盖显示 `🔧 正在调用工具：…`（下一帧文本替换）；`turn/end` → `endStream`（无文本时也调用，传 `✅ 已完成（无文本输出）`，避免卡片挂 INPUTING；长文本 >1K 跳过 streaming 终帧直接 FINISHED PUT——`skipStreamFinalize`）。**🟡 收尾时机坑**：必须用 `turn/end`（=参考项目的 `agent_end`）收卡，不能收到中间文本就 FINISHED；参考项目注释强调 `message_end` 每 assistant turn 都触发不可用，dsh 的 turn 语义天然规避了这点。**🟡 开流时机坑（QQ连接中真凶）**：不要在 `turn/start` 开流（agent 还没输出，客户端挂连接中），要等第一个 text-delta。**🟡 QQ 流式收尾坑**：QQ `StreamSession` 一旦在服务端注册，endStream 必须无条件关闭（complete → DONE / cancel）——哪怕流式中途失败（REPLACE-mode 拒绝）也要 cancel，否则客户端永远连接中。**🟡 卡片限流坑**：单帧约 1K，超过会截断成 `***`，所以 `streamText` 走节流（800ms）+ 收尾长文本跳过终帧。
- [ ] **群聊串行队列**：同一会话并发消息必须 A→B→C，`drainQueue` 在 `agent_end` 后才取下一条。
- [ ] **群聊 @ 过滤**：钉钉 `isInAtList`、QQ `mentions[].is_you`，否则噪声淹没。
- [ ] **媒体本地路径处理**：agent 回复里的本地图片/文件路径 → 上传为独立媒体消息，文本替换为 `[图片]` / `[文件已发送：x]`（三渠道都有 `sendMediaForText`/`collectAndSendMedia`，逻辑相通）。
- [ ] **会话 cwd 持久化与迁移**：旧 `ImSessionMap.migrate` 支持把会话挪到新工作区；dsh 用 `ctx.sessions` 的 `meta.cwd`，迁移语义对应。
- [ ] **审批交互闭环**：`approval/requested` → 渠道键盘/`/allow /deny` 文本 → 按钮/文本回传 → harness 审批响应。
- [ ] **连接健壮性**：心跳、指数退避 + jitter、消息去重（钉钉 5min TTL）、状态机（`off/connecting/connected/error/expired`）。
- [ ] **长连接/定时器显式释放**：`stop()` 里 `clearInterval` / `disconnect` / `clearTimeout`，否则 cordis 卸载后仍泄漏。
- [ ] **🔴 与 harness 会话 API 对齐**：第 2.5 节"待验证清单"4 条——这是翻译期唯一需要实地确认的点，建议先写一个最小 PoC（钉钉单渠道 → `ctx.sessions.create` → `prompt` → 订阅事件 → `sendText`）跑通再扩展。
- [x] **🔴 会话在 sidebar 的渲染（workspace 分组 + 归档过滤）**：dsh sidebar 按 Host Workspace 分组，且会过滤两类会话——`archivedSessionIds`（归档）与 `origin==="subagent"`。IM 会话用裸 `ctx.agents.create({ meta: { cwd } })` 创建，**不会**自动进入任何 workspace 的 `sessionIds`（workspace 的自动 bootstrap 只在首次初始化跑一次，早于 IM 会话产生），所以它会落到「未分组 Ungrouped」。要让 IM 会话显示在正确项目组，创建/resume 后必须显式 `workspaceRegistry.resolveByPath(cwd)` + `workspace.attachSession(sessionId)`（cwd 无 workspace 时先 `create(cwd)`）——已在 `ensureSessionInner` 三个分支统一补上 `attachToWorkspace`（best-effort，try-catch 兜底，绝不影响 IM 回合）。**另一坑**：归档会话被 `sessionVisible` 直接过滤（完全不显示），且 dsh **没有**取消归档 API；归档数据存于 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，误归档后需停 dsh 进程、备份并改该文件移除对应 id、再重启。
- [x] **🔴 会话日志 seq 断档损坏（多进程/孤儿进程写坏）**：dsh 会话日志是 append-only 的多帧 `session.jsonl.zstd`，每个事件的 `seq` 必须从 0 密集连续——`dsh-session-persistence-jsonl` 的 `SessionLogScanner` 校验 `event.seq !== events.length` 即抛 `corrupt session log: seq gap`。**多个 dsh 进程同时写同一个 session（典型是孤儿进程：开发期 Ctrl+C 退出不触发 Electron 的 `before-quit`，dsh 子进程残留，各自 resume 同一 IM 会话并 append）会让 seq 重叠，日志损坏、history 加载失败**。排查/修复：用 `node:zlib` 的 `zstdDecompressSync` + 自己实现 `scanZstdFrames` 逐帧解压看 seq 序列，定位回退点（seq 突然变小处），然后**截断到回退点之前的帧边界**（zstd 每帧独立压缩，截断必须卡在帧边界、不能乱切），再清 `~/.dsh/storages/session_projcache.json` 里该 id 的过期投影。根治：单实例锁 + 退出时强杀 dsh 进程树（见 plugin-development.md 孤儿进程一节）。
- [x] **🟢 公共 slash 命令（网关核心层，跨渠道通用）**：`/help`、`/reset` `/clear` `/new`（重置会话）、`/model`（无参列出 `ctx.llm.listProviders()/listModels()/resolveModelInfo()` 编出的模型目录并标出当前；带参 `编号 | 模型名 | provider/model` 切换）、`/status`（渠道 + `cwd` + 当前模型 + agent 运行状态）、`/stop`（调用 `handle.agent.cancel({kind:'user'},{keepInbox:true})` 中止当前轮次）。**模型选择优先级（`current` getter 链路）**：`会话级 override`（`modelOverrides.get(sessionId)`）→ `全局默认 override`（`globalModelOverride`）→ `agentDefaultModel.currentSelection()`。所以"全局默认"是会话级覆盖缺位时的兜底——**用户在没建立会话时发的 `/model <名称>` 直接写到 `globalModelOverride`，下次第一次发消息时自动套用**。模型切换原理等同于官方 `session.selectModel`：`installModelSelection` 时把 ref 存进 `modelRefs`，setter 落地到 `modelOverrides` 映射，prompt 组装读取的就是这个 ref 的 `current`。`/model <名称>` 在有会话时会同步 push `ref.current = ...` 让下一句立即生效。**reasoningEffort（推理力度）暂未通过 /model 切换**（沿用默认）。**🟡 harness API 形状坑（/model 完全静默的真凶）**：`@deepseek-ai/dsh-llm` 的 `LlmRuntime.listProviders()` 是**同步方法**（`index.js:1022` 直接 `return [...this.adapters.values()]...`，不是 Promise）！对它 `await ... .catch(() => [])` 会抛 `TypeError: ...catch is not a function`，异常被上层吞掉 → `/model` **完全静默无回包**（`/help`、`/status` 不走 `listAvailableModels` 所以正常）。正确写法：`const providers = llm.listProviders() ?? []`（同步取），只有 `listModels(p)` 才是 async。**教训：写插件调 harness service 前，先翻 node_modules 里该方法源码确认同步/异步形状，`.catch()` 只对 Promise 有效。** **🟡 异常兜底**：`handleInbound` 的 slash 分支已包 try/catch——命令失败会回一条 `⚠️ 命令执行失败：<detail>` 而不是静默（静默排障成本太高）。**🟡 会话依赖语义**：`/help`、`/status` 不依赖 session；`/model` 无参列目录不依赖 session；`/model <名称>` **也**不依赖 session——无会话时写到 `globalModelOverride`、提示"已设置默认模型，下次建立会话生效"；`/new` 无会话是 no-op；`/stop` 无 handle 提示"没有进行中的会话"。**🟡 输出格式陷阱（钉钉）**：钉钉 `markdown` 消息的纯文本会吞掉所有 `\n`——只有 markdown 结构（list / blockquote / heading）才会换行。所以 `/help`、`/status`、`/model` 这种多行回复必须用 markdown list（每行 `- xxx`）而不是 `\n` 拼字符串；短单行提示（"✅ 已切换"）不受影响。一旦发现换行不生效，**先**查这条，不是 char 编码也不是模板字符串问题。**🟡 钉钉 markdown 有序编号坑（/model 列表专用）**：写 `- 1. xxx`、`- 2. xxx` 时，钉钉 markdown 渲染会把两个 list item 的序号**统一覆盖成同一个值**（实际两个 item 都显示 `2.`），用户根本分不清选哪个。**必须**用 emoji 数字代替 ASCII 数字：`- 1️⃣ xxx`、`- 2️⃣ xxx`。emoji 是纯文本，markdown 引擎不会去重置，且视觉差异明显。其他 list（`/help`、`/status`）不用编号所以不踩。
- [x] **🟢 群聊 senderNick/@**：`ImInboundMessage` 新增 `senderNick`/`isGroup`；钉钉适配器在 `handleRaw` 填这两个字段，并在群聊时给 inbound 文本加 `[@昵称]` 前缀让 agent 区分说话人，回复 markdown 也加 `@昵称` 前缀（钉钉 `sessionWebhook` 的 `at` 仍负责真正的 @ 视觉）。群聊仍只在被 @ 时响应（`isInAtList` 过滤）。**🟡 群聊斜杠命令坑**：钉钉群聊 @ 机器人后，原始 `text.content` 会带前导 `@机器人 ` 前缀（如 `@机器人 /model`），导致网关 `startsWith('/')` 判定 false、整个命令 fall through 进 LLM。已修：钉钉适配器 `handleRaw` 在文本落定后调 `stripLeadingMention()` 剥掉前导 `@name`（sender 归属仍由 `senderNick` 保留）；网关 `handleInbound` 的判定也从 `startsWith('/')` 改为 `trimStart().startsWith('/')` 双保险。**单聊不受影响**（单聊文本就是纯 `/model`，无需剥）。
- [x] **🟢 通道状态广播（设置页在线/离线/错误）**：`ImChannelAdapter` 新增可选 `statusListener(status: ChannelStatus)`；网关 `registerChannel` 时挂上，适配器在连接成功/断开/失败/未配置时调用，状态存入 `channelStatuses` 快照；host 端 `remote.ts` 新增 `getChannelStatuses()`（Typert `imGatewayRemote` 命名空间），client 端 `config-api.ts` 加 `statuses()`、设置页 `ImChannelsSection` 每 5 秒轮询并在每个通道卡片前渲染状态点（绿=online / 灰=offline / 红=error）。
- [x] **🟢 QQ 渠道完整移植（扫码绑定 + WebSocket 网关 + 流式）**：`qq-login.ts`（`@tencent-connect/qqbot-connector` 的 `startQrConnect` 扫码绑定机器人，成功回调返回 appId+appSecret，UI 轮询快照）+ `qq.ts`（`@tencent-connect/qqbot-nodejs` 的 QQBot：WebSocket 网关、`tokenPrefetch:'async'` 防阻塞、`bot.start()` 5s 超时兜底、指数退避重连；c2c 私聊 + group 群聊仅处理 @bot；引用回复注入、语音 ASR 转文字、入站图片下载 base64；出站 `sendMediaForText` 检测本地图片/文件路径上传；流式 `beginStream/streamText/endStream` 仅 c2c（QQ stream_messages 是 c2c-scoped），group 直接 sendText 兜底，REPLACE-mode 前缀变更失败时禁用流式回退）。**🟡 依赖**：新增 `@tencent-connect/qqbot-nodejs`、`@tencent-connect/qqbot-connector`、`qrcode`（动态 import，ESM 包勿静态引入 host bundle）。**🟡 交互按钮**：QQ `interaction` 事件 → 合成 `[按钮点击] btnId` 入站消息（审批闭环的基础）。
- [x] **🟢 微信(iLink)渠道完整移植（扫码 + 配对码 + 长轮询 + 媒体加解密）**：`weixin-login.ts`（ilink `get_bot_qrcode` 拿二维码 → 长轮询 `get_qrcode_status`：scaned/confirmed/need_verifycode 配对码/expired 刷新 QR 最多 3 次/scaned_but_redirect 切换 baseUrl/binded_redirect；confirmed 返回 token+ilink_bot_id+baseurl+ilink_user_id）+ `weixin-api.ts`（纯 fetch，`iLink-App-Id: bot` 固定头、`X-WECHAT-UIN` 随机、`Authorization: Bearer <token>`；getupdates 长轮询 35s 超时视为空响应、session expired errcode -14 暂停 5min）+ `weixin-types.ts` + `weixin-media.ts`（入站 AES-128-ECB 解密 CDN 图片；出站加密上传 + getuploadurl；`parseAesKey` 两种编码：16 raw bytes 或 32-char hex）+ `markdown-filter.ts`（流式 markdown 过滤，微信不渲染 markdown，CJK 斜体/加粗剥标记、图片删除、代码围栏透传）+ `weixin.ts`（适配器：长轮询 poll、`context_token` 每会话持久化到 `~/.dsh/im-gateway/`、sendTyping 每 5s keepalive、sendText 过 markdown-filter、媒体路径替换）。**🟡 单聊专用**：iLink 微信是单聊协议（一个个人微信绑一个 bot），无群聊。**🟡 扫码 UI**：`ImChannelModal` 加扫码区块（qq/weixin 类型显示「扫码登录」按钮 → 二维码 → 微信配对码输入框 → 成功后自动填凭据字段），host `remote.ts` 加 `startQrLogin/getQrLoginStatus/submitQrVerifyCode/cancelQrLogin` 4 个 Typert 方法。

---

## 6. 附录：旧项目源码索引（抄代码用）

| 想要的能力 | 直接看 |
| --- | --- |
| 渠道契约 | `pi-desk-top/src/main/im/types.ts` |
| 网关路由/命令/串行队列/回复路由 | `pi-desk-top/src/main/im/im-gateway.ts` |
| 多实例配置模型 | `pi-desk-top/src/main/im/im-config.ts` |
| 会话映射与持久化 | `pi-desk-top/src/main/im/im-session-map.ts` |
| 钉钉：长连接/卡片/媒体 | `pi-desk-top/src/main/im/dingtalk/*` |
| QQ：WebSocket/键盘/流式 | `pi-desk-top/src/main/im/qq/*` |
| **维修（REST 模板）**：纯 fetch / 长轮询 / 媒体 | `pi-desk-top/src/main/im/weixin/*` |
| dsh 会话服务（接缝） | `deepseek-harness/packages/host/apiproxy/src/api/sessions.ts`（`PromptContentPart`、`sessions.prompt`）、`packages/client/runtime/src/client/sessions/{service,manager,session}.ts`（`ctx.sessions`、`create`、`prompt`） |
| cordis 插件基础 | 本仓库 `docs/plugin-development.md` |

---

### 一句话总结

把旧 `im/` 模块"翻译"成 cordis 插件：`im-gateway`（核心，承载 `types.ts` + `im-gateway.ts` 的全部渠道无关逻辑，并对齐 dsh 的 `ctx.sessions`）做 Service Definition + Consumer；钉钉/QQ 照搬各自适配器做 Provider；维修渠道以微信适配器为 REST 模板新建。三者逻辑独立、配置隔离、可单独开关与分发。**唯一需要实地验证的接缝是第 2.5 节的 harness 会话事件订阅方式**——建议先跑通钉钉最小 PoC。
