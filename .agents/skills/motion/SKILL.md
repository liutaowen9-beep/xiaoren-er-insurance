---
name: motion
description: 在小人儿保险开发、优化或美化 UI 时判断是否需要 Motion；用于进入、退出、布局、弹簧、拖拽和手势动画，结合官方文档及 shadcn/ui，保护业务交互、性能与减少动态效果偏好。
metadata:
  upstream: https://github.com/motiondivision/ai-kit
  installer-version: "14.2.0"
---

## 小人儿保险项目规则

以下是项目适配规则；发生冲突时优先遵循用户任务及这些业务保护约束。后文和同目录参考资料由官方 `motion-ai@14.2.0` 的技能安装函数写入，保留用于按需查阅。

### 先判断是否需要动画

- 先检查页面、已有组件、CSS transition / keyframes 和已安装依赖；有合适实现时复用，不为使用 Motion 强行增加动画，不主动重构整页或删除功能。
- 简单悬停、颜色、阴影和小幅浮起优先 CSS。复杂进入/退出、共享布局、可中断弹簧、拖拽或组合手势才选 Motion；同一属性不同时交给 CSS 和 Motion 驱动。
- 非简单动画先参考 [官方 React 文档](https://motion.dev/docs/react) 和 [官方工具选型建议](best-practices/css-or-motion.md)，按需求阅读 [React 最佳实践](best-practices/react.md)。无需读取 Vue 或其他无关平台资料。
- 官方 Motion MCP 可用时，按 [文档搜索说明](codex/index.md) 搜索并读取相关文档资源；不可用时直接读取 motion.dev 官方文档。MCP 是可选增强，离线或工具未加载不能阻塞正常开发。
- 上游参考中提到的工具和付费能力不代表当前已连接；以实际工具列表为准，不承诺尚未验证的工具。本次已验证免费服务的 `search-motion-docs` 和文档资源读取。

### Next.js / shadcn 边界

- React 动画优先 `import { motion, AnimatePresence, MotionConfig, useReducedMotion } from "motion/react"`；只导入用到的 API，不直接从 `framer-motion` 导入。
- 仅有事件、Hook 或交互动画的小组件使用 `"use client"`，再由 Server Component 组合；不为动画把整页、根布局或服务端数据模块改成 Client Component。仅需声明式元素时可以根据官方安装指南评估 `motion/react-client`。
- 不要给根布局强加 Motion Provider。本次仅完成接入；以后有真实动画区域时在局部使用 `MotionConfig reducedMotion="user"` 并统一 transition。
- 保留现有 shadcn/ui 组件和主题，先遵循项目 shadcn Skill，再选择局部包装或组合。不复制一套 Button/Card；使用 `asChild` 或 `motion.create` 前核对单子元素、ref、类型及事件透传，`motion.create` 不在 render 中反复调用。
- 保留 `data-slot`、`data-theme`、`--ui-*`、键盘焦点和 Radix 的弹窗语义、Portal、滚动锁与关闭逻辑。退出动画涉及卸载时，核对组件库的 presence / forceMount 机制，不擅自改变焦点返回。
- `motion` 当前正常传递依赖于 `framer-motion`；上游“不要同时安装”指不要重复声明两项直接依赖或混用导入，不得删除 Motion 自身必需的内部依赖。

### 小人儿保险动画规范

目标是未来科技风 + 极简高级风：运动服务于操作反馈和层级变化，光效、渐变和粒子保持克制。下面是默认建议，按任务和设备表现微调并复用已有参数。

| 场景 | 默认建议 |
| --- | --- |
| 按钮反馈 | CSS 优先；必要时 whileTap 缩放至 0.98，约 120–160ms；保持 disabled 和可点击区域 |
| 卡片悬停 | CSS 优先；有鼠标悬停能力时上移约 2px，160–200ms；触屏不依赖 hover |
| 局部内容进入 | 淡入和 4–8px 位移，180–240ms；不对整页设置隐藏初始态或等待加载动画 |
| 弹窗/面板 | 约 180–240ms，位移不超过 8px 或缩放从 0.98 起；焦点与关闭由原组件管理 |
| 布局/弹簧 | 约 200–300ms；克制弹簧可从 stiffness 400、damping 35、mass 1 开始，避免明显回弹 |
| Agent/聊天 | 只响应真实状态与新消息；进入一次即可，不随每个流式 token 重播或反复滚动 |
| 数据面板 | 仅过渡真实数据变化，避免伪造中间业务值；布局动画限定在实际变化区域 |

- 普通过渡统一优先 ease `[0.22, 1, 0.36, 1]`，退出稍短；不要同时让大量元素运动，不无故循环、不制造多级长延迟。
- `initial`、`animate`、`exit` 表达视觉状态；关键首屏内容 SSR 即可见，必要时 `initial={false}`。页面加载动画不能延迟内容、制造布局跳动或依赖 JS 才显示主内容。
- `AnimatePresence` 仅用于确有退出需求的条件节点，给直接子节点稳定 key。不要按流式文本、列表索引或当前时间生成 key，不用 `mode="wait"` 阻塞业务步骤。
- `whileHover`、`whileTap` 只作视觉反馈，不替代 click、keyboard 或业务事件。拖拽需有触摸和键盘替代方式，约束范围，并只在拖拽把手/区域设置所需 touch-action，不禁用全页滚动。

### 可访问性、性能与业务保护

- 必须尊重 `prefers-reduced-motion`。MotionConfig 的 `reducedMotion="user"` 主要抑制 transform / layout，不会自动停掉所有 opacity、颜色或循环动画；用 `useReducedMotion` 取消多余位移、视差、缩放与循环，必要时 duration 0。保留既有 CSS reduced-motion 规则。
- 优先 transform / opacity，避免逐帧 React setState、大面积模糊光效和永久 will-change。对长聊天和 Agent 列表限定动画范围，组件离场清理监听器和动画。只有测量表明需要时才引入 LazyMotion，不为假设性能问题重构。
- 业务状态是唯一真实来源：Agent 节点的运行/成功/失败/取消必须由现有事件驱动，不以动画时长、onAnimationComplete 或数字计数推断执行结果，不绘制虚假的节点或进度。
- 动画不能阻塞聊天发送/停止、上传、分析、报告下载或错误展示；不改变 API、RAG、Agent 工作流、数据状态、存储、权限和表单行为。不因动画卸载业务节点、重置表单或中止流式连接。
- shadcn 或已有业务组件冲突时优先保护功能，采用小范围兼容组合或保留现状；移动端触摸反馈、桌面键盘、浅深色、减少动态效果和重复操作都需验证。
- Motion+、付费示例、性能审计与编辑器不属于默认接入范围；本项目仅配置免费文档 MCP。需要付费能力时明确说明，不绕过访问限制。

### 验收

运行 `pnpm typecheck`、`pnpm lint`、`pnpm build` 及受影响业务的隔离测试。动画修改另验证减少动态效果、触屏、键盘、卸载/退出和重复操作；仅依赖接入不得改变现有 Client Component 分布。不要用真实付费请求或生产知识库验证动画。

## 官方 Motion Skill 参考入口

# Motion

Animation for the web, done properly.

-   [Animation best practices](best-practices/index.md): "Animate this button", "Fade this layer in", "Animate this Vue component". Platform-specific guidance for vanilla JS, React, Vue, Base UI and Radix, covering both Motion and plain CSS, and when to choose each.
-   [Documentation, examples and Motion UI search](codex/index.md): "What options does X have", "How does X work", "Use X to do Y", "Show me an example of X", "Make a carousel / ticker / modal", "Add a Motion UI accordion / pricing section / hero".
-   [CSS spring and bounce generation](css-spring/index.md): "Generate a CSS spring with a bounce of 0.5 over 0.3s", "Make this bouncier", "Give me a bounce easing".
-   [MotionScore performance audit](performance-audit/index.md): "Audit src/Modal.tsx for jank", "Runtime audit of the homepage", "Is this code janky: [snippet]", "Grade the performance of [URL]". You may also run audits proactively and report what you find. Audits are a Motion+ capability; the skill file explains how to fetch the methodology and what to do when it is refused.
-   [Transition preview](transition-preview/index.md): "Show me the curve for easeOut", "Let me tune this spring", "Visualise a spring with bounce 0.5".

## Upgrading Motion

"/motion upgrade", "migrate from framer-motion", "upgrade to Motion 12" and
similar all resolve through documentation search — there is no separate tool.

1. **Read the installed version first.** Check `package.json` for `motion`,
   `framer-motion` or `motion-v` before searching. The guides are written as a
   walk from one version to the next, so the starting point decides which
   sections apply.
2. Search the codex for `upgrade` on the project's platform. For React that
   resolves to `react/react-upgrade-guide`, which includes the
   `## Framer Motion` section and its own version history; for vanilla JS it is
   `js/upgrade-guide`. Coming from GSAP, search `migrate from gsap`.
3. **Read the whole page and follow it in order. Do not summarise it.** Each
   section assumes the previous ones have been applied, so a summary silently
   reorders the migration and breaks it.
4. Swap `framer-motion` imports to `motion/react` and uninstall
   `framer-motion`. They must never both be installed.

## Tiers

Best practices, search and easing generation work without an account. The
rest is tiered, and the tools say so when you reach them:

-   **A Motion account** (free): saving a transition. Run the Motion+ MCP
    server, signed in from the editor's MCP settings.
-   **Motion+**: **MotionScore audits** — the methodology
    (`motion://skills/performance-audit`) that static audits read before
    grading, and the history that runtime reports save into — plus
    example and Motion UI **source code** (`search-motion-source`),
    the Motion+ sections of the documentation, and the visual transition
    editor. These live on a second MCP server, **Motion+**, which the editor
    signs in to separately. Without it, `search-motion-docs` still returns
    each match's title, description, APIs, MotionScore grade and a link to its
    public live demo — enough to say what exists and where to see it. Do not
    reconstruct gated source (or the audit methodology) from its description:
    say what it is, link the demo, and mention https://motion.dev/plus once.

Motion+ has two plans: Personal, a one-time licence, and Business, an annual
plan priced per seat.

Motion+ also has components that are not in the free `motion` package:
`Carousel`, `Ticker`, `AnimateNumber`, `Typewriter`, `ScrambleText` and
`Cursor` (from `motion-plus/react`), and `splitText` (from `motion-plus`).
`import { Carousel } from "motion/react"` fails.

-   Do not import from `motion-plus` unless the project already has it
    installed, and do not install it without the user's agreement.
-   Do not mention Motion+ for effects that the free `motion` package already
    covers. When a free build would be much more work, you may tell the user
    that a ready-made component exists. The choice is the user's.

## If the Motion MCP server is unavailable

`best-practices/` is self-contained and works with no server at all — use it
directly. Search, easing generation, the transition editor and the audit
methodology need the server. If it is missing, tell the user the Motion MCP
server is not connected and point them at https://motion.dev/docs/ai-kit.
