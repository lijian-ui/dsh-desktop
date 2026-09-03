# dsh 内置 OfficeCLI 工具宿主插件（预备方案）开发文档

> **状态**：**备选方案存档**（用户评估是否实施，未排期）
> **目标**：把一个成品的 `officecli` 二进制，通过 dsh host 插件以 `ctx.subprocess.spawn` 包装，注册 9 个 `office_*` 模型工具，让 LLM 具备真实的 Office 文件（`.docx/.xlsx/.pptx`）创建/编辑能力，同时**从根源绕开 agent 受限 shell 的沙箱问题**。
> **参考实现**：`参考项目\dsh-office-tool`（dsh 官方生态范例，`defineTool` + `ctx.subprocess`，非纯 shell）。

> ⚠️ **与另一份文档的关系**：`docs/office-ai-editor-plugin.md` 是「自研 GenOffice/Univer 引擎 + 右侧可编辑面板」的重型路线；本文是「复用官方 OfficeCLI 二进制 + host 包装工具」的轻量路线，两者互补可并行评估，**二选一或分阶段**。

***

## 1. 背景与动机

### 1.1 为什么需要 host 包装，而不是让 LLM 在 shell 里调 officecli

最初把 `officecli` 加进 PATH 后，**LLM 在内置 agent 的 shell 里直接敲** **`officecli ...`**，遇到两类问题：

| 现象                      | 根因                                                                          |
| ----------------------- | --------------------------------------------------------------------------- |
| `officecli` 找不到命令       | dev 期 `addOfficecliPath` 早期被 `app.isPackaged` 挡住，PATH 未注入（已修复：dev/打包统一注入）   |
| **`set`** **修改已有文件不落盘** | 受限沙箱下写盘被静默丢弃；且 officecli 常驻进程默认 `auto` 空闲去抖 flush（2-10s），单步 `set` 后改动存内存未落盘 |
| **管道方式启动被拒绝**           | 受限沙箱/PipeTempGuard 拒绝管道 stdio                                               |

实测：只有给 agent 提权（`danger-full-access`）+ 每次命令带 `OFFICECLI_RESIDENT_FLUSH=each` 才稳定落盘。**这是脆弱链路**：依赖每个 agent 会话都提权 + 记得设 env。

### 1.2 host 包装为什么能绕开沙箱

`ctx.subprocess.spawn` 是**宿主进程持有的能力**，不受 agent 受限 shell 的文件系统/进程权限约束：

| 维度     | LLM shell 里敲命令          | host 插件 `subprocess.spawn`              |
| ------ | ----------------------- | --------------------------------------- |
| 调用方    | agent 受限 shell          | host 插件（Node 侧，`inject:['subprocess']`） |
| 二进制寻址  | shell 查 PATH            | `resolveExecutable` 提前解析**绝对路径**        |
| 写盘权限   | 受沙箱限制（可被丢弃）             | 宿主能力，天然可写                               |
| 是否需要提权 | 需要 `danger-full-access` | **不需要**                                 |

核心：**二进制是同一个 officecli，差别只在"调用权从受限 shell 收回 host"**。这让它从根源避开 1.1 的沙箱问题。

> **沿用决策**：保留桌面壳已做的两处注入——`addOfficecliPath` 的 PATH 注入（让 host/其它子进程能找到二进制）与 `OFFICECLI_RESIDENT_FLUSH=each`（防常驻进程内存改动丢盘）——它们与 host 包装**互补**，即使走 host 包装也建议保留。

***

## 2. 总体架构（沿用 dsh-office-tool 的三层）

```
模型（LLM）
   │  经 transform 暴露 9 个 office_* 工具
   ▼
Tool 层（每工具一个文件，纯 Consumer）
   execute() ──▶  ctx.office.run({verb, ...})      // 不直接碰二进制
   ▲
Service 层（ctx.office，真正干活）
   │   buildArgv()  把类型化参数 → officecli argv（argv[0]=二进制绝对路径）
   │   runRaw()     ctx.subprocess.spawn() + 超时/信号/输出收集
   │   run()        解析 --json envelope → 结构化结果
   ▼
officecli 二进制（唯一能力来源，Mac/Win/Linux 自包含）
```

职责划分：

- **Tool 层**：只负责参数 schema、description（给模型看）、execute 调 `ctx.office`、output.render 渲染回显。**不写任何 office 逻辑**。

- **Service 层**：持有二进制路径，翻译参数→argv，spawn，解析 envelope，做错误分类（timeout / spawn failed / command failed / invalid output）。

- 全程不碰 agent shell。

***

## 3. 目录规划（建议）

新建独立插件 `extensions/dsh-cli-office/`，或并入现有 `extensions/dsh-file-manager/`（若希望复用已内置的 officecli 打包与 PATH 注入）。以下按独立插件列出：

```
extensions/dsh-cli-office/
├── package.json
├── tsdown.config.ts
├── tsconfig.json
├── cordis.patch.yml
├── src/
│   ├── index.ts            # host 入口：resolve 二进制 → provide ctx.office → applyOfficeTools
│   ├── config.ts           # OfficeServiceOptions：command/bin、timeoutMs、maxOutputBytes、env
│   ├── service.ts          # OfficeService 类（buildArgv / runRaw / run / runEnvelope / parseEnvelope）
│   ├── errors.ts           # OfficeError + officeErrorFromInfo
│   └── tools/
│       ├── index.ts        # applyOfficeTools：注册全部 9 个工具
│       ├── common.ts       # stringifyProps / warningsOf / genericCall
│       ├── create.ts
│       ├── get.ts
│       ├── query.ts
│       ├── set.ts
│       ├── add.ts
│       ├── remove.ts
│       ├── view.ts
│       ├── batch.ts
│       └── cli.ts
```

### 3.1 package.json（host/Node 半，无需 client）

```json
{
  "name": "@dx/dsh-cli-office",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml"],
  "dependencies": {
    "@deepseek-ai/dsh-tools": "^0.x"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*"
  }
}
```

- 只需 host 半（服务模型/tool），**不需要** `dsh.client` / client bundle。

- 二进制来源三种：PATH（`command` 默认 `officecli`）、配置绝对路径、或复用 `process.resourcesPath/officecli` / `vendor/officecli/<os>-<arch>`。

***

## 4. Service 层核心代码（照搬/精简 dsh-office-tool）

### 4.1 service.ts 骨架

```ts
import { Context, Service } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OfficeError, officeErrorFromInfo, type OfficeErrorInfo } from './errors.ts'

/** 类型化操作。cli 传裸 argv 透传。 */
export type OfficeVerb =
  | 'create' | 'get' | 'query' | 'set' | 'add' | 'remove' | 'move' | 'swap'
  | 'view' | 'batch' | 'merge' | 'dump' | 'import' | 'validate'
  | 'raw' | 'raw-set' | 'refresh' | 'help' | 'save' | 'close' | 'open'
  | 'watch' | 'unwatch'
  | 'cli'

export interface OfficeRunSpec {
  verb: OfficeVerb
  file?: string
  args?: readonly string[]
  props?: Readonly<Record<string, string | number | boolean>>
  flags?: Readonly<Record<string, string | number | boolean | undefined>>
  json?: boolean
  cwd?: string
}

export interface OfficeServiceOptions {
  bin: string                 // 二进制绝对路径
  env?: Readonly<Record<string, string>>
  timeoutMs: number
  maxOutputBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { office: OfficeService }
}

export class OfficeService extends Service {
  constructor(ctx: Context, private readonly options: OfficeServiceOptions) {
    super(ctx, 'office')
  }

  /** 类型化参数 → argv，argv[0] = 二进制绝对路径 */
  buildArgv(spec: OfficeRunSpec): string[] {
    const argv = [this.options.bin]
    if (spec.verb === 'cli') { argv.push(...(spec.args ?? [])); return argv }
    argv.push(spec.verb)
    if (spec.file !== undefined) argv.push(spec.file)
    argv.push(...(spec.args ?? []))
    for (const [k, v] of Object.entries(spec.props ?? {})) argv.push('--prop', `${k}=${String(v)}`)
    for (const [k, v] of Object.entries(spec.flags ?? {})) {
      if (v === undefined || v === false) continue
      if (v === true) { argv.push(`--${k}`); continue }
      argv.push(`--${k}`, String(v))
    }
    if (spec.json !== false) argv.push('--json')
    return argv
  }

  /** 通过 ctx.subprocess 跑 argv，返回原始输出（超时/取消/错误分类） */
  async runRaw(argv: readonly string[], opts: { signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {}) {
    const subprocess = this.ctx.get('subprocess') as SubprocessRuntime
    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = () => controller.abort()
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const handle = subprocess.spawn({
        argv,
        cwd: opts.cwd ?? process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.options.maxOutputBytes },
          stderr: { maxBytes: 1 << 20 },
        },
        graceMs: 2_000,
        env: this.options.env as NodeJS.ProcessEnv | undefined,
        signal: controller.signal,
      })
      const outcome = await handle.done
      if (opts.signal?.aborted) throw new OfficeError('officecli call was cancelled', { code: 'office_cancelled' })
      if (controller.signal.aborted) throw new OfficeError(`officecli did not finish within ${timeoutMs}ms`, { code: 'office_timeout' })
      const stdoutRead = handle.collected.stdout?.readFrom(0)
      const stderrRead = handle.collected.stderr?.readFrom(0)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: stdoutRead?.text ?? '',
        stderr: stderrRead?.text ?? '',
        truncated: stdoutRead?.lossy ?? false,
      }
    } catch (error) {
      if (opts.signal?.aborted) throw error
      if (controller.signal.aborted) throw new OfficeError(`officecli did not finish within ${timeoutMs}ms`, { code: 'office_timeout', cause: error })
      throw new OfficeError(`failed to start officecli: ${String(error)}`, { code: 'office_spawn_failed', cause: error })
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 跑类型化操作并解析 --json envelope */
  async run(spec: OfficeRunSpec, signal?: AbortSignal) {
    const argv = this.buildArgv(spec)
    const raw = await this.runRaw(argv, { signal, cwd: spec.cwd })
    if (raw.signal !== null && raw.signal !== 'SIGTERM') {
      throw new OfficeError(`officecli was killed by signal ${raw.signal}`, { code: 'office_command_failed' })
    }
    const envelope = parseEnvelope(raw.stdout)
    if (envelope === undefined) {
      if (raw.exitCode === 0) {
        throw new OfficeError(`officecli produced non-JSON output: ${truncate(raw.stdout, 300)}`, { code: 'office_invalid_output' })
      }
      throw new OfficeError(`officecli exited with code ${String(raw.exitCode)}: ${truncate(raw.stdout, 300)}`, {
        code: 'office_command_failed', exitCode: raw.exitCode ?? undefined,
      })
    }
    if (!envelope.success) throw officeErrorFromInfo(envelope.error, raw.exitCode ?? 0)
    return envelope
  }
}

/** 解析 officecli --json envelope（stdout 可能是 JSON 或纯文本） */
export function parseEnvelope(stdout: string) {
  try {
    const value = JSON.parse(stdout.trim())
    if (value && typeof value === 'object' && 'success' in value) return value
  } catch { /* not JSON */ }
  return undefined
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
```

> **要点**：成功/提示/错误信息 officecli 会进 **stderr**，`run()` 只认 `--json` envelope（stdout），错误统一经 `parseEnvelope` + `officeErrorFromInfo` 走结构化 `OfficeError`，**绝不依赖 stdout 文本判断成败** —— 这正是修复此前"LLM 看 stdout 为空误判没写入"的对应实践。

### 4.2 index.ts：resolve 二进制 + provide service + 注册工具

```ts
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OfficeService } from './service.ts'
import { applyOfficeTools } from './tools/index.ts'
import { normalizeConfig, type OfficeConfigInput } from './config.ts'

export const name = 'dsh-cli-office'
export const inject = ['subprocess', 'tools']

export async function apply(ctx: Context, config: OfficeConfigInput = {}): Promise<void> {
  const cfg = normalizeConfig(config)
  const subprocess = ctx.get('subprocess') as SubprocessRuntime
  // 解析二进制绝对路径（可配 command 名或绝对路径）
  let bin: string
  try {
    bin = await subprocess.resolveExecutable(cfg.command, cfg.env)
  } catch (error) {
    throw new Error(`dsh-cli-office: cannot resolve officecli binary "${cfg.command}". ${String(error)}`, { cause: error })
  }
  const office = new OfficeService(ctx, { bin, env: cfg.env, timeoutMs: cfg.timeoutMs, maxOutputBytes: cfg.maxOutputBytes })
  applyOfficeTools(ctx, office)
}
```

***

## 5. 9 个工具全清单与 schema

| # | 工具名             | 作用                                                             | 关键参数                                      | 对应 verb |
| - | --------------- | -------------------------------------------------------------- | ----------------------------------------- | ------- |
| 1 | `office_create` | 建空白文档（docx/xlsx/pptx，扩展名推断类型）                                  | `file`(req), `type?`, `force?`            | create  |
| 2 | `office_get`    | 按路径读取元素（L1 读，标题/段落/单元格）                                        | `file`(req), `path`(req)                  | get     |
| 3 | `office_query`  | 结构化查询文档内容（全表/目录/结构）                                            | `file`(req), `query`(req)                 | query   |
| 4 | `office_set`    | 改已有元素属性（文本/字号/颜色/公式）                                           | `file`,`path`,`props`, `find?`,`replace?` | set     |
| 5 | `office_add`    | 增元素（段落/工作表/幻灯片/图形/图表）                                          | `file`(req), `path?`, `props`             | add     |
| 6 | `office_remove` | 删元素                                                            | `file`(req), `path`(req)                  | remove  |
| 7 | `office_view`   | 渲染（html/svg/screenshot）+ 返回预览 URL                              | `file`(req), `format?`, `page?`           | view    |
| 8 | `office_batch`  | 单趟批量命令，原子回滚                                                    | `file`(req), `commands`                   | batch   |
| 9 | `office_cli`    | 裸命令透传兜底（merge/dump/import/validate/raw/move/swap/load\_skill…） | `argv`                                    | cli     |

### 5.1 示例：office\_set（path 寻址 + props 键值对）

```ts
ctx.tools.register(defineTool({
  name: 'office_set',
  description: 'Modify properties of an Office document element (text, fonts, colors, layout, formulas, ...). Path syntax as in office_get; "set /" targets the whole document. Properties are key=value pairs, e.g. {text:"Revenue grew 25%", bold:true, font:Arial, size:24, color:FF0000}.',
  parameters: {
    file: { type: 'string', required: true },
    path: { type: 'string', required: true },
    props: { type: 'object', additionalProperties: true, required: true },
    find: { type: 'string' },
    replace: { type: 'string' },
  },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        success: { type: 'boolean', required: true },
        path: { type: 'string', required: true },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, v) => [{ type: 'text', text: `Updated ${v.path}.` }],
  },
  timeoutMs: 60_000,
  isConcurrencySafe: () => false,
  async execute(args, exec) {
    const envelope = await office.run({
      verb: 'set', file: args.file, args: [args.path],
      props: stringifyProps(args.props as Record<string, JsonValue>),
      flags: { find: args.find, replace: args.replace },
    }, exec.signal)
    const warnings = warningsOf(envelope.data)
    return { success: true, path: args.path, ...(warnings ? { warnings } : {}) }
  },
}))
```

### 5.2 示例：office\_cli（兜底透传，含只读并发判定）

```ts
ctx.tools.register(defineTool({
  name: 'office_cli',
  description: 'Run an arbitrary officecli command line (the fallback tool). Pass the verb and args as argv, e.g. ["merge","in.pptx","out.pptx","--data","{...}"] or ["validate","report.docx"]. Covers: move, swap, merge, dump, import, validate, raw, raw-set, refresh, help, load_skill.',
  parameters: { argv: { type: 'array', required: true, items: { type: 'string' } } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
        stdout: { type: 'string', required: true },
        stderr: { type: 'string', required: true },
        data: { type: 'json' },
        error: { type: 'object', additionalProperties: true },
      },
    },
    render: (_a, v) => {
      if (v.ok && v.data !== undefined) return [{ type: 'text', text: JSON.stringify(v.data, null, 2) }]
      return [{ type: 'text', text: truncate(v.stdout || v.stderr, 4000) }]
    },
  },
  timeoutMs: 120_000,
  isConcurrencySafe: (args) => isReadOnlyArgv(args.argv),
  async execute(args, exec) {
    const full = office.buildArgv({ verb: 'cli', args: args.argv })
    const raw = await office.runRaw(full, { signal: exec.signal })
    const envelope = parseEnvelope(raw.stdout)
    const result: any = { ok: raw.exitCode === 0, exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr }
    if (envelope?.success) result.data = envelope.data
    if (envelope && !envelope.success) result.error = envelope.error
    return result
  },
}))

function isReadOnlyArgv(argv) {
  const verb = argv[0]?.toLowerCase()
  if (!verb) return true
  return ['get','query','view','validate','raw','help','dump'].includes(verb)
}
```

***

## 6. 落盘可靠性的三层保障（本方案内）

即便 host 包装绕开了受限 shell，仍建议叠加，三者互补：

1. **`ctx.subprocess`** **宿主写盘** —— 天然不受 agent 沙箱限制（核心）。
2. **`OFFICECLI_RESIDENT_FLUSH=each`**（桌面壳已注入）—— 即便有常驻进程，每次 mutation 返回前强制落盘，防内存改动丢盘。
3. **`--json`** **envelope + exitCode 判定** —— 不靠 stdout 文本判断成败；失败走结构化 `OfficeError` 回给模型，避免"误判已保存"。

***

## 7. 关键决策与风险

| 决策点                          | 结论                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| 二进制来源                        | 复用桌面壳已内置/打包的 officecli（`resources/officecli` / `vendor/officecli/<os>-<arch>`），`resolveExecutable` 解析 |
| 是否绕过受限 shell                 | 是，`ctx.subprocess.spawn` 绝对路径调用，不需要 `danger-full-access`                                              |
| 工具数量                         | 9 个（8 类型化 + 1 cli 兜底），覆盖 create/get/query/set/add/remove/view/batch                                   |
| 上下文占用                        | 这 9 个工具**常驻模型上下文**——与用户此前"不希望通用 agent 平时背着 office 工具占上下文"的判断相悖，故本方案标记为**备选**                          |
| 与 office-ai-editor-plugin 关系 | 轻量路线 vs 重型自研引擎路线，可并行评估/分阶段                                                                            |

### 风险

1. **上下文占用**：9 个工具 definition 常驻上下文。缓解：官方 OfficeCLI 的纯 skill 方案（模型 shell 调）不占上下文，但受沙箱影响——两者是"占上下文但稳" vs "省上下文但不稳" 的权衡。可考虑**按需只挂 cli 兜底 1 个工具**，其余靠 skill 指引。
2. **落地门槛**：需按 docs/plugin-development.md 建独立插件（tsdown、cordis.patch.yml、profile 接入）。
3. **dsh-office-tool 代码族**：偏底层的 `office_service`/`watch`/`preview` 部分若不需要实时预览，可整体裁剪，只留 tool+service。

***

## 8. 待定决策（实施前需用户拍板）

1. **插件归属**：新建 `extensions/dsh-cli-office/` 独立插件，还是并入 `extensions/dsh-file-manager/`（复用其 officecli 打包/PATH 注入）？
2. **工具范围**：全量 9 个，还是只挂 `office_cli`（1 个兜底，最小上下文）？
3. **是否配 skill**：要不要配套一个精简 `officecli` skill 讲何时用这些工具（类似官方 SKILL.md 的分诊），以缓解"平时不带工具"的诉求？
4. **是否实施**：本文为存档备选，未排期。

***

### 参考文档

- 参考实现源码：`参考项目\dsh-office-tool/src/`（service.ts / tools/\*.ts / index.ts / config.ts）

- 监管文档：`docs/plugin-development.md`、`docs/plugin-dev-debugging-guide.md`

- 其它路线：`docs/office-ai-editor-plugin.md`（自研 GenOffice/Univer 引擎）

