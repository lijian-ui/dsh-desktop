# dsh 插件 i18n 联动切换开发指南

> 本文档以 `im-gateway` 插件为参考实现，详细说明 dsh 插件如何接入 dsh 全局语言设置，实现 Host 端和客户端 UI 文本的联动切换。**开发新插件时可直接参照本指南。**

---

## 目录

1. [整体架构](#1-整体架构)
2. [语言设置的存储与流转](#2-语言设置的存储与流转)
3. [Host 端 i18n 实现](#3-host-端-i18n-实现)
4. [客户端 i18n 实现](#4-客户端-i18n-实现)
5. [完整代码模板](#5-完整代码模板)
6. [验证清单](#6-验证清单)
7. [常见陷阱](#7-常见陷阱)

---

## 1. 整体架构

dsh 插件分为 **Host 端**（Node.js 进程，处理业务逻辑）和**客户端**（浏览器，渲染设置页面 UI）。两端的 i18n 机制不同但共享同一个语言源：

```
┌─────────────────────────────────────────────────────────────┐
│  ~/.dsh/settings.yaml                                        │
│  locale:                                                     │
│    preference: zh     ← 用户在「设置 → 通用设置 → 语言」切换  │
└────────────────────────┬────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                              ▼
   ┌──────────────┐              ┌──────────────┐
   │   Host 端    │              │   客户端     │
   │              │              │              │
   │ ctx.get(     │              │ ctx.locale   │
   │  'settings') │              │  .register() │
   │  .get(ns)    │              │  .bind()     │
   │  .preference │              │      → t()   │
   │              │              │              │
   │ + 监听       │              │ slot 自动    │
   │ settings/    │              │ 响应语言     │
   │ updated 事件 │              │ 切换重渲染   │
   └──────────────┘              └──────────────┘
```

| 端 | 机制 | 动态切换方式 |
|---|---|---|
| Host 端 | 自建 `Translator` 类，从 `ctx.get('settings')` 读取语言 | 监听 `settings/updated` 事件，重建 Translator |
| 客户端 | `ctx.locale.register()` + `ctx.locale.bind()` | dsh 框架保证 slot 组件自动重渲染 |

---

## 2. 语言设置的存储与流转

### 2.1 存储位置

语言设置存储在用户 home 目录下的 dsh 配置文件：

```yaml
# ~/.dsh/settings.yaml
locale:
  preference: zh    # 'zh' 或 'en'
```

### 2.2 settingsNamespace

dsh 的设置系统使用 **branded string**（类型品牌）来区分命名空间。不能直接用字符串 `'locale'`，必须通过 `settingsNamespace()` 转换：

```typescript
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

const LOCALE_NS = settingsNamespace('locale')  // 类型安全的 namespace
```

### 2.3 用户切换语言的路径

用户在 dsh 界面中切换语言的路径：**设置 → 通用设置 → 语言** → 选择 中文/English。

切换后：
1. `settings.yaml` 中 `locale.preference` 被更新
2. Host 端 `settings/updated` 事件被触发
3. 客户端 locale 服务状态更新，slot 组件自动重渲染

---

## 3. Host 端 i18n 实现

### 3.1 翻译表与 Translator 类

创建 `src/gateway/i18n.ts`：

```typescript
export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const zh: Dict = {
  'cmd.reset.success': '✅ 会话已重置，下一句将开启新一轮。',
  'cmd.model.notFound': '⚠️ 未找到模型「{0}」。输入 /model 查看可用列表。',
  // ... 所有 Host 端文案
}

const en: Dict = {
  'cmd.reset.success': '✅ Session reset. Next message starts a new round.',
  'cmd.model.notFound': '⚠️ Model "{0}" not found. Type /model to see available models.',
  // ... 所有 Host 端文案
}

const dicts: Record<Lang, Dict> = { zh, en }

export class Translator {
  constructor(readonly lang: Lang) {}

  /** 翻译：t(key, ...args)，占位符用 {0} {1} ... */
  t(key: string, ...args: (string | number)[]): string {
    const dict = dicts[this.lang] ?? zh
    let s = dict[key] ?? zh[key] ?? key  // 回退链：当前语言 → zh → key 本身
    for (let i = 0; i < args.length; i++) {
      s = s.replaceAll(`{${i}}`, String(args[i]))
    }
    return s
  }
}

export function createTranslator(lang: Lang): Translator {
  return new Translator(lang)
}
```

**要点：**
- 翻译 key 用**扁平点分命名**（`cmd.reset.success`），不用嵌套对象
- 参数占位用 `{0}` `{1}` ...，通过 `replaceAll` 替换
- 回退链：`dicts[lang]` → `zh` → key 本身（永远不返回 undefined）

### 3.2 读取当前语言

在插件主类中添加 `resolveLang()` 方法：

```typescript
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

private resolveLang(): 'zh' | 'en' {
  try {
    const settings = this.ctx.get('settings') as
      | { get(ns: unknown): { preference?: string } | undefined }
      | undefined
    if (!settings) return 'zh'
    const section = settings.get(settingsNamespace('locale'))
    const pref = section?.preference
    return pref === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'  // settings 服务不可用时回退中文
  }
}
```

**要点：**
- `ctx.get('settings')` 获取 dsh 设置服务
- `settings.get(settingsNamespace('locale'))` 读取 locale 命名空间
- 用 try-catch 包裹，settings 不可用时回退 `'zh'`

### 3.3 初始化 Translator

在插件的 `start()` / `apply()` 方法中：

```typescript
this.t = createTranslator(this.resolveLang())
```

### 3.4 监听语言切换事件

在 `start()` 中注册事件监听器，语言切换时重建 Translator：

```typescript
// 监听全局语言切换（dsh 设置 → 通用设置 → 语言）
this.unsubLocaleChange = this.ctx.root.on('settings/updated', (ns, next) => {
  if (ns !== settingsNamespace('locale')) return  // 只关心 locale 命名空间
  const lang = (next as { preference?: 'zh' | 'en' })?.preference ?? 'zh'
  this.t = createTranslator(lang)  // 重建翻译器
  // 同步更新所有引用了 t 的子模块
  this.questionBroker.t = this.t
})
```

**要点：**
- 必须监听 **`ctx.root`**（根上下文），不是 `ctx`（插件子上下文）——cordis 事件不会跨上下文传播
- `ns` 是 namespace，用 `settingsNamespace('locale')` 比较
- `next` 是更新后的设置值，取 `preference` 字段
- 重建 Translator 后，需要**手动同步**所有引用了 `t` 的子模块

### 3.5 用 getter 让子模块动态获取 Translator

对于 `EventDispatcher` 等在 `start()` 中创建、生命周期长的子模块，用 **getter** 代替直接赋值，确保每次访问都拿到最新 Translator：

```typescript
const self = this
this.eventDispatcher = new EventDispatcher({
  ctx: this.ctx,
  get t() { return self.t },  // getter：每次访问都返回最新的 this.t
  // ...其他参数
})
```

子模块中使用 `this.gw.t.t('key')` 翻译（第一个 `.t` 是 Translator 实例，第二个 `.t` 是翻译方法）：

```typescript
// events.ts
void channel.sendText(convId, this.gw.t.t('evt.turn.failed', detail))
```

### 3.6 清理监听器

在插件的 `stop()` 方法中取消事件订阅，防止内存泄漏：

```typescript
async stop(): Promise<void> {
  this.unsubLocaleChange?.()
  this.unsubSessionEvent?.()
  // ...其他清理
}
```

---

## 4. 客户端 i18n 实现

### 4.1 创建翻译字典

创建 `src/client/client-i18n.ts`：

```typescript
export const zh = {
  'section.label': 'IM 通道',
  'page.title': 'IM 通道',
  'btn.add': '添加通道',
  'btn.cancel': '取消',
  'btn.save': '保存',
  'btn.saving': '保存中…',
  'error.saveFailed': '保存失败（{0}）',
  'modal.editTitle': '编辑通道 · {0}',
  // ... 所有客户端文案
}

export const en = {
  'section.label': 'IM Channels',
  'page.title': 'IM Channels',
  'btn.add': 'Add Channel',
  'btn.cancel': 'Cancel',
  'btn.save': 'Save',
  'btn.saving': 'Saving…',
  'error.saveFailed': 'Save failed ({0})',
  'modal.editTitle': 'Edit Channel · {0}',
  // ... 所有客户端文案
}
```

**要点：**
- 导出 `zh` 和 `en` 两个普通对象（不是 `Dict` 类型，客户端不需要类型约束）
- key 命名风格与 Host 端一致（扁平点分）
- 参数占位同样用 `{0}` `{1}` ...

### 4.2 注册字典并绑定翻译函数

在客户端入口 `src/client/index.ts` 中：

```typescript
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { zh as clientZh, en as clientEn } from './client-i18n.ts'

const I18N_NS = 'your-plugin-name'  // i18n 命名空间，用插件名

// 声明依赖的客户端服务
export const inject = ['slots', 'locale', 'connection', 'remote']

export function apply(ctx: ClientContext): void {
  // 1. 注册双语字典
  ctx.effect(
    () => ctx.locale.register(I18N_NS, { zh: clientZh, en: clientEn }),
    'your-plugin: client dictionaries'
  )

  // 2. 绑定翻译函数
  const t = ctx.locale.bind(I18N_NS)

  // 3. 在 slot 中使用，通过 inject 传递给组件
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'your-section',
    order: 20,
    label: () => t('section.label'),  // label 也用 t()，自动响应切换
    inject: () => ({ t }),            // 通过 inject 传递 t 给组件
  }, YourComponent))
}
```

**要点：**
- `ctx.locale.register(ns, dicts)` 注册字典，用 `ctx.effect()` 包裹确保生命周期正确
- `ctx.locale.bind(ns)` 返回翻译函数 `t(key, params)`，**每次调用时按当前语言查找**
- `inject` 数组必须包含 `'locale'`，否则 `ctx.locale` 不可用
- `t` 通过 slot 的 `inject` 回调传递给组件

### 4.3 翻译函数的调用约定

客户端 `t()` 的参数格式与 Host 端略有不同：

```typescript
// Host 端（Translator.t）：位置参数
t('error.saveFailed', 'timeout')  // → "保存失败（timeout）"

// 客户端（ctx.locale.bind 返回的 t）：对象参数
t('error.saveFailed', { 0: 'timeout' })  // → "保存失败（timeout）"
t('modal.editTitle', { 0: 'DingTalk' })  // → "编辑通道 · DingTalk"
```

### 4.4 组件中接收并使用 t

主组件（slot 组件）：

```typescript
export interface YourComponentProps {
  t: (key: string, params?: Record<string, unknown>) => string
}

export function YourComponent(props: YourComponentProps) {
  const { t } = props

  return createElement('div', null,
    createElement('h2', null, t('page.title')),
    createElement('button', null, t('btn.add')),
  )
}
```

子组件：通过 props 传递 `t`：

```typescript
// 父组件中
createElement(ChildComponent, { t, onClose: ... })

// 子组件
export interface ChildComponentProps {
  t: (key: string, params?: Record<string, unknown>) => string
  onClose: () => void
}
```

### 4.5 动态标签翻译

对于运行时动态值（如通道类型标签），定义辅助函数：

```typescript
const typeLabel = (tp: string): string =>
  tp === 'dingtalk' ? t('type.dingtalk')
  : tp === 'qq' ? t('type.qq')
  : tp === 'weixin' ? t('type.weixin')
  : tp
```

### 4.6 自动响应语言切换

dsh 框架保证：**slot 组件中通过 `t()` 渲染的文本会自动跟随语言切换实时变化**，无需手动刷新或监听事件。这是因为 `t()` 在每次调用时按当前语言查找，语言切换触发 slot 重渲染。

> **重要澄清**：此自动重渲染仅对 **slot outlet 内**的组件生效（通过 `ctx.slots.register()` 注册、由框架 `<SlotOutlet>` 渲染的组件）。如果插件通过 `createRoot()` 直接挂载 React 树到 DOM（如面板、弹窗），那棵树**不在 slot outlet 内**，不会自动重渲染——必须按 §4.7 显式订阅 locale revision。

### 4.7 createRoot 直接渲染的组件

部分插件（如 dsh-term 终端面板、file-manager 文件面板）通过 `createRoot(el).render(...)` 直接挂载 React 树到 DOM，而非走 slot outlet。这类组件**不会**自动响应语言切换，需要显式订阅 locale revision 触发重渲染。

**模式：在组件内用 `useSyncExternalStore` 订阅 `ctx.locale` 的 revision**

```typescript
import { useSyncExternalStore } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

interface PanelProps {
  ctx: ClientContext  // 通过 props 传入，ctx.locale 可用（inject 含 'locale'）
  // ...
}

export function Panel({ ctx, ...rest }: PanelProps): JSX.Element {
  // 订阅 locale revision —— 语言切换时 revision 变化，触发重渲染，
  // 组件重新执行 t() 拿到新语言文本。
  useSyncExternalStore(
    (cb: () => void) => ctx.locale.subscribe(cb),
    () => ctx.locale.getSnapshot().revision,
  )

  // ... 正常渲染，t() 在每次渲染时读当前语言
}
```

**如果组件使用模块级 `t` 函数（而非 props 传入的 t）**，还需确保 `t` 委托给 `ctx.locale.bind` 的响应式闭包，而非自定义全局变量：

```typescript
// locales.ts —— t 委托给 ctx.locale.bind 的响应式 t
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

let _boundT: TranslateNS<'your-plugin'> | null = null

/** 在 client index.ts 的 apply 中调用：bindT(ctx.locale.bind(NS)) */
export function bindT(t: TranslateNS<'your-plugin'>): void { _boundT = t }

export function t(key: YourKey, params?: Record<string, string | number>): string {
  if (_boundT !== null) return _boundT(key, params)  // 响应式：读当前 locale
  // fallback：自定义全局变量（bindT 未调用时）
  const table = dictionaries[currentLanguage] ?? zh
  return params === undefined ? table[key] : format(table[key], params)
}
```

```typescript
// src/client/index.ts —— apply 中绑定
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), '...')
  bindT(ctx.locale.bind(NS))  // 让 locales.ts 的 t 委托给响应式 t
  // ... createRoot 渲染面板（面板内 useSyncExternalStore 订阅 revision）
}
```

**要点：**
- `ctx.locale.subscribe(cb)` 返回 unsubscribe，`useSyncExternalStore` 自动管理生命周期
- `ctx.locale.getSnapshot().revision` 是单调递增的数字，语言切换时 +1
- `ctx.locale` 可用的前提是 `inject` 数组包含 `'locale'`
- **不要**用 `MutationObserver` 观察 `document.documentElement.lang` 来感知语言切换——dsh locale 切换不保证修改 `<html lang>` 属性，且即使感知到也不触发 React 重渲染

---

## 5. 完整代码模板

### 5.1 文件结构

```
extensions/your-plugin/
├── src/
│   ├── gateway/
│   │   ├── i18n.ts           ← Host 端翻译表 + Translator 类
│   │   └── your-plugin.ts    ← 插件主类（resolveLang + 事件监听）
│   └── client/
│       ├── client-i18n.ts    ← 客户端翻译字典
│       ├── index.ts          ← 客户端入口（register + bind）
│       └── YourComponent.ts  ← UI 组件（通过 props 接收 t）
└── ...
```

### 5.2 Host 端最小模板

```typescript
// src/gateway/i18n.ts
export type Lang = 'zh' | 'en'
const zh = { 'hello': '你好，{0}！' }
const en = { 'hello': 'Hello, {0}!' }
const dicts = { zh, en }

export class Translator {
  constructor(readonly lang: Lang) {}
  t(key: string, ...args: (string | number)[]): string {
    let s = dicts[this.lang]?.[key] ?? zh[key] ?? key
    for (let i = 0; i < args.length; i++) s = s.replaceAll(`{${i}}`, String(args[i]))
    return s
  }
}
export const createTranslator = (lang: Lang) => new Translator(lang)
```

```typescript
// src/gateway/your-plugin.ts（关键片段）
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createTranslator } from './i18n'

class YourPlugin {
  private t = createTranslator('zh')
  private unsubLocaleChange?: () => void

  private resolveLang(): 'zh' | 'en' {
    try {
      const settings = this.ctx.get('settings') as
        | { get(ns: unknown): { preference?: string } | undefined } | undefined
      return settings?.get(settingsNamespace('locale'))?.preference === 'en' ? 'en' : 'zh'
    } catch { return 'zh' }
  }

  async start() {
    this.t = createTranslator(this.resolveLang())
    this.unsubLocaleChange = this.ctx.root.on('settings/updated', (ns, next) => {
      if (ns !== settingsNamespace('locale')) return
      this.t = createTranslator((next as { preference?: 'zh' | 'en' })?.preference ?? 'zh')
    })
  }

  async stop() {
    this.unsubLocaleChange?.()
  }
}
```

### 5.3 客户端最小模板

```typescript
// src/client/client-i18n.ts
export const zh = { 'section.label': '我的插件', 'btn.save': '保存' }
export const en = { 'section.label': 'My Plugin', 'btn.save': 'Save' }
```

```typescript
// src/client/index.ts
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { zh, en } from './client-i18n.ts'

const I18N_NS = 'your-plugin'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(I18N_NS, { zh, en }), 'your-plugin: dictionaries')
  const t = ctx.locale.bind(I18N_NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'your-section',
    order: 30,
    label: () => t('section.label'),
    inject: () => ({ t }),
  }, YourComponent))
}
```

---

## 6. 验证清单

实现完成后，按以下步骤验证：

- [ ] `npx tsdown` 构建无错误
- [ ] `npm test` 全部测试通过
- [ ] 启动 dsh，打开插件的设置页面，确认默认显示中文
- [ ] 进入「设置 → 通用设置 → 语言」，切换为 English
- [ ] 返回插件设置页面，确认所有 UI 文本已切换为英文：
  - 页面标题
  - 按钮（添加/编辑/删除/保存/取消）
  - 表单字段标签和 placeholder
  - 弹窗标题和确认文案
  - 状态标签（已连接/未启用等）
  - 错误消息
- [ ] 切换回中文，确认所有文本恢复
- [ ] 在 IM 通道中发送消息，确认 Host 端回复文案也跟随语言设置（如 `/help` 命令的回复）
- [ ] **如果插件有 `createRoot` 直接渲染的面板**（如终端面板、文件面板）：切换语言后确认面板内文本也实时切换（若不切换，说明缺少 `useSyncExternalStore` 订阅 locale revision，见 §4.7）

---

## 7. 常见陷阱

### 7.1 Host 端事件监听必须用 ctx.root

```typescript
// ❌ 错误：监听插件子上下文，收不到事件
this.ctx.on('settings/updated', ...)

// ✅ 正确：监听根上下文
this.ctx.root.on('settings/updated', ...)
```

cordis 事件不会跨上下文传播，`settings/updated` 由设置服务在根上下文上触发。

### 7.2 settingsNamespace 不能用裸字符串

```typescript
// ❌ 错误：类型不匹配
settings.get('locale')

// ✅ 正确：用 settingsNamespace 转换
settings.get(settingsNamespace('locale'))
```

### 7.3 客户端 inject 必须声明 'locale'

```typescript
// ❌ 错误：缺少 'locale'，ctx.locale 为 undefined
export const inject = ['slots']

// ✅ 正确
export const inject = ['slots', 'locale']
```

### 7.4 客户端 t() 参数用对象不用位置参数

```typescript
// ❌ 错误：Host 端风格的位置参数
t('error.saveFailed', 'timeout')

// ✅ 正确：客户端用对象参数
t('error.saveFailed', { 0: 'timeout' })
```

### 7.5 子模块的 Translator 引用要同步更新

重建 Translator 后，所有直接持有旧 Translator 引用的子模块都需要更新：

```typescript
this.t = createTranslator(lang)
this.questionBroker.t = this.t  // ← 别忘了同步
```

或者用 getter 避免手动同步：

```typescript
get t() { return self.t }  // EventDispatcher 通过 getter 访问，无需手动同步
```

### 7.6 翻译 key 要在 zh 和 en 中都定义

如果某个 key 只在 `en` 中定义、`zh` 中缺失，中文环境下会回退到 key 本身（显示原始 key 字符串）。确保两个字典的 key 集合一致。

### 7.7 客户端组件不要缓存 t 的返回值

```typescript
// ❌ 错误：缓存了翻译结果，语言切换后不会更新
const title = t('page.title')  // 在模块顶层或 useMemo 中缓存

// ✅ 正确：在渲染函数内调用，每次渲染都重新翻译
function Component() {
  return createElement('h2', null, t('page.title'))
}
```

### 7.8 createRoot 直接渲染的组件不会自动响应语言切换

slot outlet 内的组件由框架的 `useLocaleRevision` 保证语言切换时重渲染，但 `createRoot(el).render(...)` 直接挂载的 React 树**绕过了 slot outlet**，不会自动重渲染。

```typescript
// ❌ 错误：createRoot 挂载的面板，语言切换时不会重渲染
const root = createRoot(col)
root.render(createElement(MyPanel, { ctx, t }))
// 切换语言后，面板里的文本仍是旧语言
```

```typescript
// ✅ 正确：在组件内显式订阅 locale revision
function MyPanel({ ctx, t }: PanelProps) {
  useSyncExternalStore(
    (cb) => ctx.locale.subscribe(cb),
    () => ctx.locale.getSnapshot().revision,
  )
  return createElement('h2', null, t('panel.title'))  // 重渲染时读新语言
}
```

详见 §4.7。

### 7.9 不要用全局变量 + MutationObserver 替代 ctx.locale.bind

一种看似可行但实际不可靠的模式：用模块级全局变量 `currentLanguage` + `MutationObserver` 观察 `<html lang>` 属性变化来感知语言切换。这有两个致命问题：

1. **dsh locale 切换不保证修改 `<html lang>` 属性**——MutationObserver 可能永远不触发
2. **即使感知到切换，也不触发 React 重渲染**——`setLanguage('en')` 只改全局变量，createRoot 挂载的组件不会重新执行 `t()`

```typescript
// ❌ 错误：依赖 <html lang> 属性变化 + 全局变量
let currentLanguage = 'zh'
const observer = new MutationObserver(() => {
  currentLanguage = document.documentElement.lang.startsWith('zh') ? 'zh' : 'en'
})
observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
// 问题1：<html lang> 可能不变；问题2：currentLanguage 变了但组件不重渲染
```

```typescript
// ✅ 正确：用 ctx.locale.bind 获取响应式 t + useSyncExternalStore 订阅 revision
const t = ctx.locale.bind(NS)  // t() 每次调用读当前 locale snapshot
// + 组件内 useSyncExternalStore 订阅 revision 触发重渲染
```

---

## 附录：参考实现

本文档的所有代码模式均来自 `extensions/im-gateway` 插件的实际实现：

| 文件 | 说明 |
|---|---|
| `src/gateway/i18n.ts` | Host 端翻译表 + Translator 类 |
| `src/gateway/im-gateway.ts:269` | 初始化 Translator |
| `src/gateway/im-gateway.ts:281-286` | settings/updated 事件监听 |
| `src/gateway/im-gateway.ts:616-628` | resolveLang() 方法 |
| `src/gateway/im-gateway.ts:274` | getter 传递 Translator 给 EventDispatcher |
| `src/client/client-i18n.ts` | 客户端翻译字典 |
| `src/client/index.ts:61-66` | register + bind |
| `src/client/index.ts:72-73` | slot inject 传递 t |
| `src/client/ImChannelsSection.ts:29` | 组件 props 接收 t |
| `src/client/ImChannelModal.ts:80` | 子组件 props 接收 t |