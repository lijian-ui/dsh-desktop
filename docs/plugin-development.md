# DSH 插件开发指南

> 适用对象：在 `dsh-desktop`（DeepSeek Harness 桌面端，方案 A）基础上扩展功能的开发者。
> 本文档综合官方文档（<https://deepseek-harness.github.io/deepseek-harness/develop/>）与官方代码库（`参考项目/deepseek-harness/`）整理而成，聚焦"插件到底怎么写、怎么加载、怎么分发、怎么接进你的桌面壳"。

---

## 0. 背景与定位：桌面壳和插件系统的关系

你的项目（`dsh-desktop`）是官方 DeepSeek Harness 的 **Electron 桌面壳（方案 A）**：

- 桌面主进程通过子进程 `spawn` 官方 `dsh web`，再把它的本地 HTTP 页面（`http://127.0.0.1:<port>`）加载进 `BrowserWindow`。
- 原则：**不引用、不改动官方 dsh 任何源码**，只消费官方 npm 包（`@deepseek-ai/dsh`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` 等），跟随 `npm update` 升级。

这意味着：**扩展功能的唯一正规途径，就是为官方 harness 开发"插件（plugin）"**。插件不是改桌面壳代码，也不是改官方源码，而是一个由官方 cordis 框架加载的 TypeScript 模块（及其配置层）。桌面壳要做的，只是让它启动的那个 `dsh web` 进程"带上"你的插件。

所以本指南分成两半：

- **上半部分（第 1–9 节）**：官方 harness 的插件机制本身 —— 怎么写、怎么声明依赖、怎么开发工具、怎么配置、怎么用 `cordis.yml` 加载、怎么打包分发。
- **下半部分**：
  - **第 10 节**：dshClient —— 给插件开发 Web UI 配置面板（浏览器端 half，含两个实测坑）。
  - **第 11 节**：怎么把你写的插件接进 `dsh-desktop` 这个桌面壳。

---

## 1. 插件是什么

在 Harness 中，**插件是一个导出 `apply` 函数的 TypeScript 模块**。框架在加载时调用 `apply`，并传入一个 `ctx`（上下文对象）；你通过 `ctx` 注册能力（工具、事件监听、服务、定时器……）。

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context) {
  // 在这里注册能力。
}
```

这就是一份完整插件的最小骨架。`name` 用于在日志和配置中标识插件；`apply` 是入口。

---

## 2. 插件的三种形态

除了上面的**函数形式**，插件还支持**对象形式**和**类形式**。

### 2.1 函数形式（最常用）

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'
export const inject = ['tools'] // 声明依赖（见第 4 节）

export function apply(ctx: Context) {
  // ctx.tools 已就绪。
}
```

### 2.2 对象形式

```ts
import type { Context } from '@deepseek-ai/cordis'

export default {
  name: 'my-plugin',
  inject: ['tools'],
  apply(ctx: Context) {
    // ...
  },
}
```

### 2.3 类形式（向其它插件提供服务时用）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MyService extends Service {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'myService') // 'myService' 是该服务的名字
    // 在构造函数里做同步初始化。
  }
}
```

> **经验法则**：绝大多数插件用函数形式就够了。只有当你的插件需要**把一个能力作为服务暴露给其它插件**时，才用类形式（详见第 4 节）。

---

## 3. 上下文对象 `ctx` 与生命周期

`ctx` 是来自 `@deepseek-ai/cordis` 的 `Context`。插件通过它访问所有内置服务和注册能力。

### 3.1 自动清理

通过 `ctx` 注册的任何东西 —— 事件监听、工具、定时器 —— 在插件**卸载时都会被自动清理**。你**不需要**手动 `removeListener` 或 `clearInterval`。这正是 cordis 框架相比于裸写事件监听的核心好处。

```ts
export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    // 这个监听器会在插件卸载时被自动移除。
  })
}
```

### 3.2 需要手动清理的资源：`ctx.effect()`

如果你持有需要手动清理的资源（例如一个网络连接、一个文件句柄），用 `ctx.effect()` 告诉框架"如何清理"：

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log('heartbeat')
    }, 5000)

    // 返回的函数在插件卸载时运行。
    return () => clearInterval(timer)
  })
}
```

> 注意：依赖（`inject`）声明的服务在 `apply` 运行前就已就绪，所以插件之间还能用 `ctx.plugin(OtherPlugin, config)` 这种"组合（composition）"方式互相挂载子插件（见下文第 9 节与 `agent-spine-demo` 示例）。

---

## 4. 依赖与服务（Services）

### 4.1 什么是服务

在 Harness 中，`tools`、`llm`、`agents`、`fs` 等都是**服务（Service）**——即挂载在 `ctx` 上的命名能力：

```ts
ctx.tools    // ToolRuntime 服务
ctx.llm      // LLM 服务
ctx.agents   // Agent 服务
ctx.fs       // 文件系统服务
```

**任何插件都可以提供服务，供其它插件使用。**

### 4.2 使用已有服务：声明 `inject`

```ts
export const inject = ['tools']

export function apply(ctx: Context) {
  // apply 执行时，inject 声明的服务已经全部就绪。
  ctx.tools.register(/* ... */)
}
```

框架保证：在 `apply` 执行时，`inject` 声明的服务都已就绪。如果某个服务还没准备好，你的插件会**等待**，不会执行。

### 4.3 提供新服务：继承 `Service` 基类

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

export default class MetricsService extends Service {
  static inject = ['llm'] // 一个服务也可以依赖其它服务

  constructor(ctx: Context) {
    super(ctx, 'metrics') // 'metrics' 是服务名
  }

  // 公开的服务方法：
  record(event: string, value: number) {
    // ...
  }
}
```

加载这个插件后，消费方就可以通过 `ctx.metrics` 访问它：

```ts
export const inject = ['metrics']

export function apply(ctx: Context) {
  ctx.metrics.record('tool_call', 1)
}
```

### 4.4 类型声明（声明合并让 `ctx.metrics` 有正确类型）

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}

export default class MetricsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'metrics')
  }

  record(event: string, value: number) { /* ... */ }
}
```

### 4.5 必需依赖 vs 可选依赖

```ts
// 必需：服务缺失时，本插件不加载。
export const inject = ['tools']

// 可选：不写 inject，在使用处用 ctx.get() 查询。
export function apply(ctx: Context) {
  const metrics = ctx.get('metrics')
  metrics?.record('plugin_loaded', 1) // 不存在则跳过。
}
```

### 4.6 服务在运行期消失时的行为

如果运行期间某项**必需**服务消失（例如它的提供方卸载）：

1. 依赖它的插件会自动 `dispose`（释放资源）；
2. 当服务重新出现时，插件自动重新加载。

这能防止插件调用一个已经不存在的服务。

### 4.7 服务隔离（多实例）

`cordis.yml` 支持**服务隔离**——同一个服务可以有多个实例，不同插件组看到不同实例：

```yaml
- id: group-a
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 5000
    - name: './src/plugin-a.ts'

- id: group-b
  name: '@deepseek-ai/cordis-plugin-group'
  group: true
  isolate:
    shell: true
  config:
    - name: '@deepseek-ai/dsh-bash-local'
      config:
        timeoutMs: 60000
    - name: './src/plugin-b.ts'
```

`plugin-a` 和 `plugin-b` 各自看到自己组内的 Bash 实例，互不影响。

### 4.8 常用内置服务速查

下表来自官方 `@deepseek-ai/dsh-*` 包；**实际公开方法与签名请以源码和官方"子系统（subsystems）"文档为准**，不要维护一份静态清单。

| 服务名（推断） | 来源包 | 用途 |
| --- | --- | --- |
| `tools` | `@deepseek-ai/dsh-tools` | 工具注册表（`ctx.tools.register(defineTool(...))`） |
| `llm` | `@deepseek-ai/dsh-llm` | LLM 适配与调用 |
| `agents` | `@deepseek-ai/dsh-agent` | Agent 注册表 |
| `fs` | `@deepseek-ai/dsh-fs` | 文件系统后端（`ctx.fs.readText/streamText` 等） |
| `session` | `@deepseek-ai/dsh-session` | 会话存储 |
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | 系统提示组装（`ctx.systemPrompt.section(...)`） |
| `settings` | `@deepseek-ai/dsh-settings` | 用户设置 |
| `jobs` | `@deepseek-ai/dsh-jobs` | 后台任务 |
| `skill` | `@deepseek-ai/dsh-skill` | 技能注册 |
| `goal` | `@deepseek-ai/dsh-goal` | 目标域 |
| `scope` | `@deepseek-ai/dsh-scope` | 作用域隔离 |
| `codeRuntime` | `@deepseek-ai/dsh-code-runtime` | 代码运行时（`run_code` 工具后端） |
| `approval` | `@deepseek-ai/dsh-user-approval` | 用户审批（可选） |
| `userQuestions` | `@deepseek-ai/dsh-user-questions` | 向用户提问 |

---

## 5. 事件系统

事件是 cordis 插件之间**松耦合通信**的核心机制。Harness 大量使用事件来实现扩展点。

### 5.1 基本用法

```ts
// 监听
ctx.on('event-name', (payload) => { /* ... */ })

// 触发
ctx.emit('event-name', payload)
```

### 5.2 四种事件模式

| 模式 | 调用 | 语义 |
| --- | --- | --- |
| **emit（广播）** | `ctx.emit('name', payload)` | 所有监听器同步执行，返回值被忽略 |
| **bail（短路）** | `const r = ctx.bail('check', input)` | 监听器按顺序执行，第一个非 `null/false/undefined` 的返回值成为结果 |
| **serial（顺序）** | `await ctx.serial('setup', ctxArg)` | 监听器依次执行并等待异步结果；第一个非 `null/false/undefined` 的返回值终止后续 |
| **waterfall（流水线）** | `await ctx.waterfall('transform', input, async () => input)` | 每个监听器可包装下游返回值；**必须调用 `next()`** 否则短路整条流水线（用于拦截/网关） |

```ts
// bail 示例：返回任意值即停止后续监听器。
ctx.on('some-check', (input) => {
  if (shouldBlock(input)) return 'blocked'
  // 返回 null/false/undefined 继续下一个监听器。
})

// waterfall 示例：next() 是强制的。
ctx.on('my-plugin/transform', async (_input, next) => {
  const downstream = await next()
  return downstream.trim()
})
```

### 5.3 类型安全的事件

```ts
import '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready': (payload: { id: string }) => void
    'my-plugin/check': (input: string) => boolean | undefined
    'my-plugin/transform': (input: string, next: () => Promise<string>) => Promise<string>
  }
}
```

### 5.4 命名约定与监听器即 effect

- Cordis 事件遵循 `namespace/action` 命名，例如 `agent/step`、`agent/request`、`agent/request-error`、`tools/result`、`session/event`。
- **监听器也是 effect**：通过 `ctx.on()` 注册的监听器会在插件卸载时自动移除（见第 3 节）。
- `turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久化的会话事件类型**，不是同名 Cordis 事件。要观察它们，监听 `session/event` 并检查 `event.type`。

### 5.5 示例：日志插件

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tools'

export const name = 'tool-logger'

export function apply(ctx: Context) {
  ctx.on('tools/result', (exec, result) => {
    console.log(`[tool] ${exec.name}(${JSON.stringify(exec.arguments)})`)
    const text = result.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    console.log(`[tool result] ${text.slice(0, 100)}`)
  })
}
```

---

## 6. 开发工具（Tool）—— 最常见的扩展方式

工具是模型可以直接调用的能力。注册工具用 `defineTool` + `ctx.tools.register`。

### 6.1 最小工具示例

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: {
      name: { type: 'string', required: true, description: 'The name to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

- `inject` 让 cordis 等待工具注册表就绪。
- `defineTool` 根据 `parameters` 推导并校验 `args` 的类型。
- `execute` 返回 `output.schema` 声明的**规范值（canonical value）**；`output.render` 再将该值转换为面向模型的内容（`ContentBlock[]`）。

### 6.2 `defineTool` 完整字段说明

取自官方 `packages/core/tools/src/schema.ts` 的 `DefineToolOptions`：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | 工具名（必须唯一） |
| `description` | `string` | 是 | 发给模型的人类可读描述 |
| `parameters` | 参数 schema | 是 | 每个属性的参数 schema，编译成隐式开放对象根；用 `required: true` 标记必填 |
| `output.schema` | value schema | 是 | 成功结果执行时强制校验的**规范输出 schema** |
| `output.render` | `(args, value) => ContentBlock[]` | 是 | 纯函数：把一个已校验的规范值渲染成面向模型的 Native 内容 |
| `output.presentationMeta?` | `(args, value) => JsonValue` | 否 | 纯函数：为顶层调用生成可回放的展示元数据（用于 UI 卡片回放） |
| `timeoutMs?` | `number` | 否 | 可选的正向协作超时预算（毫秒），必须为正整数 |
| `isConcurrencySafe?` | `(args) => boolean` | 否 | 纯函数：判断该调用能否加入并行组（用于兄弟调用重叠） |
| `execute` | `(args, exec) => Promise<value>` | 是 | 参数校验后执行；返回 `output.schema` 声明的规范值 |
| `finalizeContent?` | `(exec, result) => ContentBlock[] \| undefined` | 否 | 对每个归一化结果的"最后一公里"内容变换（参数保持 `unknown`，含非法输入也会到达） |
| `presentCall?` | `(args) => ToolCallView \| undefined` | 否 | 待执行状态的纯展示器；返回 `undefined` 则用通用卡片 |
| `presentResult?` | `(args, result) => ToolResultView \| undefined` | 否 | 完成状态的纯展示器 |

> 关键点：**`execute` 返回的是结构化的规范值，`render` 才决定模型"看到"什么**。这使得模型输入稳定、UI 展示与回放可独立演化。

### 6.3 参数 schema（value schema DSL）

`parameters` 与 `output.schema` 使用同一套"作者面向"的 value schema DSL，类型如下：

| `type` | 额外关键字 | 说明 |
| --- | --- | --- |
| `'string'` | `enum?`, `const?` | 字符串 |
| `'number'` | `enum?`, `const?` | 有限浮点数 |
| `'integer'` | `enum?`, `const?` | 整数 |
| `'boolean'` | `enum?`, `const?` | 布尔 |
| `'null'` | `enum?`, `const?` | null |
| `'array'` | `items?` | 数组；省略 `items` 接受任意 lossless JSON 项 |
| `'object'` | `properties?`, `additionalProperties` | **对象必须显式声明 `additionalProperties: true\|false`**（强制开放性，避免意外默认） |
| `'json'` | — | 无约束的 lossless JSON 节点 |
| `oneOf` | `oneOf: [A, B, ...]`（至少 2 个） | 精确"其一"联合 |

每个节点都可带注解：`description`、`title`、`default`、`examples`。

### 6.4 真实工具示例（节选自官方 `packages/fs/tool-fs/src/read.ts` 的 `read` 工具）

这个示例展示了生产级工具的常见做法：参数校验、流式读取、规范输出对象、模型渲染、回放元数据、取消信号。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'

export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  // 给系统提示增加一段引导文字（order 控制段落顺序）。
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell commands like cat — to inspect text files. ...',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read.' },
      offset: { type: 'number', description: '1-based first line. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines. Defaults to caps.limit.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,             // 对象必须显式声明开放性
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatReadOutput(value.path, value) }],
      presentationMeta: (_args, value) => ({
        path: value.path, offset: value.offset,
        lines: value.lines.map(({ number, text }) => ({ number, text })),
        totalLines: value.totalLines,
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit)
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)
      // 大文件或大小未知时流式读取；exec.signal 用于取消。
      const chunks = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [await ctx.fs.readText(target, exec.signal)]
      // ... 组装规范输出对象并返回 ...
      return { path: target.displayPath, offset: input.offset, lines: window.lines, totalLines: window.totalLines }
    },
  }))
}
```

要点：

- `exec` 是 `ToolRunContext`，携带取消信号（`exec.signal`）、调用者、嵌套数据等，用于协作取消与遥测。
- 通过 `ctx.systemPrompt.section(...)` 给工具附加系统提示段落。
- `presentationMeta` 把结构化结果投影成可回放元数据，使 UI 卡片在会话回放时也能正确渲染。

---

## 7. 插件配置（Config）

让插件接受用户在 `cordis.yml` 中传入的配置。

### 7.1 定义 Config 类型 + Schemastery schema

```ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'my-plugin'

export interface Config {
  greeting: string
  maxRetries: number
  verbose?: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  console.log(config.greeting) // 用户值或 schema 默认值。
}
```

在插件行里传入配置：

```yaml
- insert:
    - id: hello
      name: './src/my-plugin.ts'
      config:
        greeting: 'Hi there'
        maxRetries: 5
```

插件加载时，cordis 会用导出的 schema **校验配置并填充缺失字段的默认值**。

> ⚠️ **不要**导出普通对象作为 `Config`——它必须满足 cordis 要求的 Standard Schema 接口（用 `@deepseek-ai/schemastery` 的 `Schema.object(...)` 即可）。

### 7.2 严格校验

```ts
export const Config = Schema.object({
  apiKey: Schema.string().required(),
  timeout: Schema.number().default(30000),
  mode: Schema.union(['fast', 'accurate']).default('fast'),
})
```

schema 在插件加载时执行校验；配置不合法会导致插件**加载失败并给出明确错误信息**。

### 7.3 设计原则

- **无硬编码可调参数**：凡是不同部署可能需要不同值的参数，都必须定义为配置字段。检验标准："能否在 `cordis.yml` 中改变这个值而不改代码？"
- **配置错误要响亮**：在 schema 中表达自身完备的约束，让无效配置在加载时失败。对服务或已注册资源的引用用依赖注入（见第 4 节）。

### 7.4 配合 HMR

配置变更会触发插件热替换：修改 `cordis.yml` 中某插件的 `config` 后，框架会卸载旧实例并加载新实例。由于注册都属于 effect 并自动清理，替换后不会残留旧实例的注册。

---

## 8. 加载机制：`cordis.yml` 与 patch overlay

插件本身是代码，而"哪些插件被加载、以什么配置加载"由 **`cordis.yml` 配置层**决定。

### 8.1 本地调试：用 `--patch` 叠加本地插件

在仓库（或任意目录）创建一个 patch 文件，把本地 TS 模块作为插件插入：

```yaml
- insert:
    - id: hello
      name: '/absolute/path/to/deepseek-harness/scratch-plugin/src/my-plugin.ts'
```

- 插件路径**必须是绝对路径**（patch 只贡献配置，不改变 loader 解析模块路径所用的 profile 目录）。
- 用该 overlay 启动：

  ```bash
  # 从源码运行（官方 monorepo）：
  pnpm dsh web --patch ./scratch-plugin/cordis.yml
  # 已安装 dsh CLI 时：
  dsh web --patch ./scratch-plugin/cordis.yml
  ```

- 打开 `http://127.0.0.1:3080`，启动期间终端会打印插件的加载日志。

### 8.2 patch 是"层"，不是"树"

patch 文件本质是**一个 patch 条目的 YAML 数组**：

```yaml
# 按 id 覆盖前面层的某行（整行 config 被替换，而非深合并）：
- id: webserver
  config:
    host: 127.0.0.1
    port: 3081

# 插入新插件行：
- insert:
    - id: cordis-host-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: tool-cordis
      name: '@deepseek-ai/dsh-tool-cordis'
```

- **后应用的层按行胜出**；patch 会**替换目标行的整个 `config` 值**，而不是深度合并各键。因此覆盖某行时必须重述该行需要的**每一个**键。
- ⚠️ **覆盖已声明行 ≠ 再 insert 一份**（实测踩坑：`duplicate loader entry id`）。cordis 的 `applyEntryPatches`（`cordis-plugin-include`）对 `insert` 子项直接追加、**不去重**；同一 id 在 bundle 层已声明、user layer 再 `- insert: - id: ...` 一份就会撞 id，boot 直接失败。正确写法是**只带 `id` 的覆盖 patch**：

  ```yaml
  # ✅ 覆盖 bundle 层已声明的 im-channel-dingtalk（id 命中既有行，就地改 config）
  - id: im-channel-dingtalk
    config:
      enabled: true
      clientId: '<DINGTALK_CLIENT_ID>'
  ```

  ```yaml
  # ❌ 错误：insert 会再插一份相同 id → duplicate loader entry id → 启动崩溃
  - insert:
      - id: im-channel-dingtalk
        config: { enabled: true }
  ```

  > 注意 `dsh --dump-config` 走 `composeEntries`（Map 按 id 去重）看不出来；只有实际 boot 才暴露。改 profile 层后务必实跑一次（本仓库冒烟：`node scripts/probe-im-dev-loader.mjs`）。
- 真实范例见官方 `examples/web-cordis/cordis.yml`（它在 `dsh-base` + `dsh-web-app` 之上插入 cordis 工具集，并重设端口）。

### 8.3 行内 JS：`!!js`

patch 行支持 YAML 的 `!!js` 内联求值，用于在加载时读取已注入的上下文：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

loader 只挂载一次组合，等待每行声明的普通注入，再基于其已注入的上下文求值该行的 `!!js` 配置。

---

## 9. 打包与分发：Bundle vs Profile

前几节都是本地 `--patch` overlay 的开发方式。要**分发**一个插件，需要把它打包成可安装的**组合包（bundle）**，安装进一个 **profile**。

### 9.1 两个概念，两种 manifest

二者都由一份 `package.json` 描述，区别在 `dsh` 键下的 manifest 种类：

| 概念 | 是什么 | manifest 键 | 回答的问题 |
| --- | --- | --- | --- |
| **组合包（bundle）** | 附带一个配置层的 npm 包 | `dsh.bundle`（含 `patch`） | "这个包贡献什么？"——一个插入/覆盖插件行的 patch 文件 |
| **profile** | `$DSH_HOME/profiles/<name>` 下、描述一份可启动组合的目录 | `dsh.profile`（含有序 `bundles` 列表） | "这套配置由哪些组合包按什么顺序组成？" |

**组合包是你编写并分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。没有东西同时是两者。**

### 9.2 组合包（bundle）目录结构

```
hello-plugin/
├── package.json        # 声明 dsh.bundle
├── cordis.patch.yml    # 本包被安装时应用的配置层
└── index.js            # 插件入口（已构建产物）
```

`hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`hello-plugin/index.js`（插件入口，构建产物）：

```js
export const name = 'hello-plugin'
export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

`hello-plugin/cordis.patch.yml`（与 `--patch` overlay 同构；区别是插件行按**包名**而非相对源码路径引用）：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

> 没有 `dsh.bundle` 声明的包仍可安装，但只作为普通依赖（供其它插件 `import`），不激活任何配置层。`dsh plugin` 会打印警告。

### 9.3 安装进 profile

```bash
dsh plugin --profile demo add ./hello-plugin
```

- 首次使用会初始化 profile（把 `@deepseek-ai/dsh-base` 作为第一个组合包）。
- pnpm 链接该 checkout，`dsh` 因为它声明了 `dsh.bundle`，把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"]
    }
  }
}
```

- 先验证层、再启动：

```bash
dsh --profile demo --dump-config   # 显示一个 "# == dsh-hello-plugin" 层
dsh --profile demo
```

- 移除：`dsh plugin --profile demo remove dsh-hello-plugin`（同时移除依赖与对应层）。

### 9.4 加载顺序（层组合）

生效配置在空根之上按以下顺序逐层组合：

1. profile 的 `dsh.profile.bundles` 列表所列各组合包 patch，按列表顺序——先是 `@deepseek-ai/dsh-base`，然后是每个已安装组合包（按加入顺序）。
2. profile 自己的 `cordis.patch.yml`。
3. home 级的 `$DSH_HOME/cordis.patch.yml`——各 profile 共享的机器本地偏好。
4. 每个 `--patch <path>` overlay，按 argv 顺序。

> 推论：
> - 你的 patch 可以按 `id` 覆盖前面各层的行（就像 `dsh-web-app` 覆盖 `dsh-base` 的行），但必须重述该行需要的**每一个**键。
> - 用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改动你的包。所以优先给出用户大概率会保留的默认值，其余交给 schema 承担。

### 9.5 从 GitHub 安装：构建脚本这道坎

可以不用发布到注册表，直接 git 安装：

```bash
dsh plugin --profile demo add github:you/hello-plugin
```

但 git 安装拉取的是**源码而非构建产物**，没有任何环节运行你的 `build` 脚本。两边要各做一件事：

- **作者**提供 `prepare` 脚本（pnpm 在 git 安装后运行它），从源码构建出发布入口，且必须自包含（不假设旁边有 monorepo checkout）。
- **用户**为构建授权。pnpm ≥10 在显式允许前拒绝运行 git 依赖的 `prepare` 脚本；首次 `add` 会失败，`dsh` 会提示把包键复制进该 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  > 安全提示：允许该包的代码在安装时于你的机器上执行，且**不在** agent 运行的任何沙箱之内。只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`）。

- **不想让用户授权的替代分发**：发布到 npm（`pnpm publish` 时构建好 `lib/`），或交付 tarball（`pnpm pack` → `dsh plugin add ./hello-plugin-0.1.0.tgz`）。这两种形式都不需要构建权限。

### 9.6 让表层组合包持有自己的命令行

定义了可运行应用的组合包挂载一个普通提供方插件：

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

该插件导出 `inject = ['cmdlineArgs']`，使用自己的 commander program 调用 `@deepseek-ai/dsh-cmdline` 的 `parseCmdline`，再在 program 的 action 中把应用自有服务提供出去。启动器把自身 flag 之后的同一份不可变参数交给每个插件，因此添加应用专属 flag 无需修改启动器。

### 9.7 组合（composition）：在 apply 里挂载子插件

官方 `@deepseek-ai/dsh-agent-spine-demo` 是"bundle"的范例：它的 `apply` 通过一串 `ctx.plugin(ChildPlugin, config)` 把多个子服务编排为一个 spine（LLM、session、system-prompt、tools、skills、agent-loop 等）。`ctx.plugin(...)` 返回的是 effect，卸载时按挂载的逆序清理——这正是插件"组合优于继承"的实践。

### 9.8 桌面端打包集成（离线内置，`src/main/profile-init.ts`）

**目标**：用户下载桌面安装包即用，无需手动 `dsh plugin add`。方案是"**离线内置**"——插件及其全部依赖随桌面端 node_modules 打包，首次启动时由桌面壳自动部署进 dsh profile。

**关键机制（实跑验证）**：
- `dsh.profile.bundles` 是"层栈"，但**官方内置 bundle（dsh-base/dsh-web-app）不要求出现在 profile 的 node_modules**（dsh 从自身解析，模板内置）；第三方 bundle 才需要 profile 里有实体。
- dsh 启动时 `reconcilePlugins`（`@deepseek-ai/dsh/lib/plugin-*.js`）会把 profile `package.json` 的 `dependencies` 里声明了 `dsh.bundle` 的包**自动并入层栈**——所以只需保证 dependencies + node_modules 有实体，bundles 数组 dsh 自己会补。
- profile 的 `pnpm-workspace.yaml` 用 `nodeLinker: hoisted`（依赖扁平化、无符号链接 store），跨机复制/离线友好。

**实现（桌面壳侧，dsh-desktop）**：
1. 桌面根 `package.json` 加依赖 `@lijian-ui/dsh-im-gateway: ^0.1.0`（electron-builder 已全量打包 node_modules 到 `app.asar.unpacked/node_modules`）。
2. `src/main/profile-init.ts` 的 `ensureImGatewayProfile(config)` 在 spawn dsh 前执行：
   - profile 目录缺失 → 写入模板（package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml，与官方 web profile 同构）；
   - package.json 补齐 `dependencies` + `bundles` 数组（幂等，不覆盖已有内容）；
   - **junction** 建到 `profile/node_modules/@lijian-ui/dsh-im-gateway` → 指向桌面壳 node_modules 里的插件实体（打包期 `app.asar.unpacked`、开发期项目根）；目标变化（升级重装）时删除重建。
3. spawn dsh 的 env 追加 `NODE_PATH` = 桌面壳 node_modules（兜底，插件依赖从 junction 物理目标向上解析已能命中）。

**为什么依赖解析不需要 pnpm/联网**：junction 的物理目标在桌面壳 node_modules 内，node 从真实路径向上找 `node_modules` 自动命中，插件的运行时依赖（qqbot-nodejs 等）全在桌面壳 node_modules 里。

**改动文件**：`src/main/profile-init.ts`（新）、`src/main/dsh-process.ts`（start 前部署 + NODE_PATH）、`package.json`（依赖）。

---

## 10. dshClient：给插件开发 Web UI 配置面板

插件除了有"跑在 dsh 子进程里"的 **host 半（node half）**，还可以带一个**浏览器端（client half）**——让插件在官方 Web UI（设置页等）里渲染自己的界面。一个 bundle 可以同时拥有两半：**同包双半**（package.json 同时声明 host 入口和 `./client` 入口），官方所有 `@deepseek-ai/dsh-client-*` 包和本项目 `@lijian-ui/dsh-im-gateway` 都是这个模式。

> 本节是 `@lijian-ui/dsh-im-gateway` 开发中**实跑验证**出来的机制（非纯文档推断），包含两个踩过的坑，务必读完。

### 10.1 机制全链（host 端 → client 端）

```
host 端                                  client 端
installSettingsSection(ctx, ns, Config)  package.json dsh.client 声明
  └─ ctx.settings.register(ns, schema)      └─ client-modules 自动发现
        └─ settings.describe() 返回 schema      └─ serve /plugins/<pkg>/client.js
              └─ 前端 settingsScope/api 读取            └─ window.__ModuleLoader__.load({id, factory})
                    └─ 写: api.settings.update({ns, patch})  /  mutate / replace
```

四个环节，缺一环面板就渲染不出来：

1. **host 端注册 settings namespace**（前置条件）。插件必须调用 `installSettingsSection(ctx, ns, Config, config, {setSource, onChange})`（来自 `@deepseek-ai/dsh-settings`，内部 `ctx.inject(['settings'])` 延迟注册），把 Config schema 注册成命名空间。**只导出 `Config` 是不够的**——不注册，`settings.describe()` 就返回不了 schema，前端无表单可渲染。namespace 必须匹配 `^[a-z][a-z0-9-]*$`，用 `settingsNamespace('im-gateway')` 构造。**整个 bundle 通常只注册一个 namespace**（多插件分包才各自注册）：

```ts
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const NS = settingsNamespace('im-gateway')   // 整个 bundle 一个 namespace

export function apply(ctx: Context, config: Config): void {
  installSettingsSection(ctx, NS, Config, config, {
    setSource: () => {},   // 把配置源换成 live settings（热更新接缝）
    onChange: () => {},
  })
  // ... 业务逻辑
}
```

> 多实例配置模型：Config 里用**数组**表达可重复的配置块（如 `channels: Schema.array(...)`，同一渠道类型可配多个机器人实例，每个实例带唯一 `id`）。注意 host 的 `mergeLayers` 深合并**对数组是整体替换**（数组不是 plain object），所以 client 写数组时必须带**完整新数组**，不能只写一个元素。

2. **package.json 声明 client half**：加 `dsh.client`（`platform: "web"` + `inject` 列出依赖的 client 包 + `immediately: true`）+ `exports["./client"]`。`dsh-client-modules`（host 侧）遍历 loader 里每个 entry 的 `name`，发现某包声明了 `dsh.client` 就 serve `/plugins/<pkg>/client.js`：

```json
{
  "exports": { "./client": { "default": "./lib/client.js" } },
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
  }
}
```

> **`dsh.client` 字段规范（官方打包要求，务必对齐）**：
> - `inject` 列出 client 端**依赖的 client 包**（browser 端要加载哪些 client bundle）。它和插件代码里的 `export const inject = ['slots','locale','remote']`（cordis 服务名）是两回事——前者是包名，后者是服务名。**inject 是可传递的**：`dsh-api-gateway` 的 client.inject 是 `["dsh-typert-registry","dsh-client-connection"]`，所以只需 inject `dsh-api-gateway` 就同时拿到 `ctx.remote`（Typert Remote，来自 typert-registry）和 `connection` 服务。**不要**再手动 inject 一堆传递依赖（旧写法 inject 了 5 个包：connection/locale/runtime/ui-settings/api-remotes，其中 ui-settings 冗余、api-remotes 只是 api-gateway 的壳）。
> - `immediately: true`：官方所有 client bundle 都设立即加载（`dsh-client-connection`、`dsh-api-gateway` 等均如此）。缺省 = 懒加载，可能导致 client bundle 加载时机异常。
> - `platform: "web"`：声明这是浏览器端 bundle。
> - **不要**为 client 新增独立的 loader entry（如 `name: '@lijian-ui/dsh-im-gateway/client'`）。让现有的 host entry 承载即可——client-modules 按 entry 的 `name` 解析包的 package.json，独立 client entry 会导致 `require.resolve('<pkg>/client/package.json')` 失败。

3. **client bundle 构建格式**：浏览器加载的是 CJS factory 格式，tsdown 需双配置（host 半 ESM+dts，client 半 CJS browser）。client 配置要点：`format:'cjs'`, `platform:'browser'`, `dts:false`, `clean:false`（不清掉 host 半产物）, `external` 只列平台模块（react、cordis、`dsh-client-schema-form`、`dsh-client-ui-slots` 等），`noExternal` 其余全部内联；产物 `lib/client.js` 必须包成：

```js
window.__ModuleLoader__.load({
  id: '@lijian-ui/dsh-im-gateway',
  factory: (require) => { /* ... return module.exports */ }
})
```

`outputOptions` 里用 `banner` / `intro` / `footer` 包这层壳（见 `extensions/im-gateway/tsdown.config.ts`）。client 源码**不能 import host 代码**、不能 import 非平台模块（purity gate），所以依赖只能走注入的 ctx 服务。

4. **注册到插槽（slot）+ 渲染 + 读写**：

```ts
export const inject = ['slots', 'locale', 'connection', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const api = ctx.get('connection').api
  const scope = ctx.settingsScope.bind({ namespace: 'im-gateway' })  // 单 scope

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',   // 设置页左侧导航的分区
    id: 'im-channels',          // list 槽需要 id
    order: 20,                  // models 用 order:10 → 排它下边
    label: () => 'IM 通道',
    inject: () => ({ hooks: { imGateway: scope }, api }),
  }, ImChannelsSection))
}
```

- 读：`inject` 的 `hooks` 会被 slots 渲染器绑成 selector hook 传给组件（`hooks: { imGateway: scope }` → 组件 prop `useImGateway`，见下"坑二"）；schema 用 `api.settings.describe({})` 拿（返回 `{result:{ok, value:{namespaces:[{ns,schema,base,user,value,revision,secrets}]}}}`）。
- 写：`api.settings.update({ns, patch, expectedRevision})` 合并进 user 层；`secret` 字段（`Schema.string().role('secret')`）在 describe 响应中被 redact，表单只渲染"已配置/未配置"状态，写入时省略该键 = 保留原值；**数组字段（如 `channels`）patch 整体替换，client 必须写完整数组**（增删实例 = 从数组里 push/filter 后整个写回）；重置走 `mutate({ns, ops:[{op:'unset',path:[key]}]})`；整体清空走 `replace({ns, section:{}})`。
- 可用的插槽（读各 client 包 `SlotMap` 类型枚举）：`settings.section`（设置页分区）、`settings.plugin.item`（插件页配置卡）、`settings.plugins.tab`（插件页 tab）、`settings.general.item`（General 页一行）、`sidebar`/`sidebar.footer.action`（侧边栏）、`conversation.input.dock`（输入框旁）、`conversation.chat.turnTail`（消息尾部）、`shell.overlay`（全局浮层）等。**只能注册到已声明的插槽**（类型在 `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `SlotMap` 里），`single` 槽独占、`list` 槽可叠加。

> ⚠️ **大坑：第三方 settings namespace 不暴露给 Web client（`settings-not-exposed`）**。`dsh-host-apiproxy` 的 `exposedNamespaces()`（`lib/index.js:2410`）只放行：① 所有"可配置 LLM 提供商"的 `settingsNs`（`llm.registerAdapter` 注册的，如 deepseek/pi-ai）；② 官方硬编码 `WEB_SETTINGS_NAMESPACES`（agent-loop/shell/locale/permission/ui-conversation/ui-theme/web-search-deepseek）；③ `PRODUCT_SETTINGS_NAMESPACES`（ui-onboarding/settings）。**没有第三方注册入口**（`settings.register` 无 expose 选项；源码注释 "Moving that declaration to settings.register()" 是未实现计划）。后果：`api.settings.describe()` 永远不返回你的 namespace（前端 scope 永远拿不到值）、`update()` 直接拒绝。**官方设计意图**：第三方配置默认不进前端 settings 面板。

> ✅ **正解：用 Typert Remote 服务给 Web client 提供 RPC（官方一等通道）**。官方文档 `docs/api-gateway.md`（harness 仓库）+ 参考插件 `参考项目/dsh-skill-viewer` 都走这条路：host 端把方法注册成可远程调用（带 schema 校验、统一 `{ok, value/error}` 信封、会话感知），client 端 `remote.$mount` 后直接调用。**第三方业务包给前端提供数据/API 就该用 Typert，别碰 settings 白名单，也别自己造 webServer 裸路由**。
>
> **Host 端**（参考 `extensions/im-gateway/src/remote.ts`）：
> ```ts
> export const inject = ['typert', 'settings']   // ⚠️ 必须插件级 inject，ctx.inject 不触发
>
> class MyApi extends TypertRemoteService {
>   constructor(ctx: Context) { super(ctx, 'myApi') }   // 服务 key = client 的 remote.<ns>
>   getConfig() { /* 直调 ctx.get('settings')，进程内无白名单 */ }
>   async saveConfig(channels, expectedRevision?) { /* 写 + 重新 describe */ }
> }
>
> // contribution：HOST face 用 face:'host' + invocations（client $mount 才用 descriptors）
> ctx.typert.register({ package, face: 'host', schemas: [], invocations: [...], model: { services: [], events: [], objects: [] } })
> ```
> **Client 端**（参考 `extensions/im-gateway/src/client/config-api.ts`）：
> ```ts
> export const inject = ['slots', 'locale', 'connection', 'remote']
> const mount = ctx.remote.$mount({ package, descriptors: [...] })  // identity codec 即可，严格校验在 host
> await mount
> const remote = ctx.get('remote.myApi')          // namespace 名 = host 服务 key
> const result = await remote.getConfig()          // → { ok, value } | { ok:false, error:{code,message} }
> ```
> **两个必踩的坑**：① host contribution **必须有 `face:'host'` + `invocations`**，缺 face 直接 plugin tree 加载失败（boot 崩）；② host 注册必须用**插件级 `export const inject = ['typert', ...]`**，`ctx.inject(['typert',...], cb)` 在 bundle apply 里不触发。另外两个要点：成功写后**重新 describe** 拿新 view（`settings.update()` resolve 值为 undefined）；secret 字段 client 永远看不到明文，保存时**空 secret 键从存储合并回写**（否则整数组替换会抹掉凭证）。codec 的 `TypertSchema` 只需 `{parse(value)}`，不需要引 zod。

### 10.2 坑一：React Hooks 只能在组件函数体顶层调用

client bundle 是纯 JS（无 lint/类型检查保护），Hooks 违规只有运行时才暴露，表现为**页面空白 + 控制台 "Invalid hook call"**。

```ts
// ❌ 错误：把注入的 selector hook 放在 useMemo 回调里调用
const snapshots = useMemo(() => {
  const out = {}
  out['qq'] = props.useQq((s) => s)   // ← hook 在 useMemo 里调用，运行时崩溃
  return out
}, [props.useQq])

// ✅ 正确：hook 调用提升到组件函数体顶层，无条件、固定顺序
const qqSnap = props.useQq((s) => s)
const dingtalkSnap = props.useDingtalk((s) => s)
```

规则：**注入的 `useXxx` selector hook（以及一切 hook）只能在组件函数体顶层调用**，不能放进 `useMemo` / `useEffect` / 循环 / 条件分支。

### 10.3 坑二：inject hooks 的命名规则（`qq` → `useQq`，不是 `useQQ`）

slots 渲染器把 `inject()` 返回的 `hooks` 对象按 `'use' + key[0].toUpperCase() + key.slice(1)` 绑成组件 prop 名（`dsh-client-web-react/lib/index.js` 的 `bindInjectHooks`）：

| inject hooks key | 组件收到的 prop | 说明 |
| --- | --- | --- |
| `dingtalk` | `useDingtalk` | 驼峰 key 首字母大写 = 自身 |
| `imGateway` | `useImGateway` | 同上 |
| `weixiu` | `useWeixiu` | 同上 |
| `qq` | **`useQq`** | 单字母缩写只大写首字母，**不是 `useQQ`** |

写组件 prop 时先按规则推一遍名字，否则 `props.useQQ is not a function` 直接崩（slot entry crashed in 'settings.section'）。

### 10.4 组件风格约束

- **无 JSX**：浏览器 half 源码用 `React.createElement` 构建（纯 JS/TS 编译，无 JSX/TSX 语法）。
- **无 CSS modules**：client bundle 不引 css 插件，样式用内联 `style` 对象，颜色走 dsw 设计 token（`var(--dsw-alias-*)`）以适配明暗主题。
- **无图标库**（lucide 等非平台模块不能 import）：图标用内联 SVG。
- 参考实现：`extensions/im-gateway/src/client/`（`index.ts` 注册、`ImChannelsSection.ts` 页面、`ImChannelModal.ts` 弹窗）。冒烟：`scripts/probe-client-factory.mjs`（node:vm 执行 factory）+ `scripts/probe-client-bundle.mjs`（HTTP 验证 bundle 被 serve）。

---

## 11. 在你的桌面项目（`dsh-desktop`）中接入插件

桌面壳的启动编排在 `src/main/dsh-process.ts` 中组装：

```bash
dsh [--profile <name>] --host <host> --port <port> [extraArgs...]
# 未配置 profile 时以默认 `web` 启动（`web` 是 `--profile web` 的别名）
```

`--profile` 来自 `src/main/config.ts` 的 `DshConfig.profile`（**不是** `extraArgs`）；`extraArgs` 来自 `DshConfig.extraArgs`（可由 `config.json` 的 `extraArgs` 字段提供，或环境变量），原样透传给子进程。**要让 dsh 加载你的插件，按下面两种方式二选一。**

### 11.1 开发期（本地 overlay 调试）

在 `config.json` 中加入：

```json
{
  "extraArgs": ["--patch", "C:/abs/path/to/your-plugin/cordis.yml"]
}
```

patch 文件里用**绝对路径**引用你的本地 TS 模块（见第 8.1 节）。重启桌面应用即可生效。

### 11.2 开发期（`dsh plugin add` 加载 bundle 栈）

`@lijian-ui/dsh-im-gateway` 采用官方标准做法（与参考项目 `dsh-skill-viewer` 一致）：插件是普通 npm 包（`dsh.bundle.patch` + `dsh.client` 声明 + `exports["./client"]`），用 **`dsh plugin add` 装进官方 `web` profile**，web UI 自动出现设置页，无需自定义 profile / junction / DSH_HOME 重定向：

```bash
# 本地包（开发期联调，pnpm link 到本地源码目录，改源码 build 后重启即生效）
dsh plugin --profile web add ./extensions/im-gateway

# 或发布后从 registry / git / tarball 安装（与 dsh-skill-viewer 同款）
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

`dsh plugin` 本质是 pnpm forwarder：在 profile 目录跑 `pnpm add <spec>`，然后自动把声明了 `dsh.bundle` 的依赖追加进 `dsh.profile.bundles`——所以插件挂载**无需手动编辑任何 cordis.patch.yml**。`DSH_HOME` 全程保持官方默认 `~/.dsh`，运行时数据（settings/credentials/sessions/storages）都存这里。

桌面壳侧只需在 `config.json` 设置（或干脆不设，默认即 `web`）：

```json
{
  "profile": "web",
  "port": 0
}
```

> `--profile` 是 launcher 级全局参数，必须位于子命令/应用参数之前；`web` profile 的 bundles 已纳入 `dsh-web-app`，启动即拉起 web 服务。

> **开发期常见问题排查**：
> - **改 src 不生效（为什么每次都要 build）** → 插件是**独立 npm 包**（`extensions/im-gateway/`），桌面主工程的 `npm run dev`（tsc 编译 `src/`）**不覆盖** `extensions/` 里的 TS；dsh web 子进程按 npm 包解析 require 的是 `package.json` 的 `"main": "lib/index.js"`（tsdown 编译产物），**node 不编译 TS、不读 src**。所以改 `src/` 后必须 `cd extensions/im-gateway && npm run build`，再**重启 dev**（node require 缓存不会因文件变了自动重载）。**免手动 build**：`npm run watch`（tsdown --watch）常驻，src 保存自动重编译 lib，之后只剩"重启 dev"一步。对比旧项目 pi-desktop：IM 网关在主进程源码树里、`npm run dev` 的构建链路自动覆盖，所以"以前不用这样"——本质是"代码在进程源码树 vs 在外挂 npm 包"的差别。
> - **API key 没读到** → 桌面壳 `buildDshEnv` 会把 `config.apiKey`（或 `DEEPSEEK_API_KEY` 环境变量）注入 dsh 子进程。运行报 `llm-deepseek: no API key ...` 时，要么 `config.json` 加 `"apiKey"`（明文已 gitignore），要么在 web Models 页面保存 key 到 `~/.dsh/.credentials.yaml`。
> - **重启后仍报旧错误** → Windows 下 Ctrl+C 退出 electron 不会触发 `before-quit`（Node 收到 SIGINT 默认直接终止），spawn 出的 dsh 子进程残留成孤儿、继续跑旧配置（可能端口冲突或仍读旧 `DSH_HOME`，甚至多进程同时写坏 session 日志）。**已修复**：`index.ts` 监听 SIGINT/SIGTERM 补清理 + `dsh-process.ts` 去掉 `shell:true`（绕开 `.cmd` shim 的 cmd.exe 层，让 `child.pid` 直接是 node）。若强杀/崩溃后仍怀疑残留，排查命令：
>   ```powershell
>   Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dsh.lib.bin.js' } | Select-Object ProcessId, CommandLine
>   ```
>   有残留就 `Stop-Process -Id <PID> -Force`，然后重新 `npm run dev`。
> - **模型选择（`{{model}}` 无值）** → 裸 `ctx.agents.create({sessionId, meta})` 创建的 agent 不会装 model-selection，导致 `{{model}}` 渲染失败。**裸建 agent 必须在 create 后立刻调 `installModelSelection(agent.ctx, selection)`**（官方 apiproxy 的 selectionFor 做的事），selection.current 从 `ctx.agentDefaultModel.currentSelection()` 取，或从 session header 取。

### 11.3 发布期（安装成 bundle）

把你开发的插件打包成组合包（见第 9 节），安装进一个 profile：

```bash
dsh plugin --profile desktop add ./your-plugin
```

然后在 `config.json` 中让桌面壳启动该 profile（同 11.2 的 `"profile": "desktop"`）。

> 注意：`--profile` 与 `--patch` 可以叠加使用（`--patch` 始终是最后一层 overlay，可经 `extraArgs` 传入）。

### 11.4 桌面壳接入要点小结

| 场景 | `config.json` 写法 | 说明 |
| --- | --- | --- |
| 本地打断点调试 | `"extraArgs": ["--patch", "<abs>/cordis.yml"]` | 引用本地 TS 模块，绝对路径 |
| 自定义 bundle 栈（开发期） | `"profile": "web"` | 插件已 `dsh plugin --profile web add ./extensions/im-gateway` 装进官方 web profile |
| API key 注入 dsh 子进程 | `"apiKey": "sk-..."` | 明文 key（已 gitignore）；buildDshEnv 会注入 `DEEPSEEK_API_KEY` 环境变量，绕开 `~/.dsh/.credentials.yaml` 读文件链。等价于设系统环境变量 `DEEPSEEK_API_KEY` |
| 分发后用 bundle | `"profile": "desktop"` | 插件已 `dsh plugin --profile desktop add` |
| 两者结合 | `"profile"` + `"extraArgs": ["--patch", "<abs>/local-overrides.yml"]` | profile 层 + 本地覆盖层 |

> 桌面壳的 dsh 子进程仍由系统 Node 运行（满足 `^22.19 || >=24`，见 `dsh-process.ts` 的 `resolveSystemNode`），插件代码也跑在这个子进程里，**不需要**在 Electron 侧做任何 ABI/原生模块处理。

---

## 12. 最佳实践与设计原则

1. **能力分层（Capability Layering）**：把可替换能力拆成 **Service Definition（接口）/ Service Provider（实现）/ Consumer（消费方）** 三类包。一行 `inject` 声明依赖，框架负责按依赖图加载与卸载。详见官方 `develop/practice/`。
2. **无硬编码可调参数**：凡是不同部署可能不同的取值，一律做成配置字段（见第 7.3 节）。
3. **配置错误要响亮**：在 schema 中表达完备约束，让无效配置在加载时失败，而不是悄悄用错默认值。
4. **一切注册走 `ctx`**：事件监听、工具、定时器等都通过 `ctx` 注册，卸载时自动清理；只有真正的外部资源（连接、句柄）才用 `ctx.effect()` 显式清理。
5. **类型安全优先**：服务、事件都通过 `declare module '@deepseek-ai/cordis'` 做声明合并，让 `ctx.xxx` 和 `ctx.on('xxx')` 在编译期就有正确类型。
6. **小粒度、单一职责**：一个插件做一件事；跨插件能力用服务/事件暴露，而不是直接 import 实现。
7. **遵守事件命名约定**：插件自定义事件用 `namespace/action`，便于与内置事件（`agent/*`、`tools/*`、`session/*`）区分。
8. **dshClient 组件：hook 只在函数体顶层调用**（第 10.2 节坑一）——注入的 `useXxx` selector hook 放进 `useMemo`/`useEffect`/循环/条件会运行时崩溃，页面空白。
9. **dshClient 组件：inject hooks 命名按 `'use'+首字母大写+其余` 推导**（第 10.3 节坑二）——`hooks: { qq }` 注入的是 `useQq` 而非 `useQQ`，写组件 prop 前先按规则推一遍。
10. **裸 `ctx.agents.create()` 必须手动 `installModelSelection`**——官方 `apapi` 的 `selectionFor` 会自动装 model-selection，但裸建 agent 不会；不装则 persona 模板的 `{{model}}/{{provider}}` 渲染失败、turn/end 报 `prompt variable "{{model}}" has no value`。
11. **Windows 下 Ctrl+C 退出桌面壳不会自动杀 spawn 的 dsh 子进程**——根因：SIGINT 不触发 Electron 的 `before-quit`（清理逻辑挂在那），且 spawn 用 `shell:true` 时 `child.pid` 指向 cmd.exe 而非真正的 node。已修复：`index.ts` 监听 SIGINT/SIGTERM 补清理 + `dsh-process.ts` 去 `shell:true`、开发期也直接 spawn 系统 node + `dsh/lib/bin.js`。强杀/崩溃/断电仍会孤儿，重启前可用 `Get-CimInstance Win32_Process | Where CommandLine -match 'dsh.lib.bin.js'` 排查残留。

---

## 13. 参考资源

- **官方文档（插件开发）**
  - 第一个插件：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
  - 开发一个工具：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool>
  - 插件配置：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/config>
  - 打包与安装：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish>
  - 服务与依赖：<https://deepseek-harness.github.io/deepseek-harness/develop/framework/service>
  - 事件系统：<https://deepseek-harness.github.io/deepseek-harness/develop/framework/events>
  - 能力分层实践：<https://deepseek-harness.github.io/deepseek-harness/develop/practice/>
  - CLI 行为参考：仓库 `apps/cli/reference/README.md`（层优先级、flag、profile 机制）
- **官方代码库（`参考项目/deepseek-harness/`）**
  - 工具 DSL 与运行时：`packages/core/tools/src/schema.ts`、`packages/core/tools/src/index.ts`
  - 真实工具范例：`packages/fs/tool-fs/src/read.ts`
  - 组合（bundle/spine）范例：`packages/examples/agent-spine-demo/src/index.ts`、`packages/examples/acp-demo/src/index.ts`
  - 本地 overlay 范例：`examples/web-cordis/cordis.yml`
  - 扩展包范例：`packages/extensions/tool-cordis/`（含 `package.json` 的 `dsh.bundle` / peerDependencies 约定）
  - client bundle 构建预设：`packages/client/tsdown.client.ts`（banner/footer 壳、平台模块 external、purity gate）
  - 插槽类型与注册：`packages/client/ui-slots/`、`packages/client/ui-settings/`（SlotMap / settings.section 等类型归属）
- **你的桌面壳**
  - 启动编排：`src/main/dsh-process.ts`（`spawnOnce` 组装 dsh 参数；`--profile` 由 `config.profile` 注入）
  - 配置入口：`src/main/config.ts`（`DshConfig.profile` / `extraArgs` / `buildDshEnv` 组装环境变量，**不重定向 DSH_HOME**，统一用官方默认 `~/.dsh`）
  - 既有文档：`docs/node-runtime-bundling.md`（Node 运行时打包，与插件分发互相独立）
- **IM 网关实跑参考（本仓库）**
  - 插件实现：`extensions/im-gateway/src/`（host 半 `index.ts`/`channels/*`（dingtalk/qq/weixiu）/`remote.ts` + client 半 `client/`（index.ts/ImChannelsSection.ts/ImChannelModal.ts））
  - 安装方式：`dsh plugin --profile web add ./extensions/im-gateway`（本地包 link 进官方 web profile；`extensions/im-gateway/cordis.patch.yml` 是 bundle 的 insert patch，含 config 默认值 `cwd: !!js process.cwd() / channels: []`）。运行时数据（settings/credentials/sessions/storages）统一在官方 `~/.dsh/`。
  - 完整链路已验证（2026-08-15）：钉钉 Stream 连接 → `ctx.imGateway.handleInbound` → `ensureSession`（live 复用 / persistence 命中则 `agents.resume` / 兜底 `agents.create`+ `isIdCollision` fallback resume） → `agent.followup` → `installModelSelection` 注入 v4-pro → llm-deepseek `resolveApiKey` 读 `~/.dsh/.credentials.yaml` → DeepSeek API → `session/event` 流 → `channel.sendText` 回钉钉。钉钉端发消息收到 agent 正常回复（"基于 DeepSeek Harness 框架运行的编程助手，底层模型是 deepseek-v4-pro"）。
  - 多实例 channels：用户当前在 `~/.dsh/settings.yaml` 的 `im-gateway.channels` 配了一个钉钉实例 `dingtalk-6y0y`（enabled=true，含真实 clientId/clientSecret）；结构是数组，支持同渠道配多个机器人。
  - 关键踩坑：① `agents.create` 抛 `id collision` 时（list() 时序错过或旧进程残留）必须 fallback `agents.resume`；② 裸 `agents.create` 必须 `installModelSelection`；③ Windows Ctrl+C 退出桌面壳不杀 dsh 子进程（SIGINT 不触发 before-quit），已加信号监听 + 去 `shell:true` 修复，但强杀/崩溃仍会孤儿，重启前主动查杀；④ 多进程写同一 session 会 seq 重叠损坏日志（history 报 seq gap），修复需截断到帧边界。
  - 冒烟脚本：`scripts/probe-verify-web.mjs`（web profile + im-gateway 加载）、`probe-im-dev-loader.mjs`（loader 条目）、`probe-client-bundle.mjs`（client bundle 被发现并 serve）、`probe-client-factory.mjs`（factory 执行不崩）、`probe-typert.mjs`（host Typert Remote 服务注册 + getConfig/saveConfig 调用）、`probe-cred-default.mjs`（不设 DSH_HOME 验证 credentials 能读到 key）、`probe-resume.mjs`（同会话跨重启的 create/resume 双轮验证）
