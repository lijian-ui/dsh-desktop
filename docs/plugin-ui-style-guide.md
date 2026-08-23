# dsh 插件 UI 样式适配指南

> 本文档说明 dsh 官方样式系统的架构（设计 token + 原子组件），并给出插件开发中适配官方样式的三种策略与推荐方案。**开发新插件 UI 时直接参照本指南。**

---

## 目录

1. [官方样式系统架构](#1-官方样式系统架构)
2. [Token 层详解](#2-token-层详解)
3. [原子组件层详解](#3-原子组件层详解)
4. [插件 UI 适配策略](#4-插件-ui-适配策略)
5. [实践指南](#5-实践指南)
6. [常用 Token 速查表](#6-常用-token-速查表)
7. [注意事项与踩坑](#7-注意事项与踩坑)

---

## 1. 官方样式系统架构

dsh 官方采用 **「设计 token + 原子组件」两层架构**，全部基于 **CSS Modules + CSS 自定义属性（CSS Variables）**。

**不使用 Tailwind，不使用 styled-components / emotion / stitches 等运行时 CSS-in-JS 方案。**

| 层级 | 包名 | 职责 |
|------|------|------|
| 设计 Token 层 | `@deepseek-ai/dsh-client-ui-theme` | 定义 `--dsw-*` CSS 变量（静态色板 + 语义别名 + 字体），管理 light/dark/system 主题 |
| 原子组件层 | `@deepseek-ai/dsh-client-ui-primitives` | 纯 React 原子组件（Button/Input/Menu/Modal 等），零 cordis，样式只通过 `--dsw-*` token 消费 |
| 品牌层 | `@deepseek-ai/dsh-client-ui-brand-official` | 官方 DeepSeek 品牌占位（侧边栏、对话 Hero 槽位） |

### 技术栈认定

| 维度 | 结论 |
|------|------|
| Tailwind | 未使用 |
| styled-components / emotion / stitches / linaria | 未使用 |
| CSS Modules | 使用（`.module.css` 文件） |
| CSS 自定义属性（Design Token） | 使用，命名空间 `--dsw-*` |
| 主题切换 | `body[data-ds-dark-theme]` 属性 + `prefers-color-scheme`，由 `dsh-client-ui-theme` 的 `ThemeRuntime` 管理 |

### 样式注入时机

Token 由 `dsh-client-ui-theme` 的客户端 entry 在启动时注入到 `<head>`。所有 `dsh-client-ui-*` 包共享同一套 `--dsw-*` token，无需各自定义。插件 UI 运行时，这些 token 已就绪，直接引用即可。

---

## 2. Token 层详解

### 2.1 三层 token 架构

`dsh-client-ui-theme` 的 `src/styles/` 下有 5 张样式表：

| 样式表 | 作用 |
|--------|------|
| `base.css` | 字体与动效基底（`--dsw-font-family`、`--ds-ease-in-out`、`--ds-transition-duration*`） |
| `design-platform.css` | **Token 唯一权威来源**：静态色板 + 语义别名（light + dark 覆盖） |
| `scrollbar.css` | 滚动条主题化 |
| `gradient-shadow-text.css` | 渐变/阴影/Markdown 字体（`--dsw-shadow-lv1/2/3`、`--dsw-font-markdown-h1~h4`） |
| `shiki.css` | 代码高亮 token 映射 |

### 2.2 静态色板（`--dsw-static-*`）

直接命名颜色与色阶，**不建议在插件中直接引用**（应通过语义别名间接消费）。

| 色族 | 色阶示例 | 说明 |
|------|----------|------|
| `deepseek` | 50~900 | 品牌色（`--dsw-static-deepseek-500:#4176e6`） |
| `neutral` | 00~1000 | 中性色（`00:#fff`、`1000:#000`） |
| `neutral-bluish` | 00~1000 | 偏蓝中性色（暗色模式主力） |
| `blue` | 50~950 | 功能蓝 |
| `amber` / `green` / `red` | 50~900 | 状态色 |

### 2.3 语义别名（`--dsw-alias-*`）

**插件中应引用的 token 层**。每个别名在亮色和暗色模式下自动取不同值。

| 别名族 | 示例 token | 用途 |
|--------|-----------|------|
| `--dsw-alias-bg-*` | `bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-layer-3` / `bg-overlay` / `bg-mask-1` | 背景层级（base → layer-3 逐层浮起） |
| `--dsw-alias-border-*` | `border-l1` / `border-l2` / `border-l3` / `border-l4` | 边框层级 |
| `--dsw-alias-label-*` | `label-primary` / `label-secondary` / `label-tertiary` / `label-dimmed` | 文字色阶（primary 最强 → dimmed 最弱） |
| `--dsw-alias-brand-*` | `brand-primary` / `brand-text` | 品牌色 |
| `--dsw-alias-button-*` | `button-primary-fill` / `button-primary-hover` / `button-tool-bar-fill` / `button-ghost-active-fill` | 按钮族 |
| `--dsw-alias-interactive-*` | `interactive-bg-hover` / `interactive-bg-active` / `interactive-bg-hover-solid` | 交互态 |
| `--dsw-alias-state-*` | `state-error-primary` / `state-success-primary` / `state-warn-primary` / `state-business-primary` | 状态色 |
| `--dsw-alias-label-primary-foreground` | — | primary 按钮上的文字色（亮色 `#fff`，暗色 `#0f1115`） |
| `--dsw-shadow-lv1` / `lv2` / `lv3` | — | 阴影层级 |
| `--dsw-alias-font-family-mono` | — | 等宽字体 |

### 2.4 暗色模式机制

```css
/* 亮色模式（默认） */
body { --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-50); ... }

/* 暗色模式覆盖 */
body[data-ds-dark-theme] { --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-850); ... }
```

`dsh-client-ui-theme` 的 `ThemeRuntime` 根据用户设置（light / dark / system）在 `<body>` 上切换 `data-ds-dark-theme` 属性，所有别名 token 自动更新，**插件无需任何额外处理**。

---

## 3. 原子组件层详解

`@deepseek-ai/dsh-client-ui-primitives` — "Pure React atoms for the dsh web UI: zero cordis, styled only through `--dsw-*` tokens."

### 3.1 导出的原子组件

| 类别 | 组件 |
|------|------|
| 控件 | `Button`、`Input`、`Menu`、`Modal`、`Pill`、`Tooltip`、`Toast`、`HoverCard`、`DisclosureRow`、`OnboardingSurface`、`RiskConfirmation` |
| 状态/标识 | `StateDot`、`FishLogo`、`BrandWordmark`、`ConnectionBanner` |
| 内容块 | `TerminalBlock`、`ReadBlock`、`DiffBlock`、`SearchBlock`、`WebBlock`、`JsonTree` |
| Markdown | `MarkdownText`、`MessageText`、`CodeBlock`、`JsonBlock`、`extractMarkdownPlainText` |
| 图标 | `ic_ds_*` 系列图标（`IconSearchOutline16`、`IconSkillOutline16` 等） |
| Hooks | `useAnchoredMaxHeight`、`useAnchoredPosition`、`useDismissOnOutsidePointer`、`writeClipboard` |

### 3.2 Button 组件

```ts
type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar';

Button({ variant, size, icon, className, children, ...rest }: {
  variant?: ButtonVariant;   // 默认 'ghost'
  size?: 'md' | 'sm';        // 'md' 36px / 'sm' 28px
  icon?: ReactNode;          // 可选前导 16px 图标
  className?: string;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>)
```

样式（胶囊状，来自 figma 1:1 还原）：
- `md`: h36, padding 14/7, gap 4, border-radius 18
- `sm`: h28, padding 10, border-radius 14
- `primary`: 品牌色填充
- `ghost`: 透明背景，hover 时 `interactive-bg-hover`
- `outline`: 透明背景 + `border-l2` 边框
- `toolbar`: `button-tool-bar-fill` 背景

### 3.3 导入方式

```ts
// 从 primitives 直接导入组件和图标
import { Button, Input, MarkdownText, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
```

---

## 4. 插件 UI 适配策略

### 4.1 三种策略对比

| 策略 | 官方改组件 API | 官方改 token 名 | 样式统一性 | 适配成本 |
|------|---------------|----------------|-----------|---------|
| **A. 全用官方 primitives** | 要适配（TS 编译期能发现） | 不影响 | 完全统一 | 高（API 跟随官方） |
| **B. 只用 `--dsw-*` token，自己写组件** | 不影响 | 要适配（概率低） | 视觉统一 | 低（推荐） |
| **C. 完全独立** | 不影响 | 不影响 | 可能脱节 | 无（但样式不统一） |

### 4.2 推荐策略 B：只用 token，自己写组件

**理由：**

1. dsh 还在 `0.1.x-rc` 阶段，组件 API 变动频繁，但 **token 命名相对稳定**（它是底层契约，改 token 会波及官方自己所有包）
2. 组件 API 自己控制，不会被官方 breaking change 带着走
3. 颜色、圆角、字号自动跟官方主题同步，暗色模式也自动适配
4. 只在需要 Markdown 渲染、图标等复杂组件时，才从 `primitives` 导入（这些组件 API 更稳定）

**做法：**
- 从 `@deepseek-ai/dsh-client-ui-primitives` 导入图标（`Icon*`）和 `MarkdownText` 等无状态渲染组件
- 自己写 Button、Input、Switch、Modal 等交互组件，CSS 中引用 `--dsw-*` token
- **绝不使用硬编码颜色**（`#fff`、`#ccc`、`rgba(0,0,0,...)`），全部用 token

### 4.3 策略 A 适用场景

- 你的插件 UI 非常简单，只用几个按钮和输入框
- 你希望 100% 视觉统一，包括 hover/active/disabled 微交互
- 你愿意跟随官方 API 升级

---

## 5. 实践指南

### 5.1 CSS 注入方式

dsh 插件的 client 端运行在浏览器中，没有 CSS Modules 构建管线。推荐用 **运行时注入 `<style>` 标签** 的方式：

```tsx
const CSS_TEXT = `
.my-plugin-section { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); }
.my-plugin-button { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
`

const TAG_ID = '@your-scope/your-plugin/YourComponent.module.css'

function injectCss(): void {
  if (typeof document !== 'undefined' && !document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@your-scope/your-plugin'
    tag.dataset.pluginCss = TAG_ID
    tag.textContent = CSS_TEXT
    document.head.appendChild(tag)
  }
}

export function MyComponent(): ReactNode {
  useEffect(() => { injectCss() }, [])
  return <div className="my-plugin-section">...</div>
}
```

**要点：**
- `TAG_ID` 用包名 + 文件名保证全局唯一
- `document.querySelector` 检查避免重复注入（React 18 StrictMode 下 useEffect 会执行两次）
- CSS 类名加前缀（如 `SKM_`、`MY_`）避免与官方样式冲突

### 5.2 引用 token 的规则

```css
/* ✅ 正确：引用语义别名 */
color: var(--dsw-alias-label-primary);
background: var(--dsw-alias-bg-layer-3);
border: 1px solid var(--dsw-alias-border-l2);
box-shadow: var(--dsw-shadow-lv2);

/* ✅ 正确：引用字体 token */
font-family: var(--dsw-alias-font-family-mono, ui-monospace, monospace);

/* ❌ 错误：引用静态色板（应通过别名间接消费） */
color: var(--dsw-static-neutral-900);

/* ❌ 错误：硬编码颜色（暗色模式不适配） */
color: #fff;
background: rgba(0, 0, 0, 0.5);

/* ❌ 错误：多余的 fallback（token 一定会被注入） */
border: 1px solid var(--dsw-alias-border-l2, #ccc);
```

### 5.3 遮罩层

用 `--dsw-alias-bg-mask-1`（亮色 `#0000003d`，暗色 `#00000080`），不要自己写 `rgba(0,0,0,...)`：

```css
/* ✅ */
.overlay { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1); }

/* ❌ */
.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); }
```

### 5.4 Primary 按钮文字色

primary 按钮上的文字/图标色用 `--dsw-alias-label-primary-foreground`（亮色 `#fff`，暗色 `#0f1115`），不要硬编码 `#fff`：

```css
/* ✅ */
.confirm-btn { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); }

/* ❌ */
.confirm-btn { background: var(--dsw-alias-state-business-primary); color: #fff; }
```

### 5.5 从 primitives 导入图标和 Markdown

```tsx
// ✅ 导入图标（无状态，API 稳定）
import { IconSearchOutline16, IconSkillOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

// 使用
<IconSearchOutline16 />
<MarkdownText text={markdownBody} />
```

### 5.6 完整示例

```tsx
import { useEffect, type ReactNode } from 'react'
import { IconSearchOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

const CSS_TEXT = `
.MP_section { width: 100%; max-width: 760px; display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
.MP_search { position: relative; display: flex; align-items: center; }
.MP_search > svg { pointer-events: none; position: absolute; left: 12px; }
.MP_searchInput {
  width: 100%; height: 36px; font: inherit; font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; outline: none; padding: 0 34px 0 36px;
}
.MP_searchInput::placeholder { color: var(--dsw-alias-label-tertiary); }
.MP_searchInput:focus-visible { border-color: var(--dsw-alias-state-business-primary); }
.MP_card {
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-3);
  border-radius: 10px; overflow: hidden;
}
.MP_cardTitle { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.MP_cardDesc { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.MP_overlay { position: fixed; inset: 0; background: var(--dsw-alias-bg-mask-1); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.MP_dialog { background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: var(--dsw-shadow-lv2); }
.MP_confirmBtn { background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-foreground); border: none; border-radius: 8px; padding: 6px 16px; }
.MP_cancelBtn { background: transparent; color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 16px; }
.MP_cancelBtn:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
`

const TAG_ID = '@my-scope/my-plugin/MyPanel.module.css'

function injectCss(): void {
  if (typeof document !== 'undefined' && !document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) {
    const tag = document.createElement('style')
    tag.dataset.pluginCss = TAG_ID
    tag.textContent = CSS_TEXT
    document.head.appendChild(tag)
  }
}

export function MyPanel(): ReactNode {
  useEffect(() => { injectCss() }, [])
  return (
    <div className="MP_section">
      <div className="MP_search">
        <IconSearchOutline16 />
        <input className="MP_searchInput" placeholder="搜索..." />
      </div>
      <div className="MP_card">
        <p className="MP_cardTitle">标题</p>
        <p className="MP_cardDesc">描述</p>
      </div>
    </div>
  )
}
```

---

## 6. 常用 Token 速查表

### 背景层

| Token | 亮色 | 暗色 | 用途 |
|-------|------|------|------|
| `--dsw-alias-bg-base` | 最浅 | 最深 | 页面底色 |
| `--dsw-alias-bg-layer-1` | | | 卡片内嵌区域 |
| `--dsw-alias-bg-layer-2` | | | 代码块背景 |
| `--dsw-alias-bg-layer-3` | | | 卡片/弹窗背景 |
| `--dsw-alias-bg-overlay` | | | 浮层背景 |
| `--dsw-alias-bg-mask-1` | `#0000003d` | `#00000080` | 遮罩层 |

### 边框层

| Token | 用途 |
|-------|------|
| `--dsw-alias-border-l1` | 最强边框（弹窗外框） |
| `--dsw-alias-border-l2` | 常规边框（卡片、输入框） |
| `--dsw-alias-border-l3` | 弱边框（分割线） |
| `--dsw-alias-border-l4` | 最弱边框 |

### 文字色阶

| Token | 用途 |
|-------|------|
| `--dsw-alias-label-primary` | 主要文字 |
| `--dsw-alias-label-secondary` | 次要文字 |
| `--dsw-alias-label-tertiary` | 辅助文字、占位符 |
| `--dsw-alias-label-dimmed` | 禁用文字 |
| `--dsw-alias-label-primary-foreground` | primary 按钮上的文字色 |

### 状态色

| Token | 用途 |
|-------|------|
| `--dsw-alias-state-error-primary` | 错误/删除 |
| `--dsw-alias-state-success-primary` | 成功 |
| `--dsw-alias-state-warn-primary` | 警告 |
| `--dsw-alias-state-business-primary` | 品牌主色（聚焦、选中） |

### 交互态

| Token | 用途 |
|-------|------|
| `--dsw-alias-interactive-bg-hover` | hover 背景（半透明） |
| `--dsw-alias-interactive-bg-active` | active 背景 |
| `--dsw-alias-interactive-bg-hover-solid` | hover 背景（实色） |

### 阴影

| Token | 用途 |
|-------|------|
| `--dsw-shadow-lv1` | 轻微阴影（下拉菜单） |
| `--dsw-shadow-lv2` | 中等阴影（弹窗） |
| `--dsw-shadow-lv3` | 重阴影（全屏遮罩内弹窗） |

### 字体

| Token | 用途 |
|-------|------|
| `--dsw-alias-font-family-mono` | 等宽字体 |

---

## 7. 注意事项与踩坑

### 7.1 不要直接引用静态色板

```css
/* ❌ */
color: var(--dsw-static-neutral-900);

/* ✅ */
color: var(--dsw-alias-label-primary);
```

静态色板是底层原料，语义别名才是消费层。直接引用 `--dsw-static-*` 会在暗色模式下取到错误值。

### 7.2 不要给 token 加 fallback

```css
/* ❌ — token 一定会被注入，fallback 多余且掩盖问题 */
border: 1px solid var(--dsw-alias-border-l2, #ccc);

/* ✅ */
border: 1px solid var(--dsw-alias-border-l2);
```

### 7.3 不要硬编码颜色

所有 `#fff`、`#ccc`、`rgba(0,0,0,...)` 都应替换为对应 token。唯一例外是 `box-shadow` 中的轻微阴影色（如 `rgba(0,0,0,.25)`），因为阴影在亮暗模式下都需要一点深度感。

### 7.4 CSS 类名加前缀

插件 CSS 运行在全局作用域，类名必须加前缀避免冲突：

```css
/* ❌ */
.card { ... }
.button { ... }

/* ✅ */
.SKM_card { ... }
.SKM_button { ... }
```

### 7.5 React 18 StrictMode 重复注入

`useEffect` 在 StrictMode 下会执行两次。`injectCss` 必须用 `document.querySelector` 做幂等检查：

```tsx
function injectCss(): void {
  if (typeof document !== 'undefined' && !document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) {
    // 只在不存在时注入
  }
}
```

### 7.6 从 primitives 导入的选择性

| 组件类型 | 是否推荐直接导入 | 理由 |
|----------|-----------------|------|
| 图标（`Icon*`） | ✅ 推荐 | 无状态纯渲染，API 极稳定 |
| `MarkdownText` | ✅ 推荐 | 复杂渲染，自己实现成本高 |
| `Button` / `Input` | ⚠️ 谨慎 | API 可能随官方升级变动 |
| `Modal` / `Menu` | ⚠️ 谨慎 | 交互逻辑复杂，自己写更可控 |

### 7.7 参考实现

`@lijian-ui/dsh-skill-manage` 插件是策略 B 的完整参考实现：
- `extensions/dsh-skill-manage/src/client/SkillManageSection.tsx` — 主组件
- 所有 CSS 引用 `--dsw-*` token，自己写 Button/Switch/Modal/Input
- 从 primitives 导入 `IconSearchOutline16`、`IconSkillOutline16`、`MarkdownText`