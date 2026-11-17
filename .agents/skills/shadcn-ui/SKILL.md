---
name: shadcn-ui
description: 在小人儿保险开发、修改或美化页面和 UI 组件时使用，优先复用项目内 shadcn/ui 基础组件并保持品牌、主题与业务行为兼容。
---

# 小人儿保险 UI 开发

## 先检查再选择

- 开发或修改 UI 时，先读取 `components.json`、`src/components/ui/` 和相关业务组件，检查是否已有合适的组件、变体或组合。
- 优先从 `@/components/ui/<name>` 复用基础组件。已有 Button、Card、Badge、Input、Textarea、Separator；以当前目录为准，不重复创建同用途基础组件。
- 业务组件保留原位置，通过组合基础组件实现界面。无需为了使用 shadcn 而改写业务流程或替换整页。
- 缺少合适组件时，先检查官方文档和 CLI 帮助，使用项目包管理器 pnpm 按需安装。优先用成熟组件处理弹窗、菜单、选择器、焦点管理等复杂交互。

## 按需扩展

本次接入使用官方 CLI 4.23.0；这是可复现基线，升级前核对官方变更。

```powershell
pnpm dlx shadcn@4.23.0 add <component> --dry-run
pnpm dlx shadcn@4.23.0 add <component>
```

- 预览文件、依赖和 CSS 变化；只加入当前需求必要的组件。不要使用 `--all`、`--overwrite`、强制初始化或全量主题替换。
- 保留 `components.json` 的 `new-york`、RSC、TSX、`@/*` 别名及 Tailwind v4 配置；不要添加 v3 的 Tailwind 配置文件。
- 检查 CLI 生成的导入和依赖，组件内统一通过 `@/lib/utils` 使用 `cn`。复用现有 Lucide 和按需的 `@radix-ui/react-*` 包，避免为少数组件引入整个 `radix-ui` 聚合包或多套交互基础库。
- 新组件若引用标准 `--muted`、`--accent`、`--radius` 等变量，改用本项目语义工具类或 `--ui-*`，不要覆盖旧变量。只有实际需要动画组件时再增加动画依赖。
- 新组件需要的 React 客户端边界遵循官方实现，不将整个页面或根布局转为客户端组件。

## 主题与样式兼容

- CSS 入口是 `src/app/globals.css`，主题适配集中在 `src/app/ui-theme.css`；Tailwind v4 使用 `@theme inline`。
- 保留 `BrandProvider`、`html[data-theme="dark"]`、`moyu-theme` 和 `moyu-branding-v1`；不引入独立主题状态或改写存储格式。
- 保留旧 `--bg`、`--text`、`--muted`、`--accent`、`--sidebar` 等变量。尤其旧 `--muted` 是文字色，shadcn muted 是背景色；由独立 `--ui-*` 映射解决冲突。
- `--ui-primary` 跟随 `--brand-solid`，前景跟随 `--on-brand`；品牌修改、浅色和深色模式都必须生效。
- 新组件保留 `data-slot`。全局旧控件重置已避开带 `data-slot` 的控件；旧页面的后代选择器仍可能覆盖 Tailwind utilities，迁移时检查计算样式，不盲目叠加旧控件类。
- `cn` 用于合并 Tailwind 类，不能解决 CSS 层叠优先级。浮层通过 Portal 挂载时仍需继承根节点主题，验证层级、滚动锁和焦点返回。
- 限定旧全局重置时使用 `:where(:not([data-slot]))`，保持原选择器优先级；直接使用 `:not([data-slot])` 会增加优先级并可能破坏旧按钮样式。

## 品牌视觉与功能保护

- 目标风格是未来科技风 + 极简高级风：冷色系科技背景、清晰卡片层级、统一字体与间距、统一圆角阴影、克制渐变和光效、适量动画，兼容桌面与移动端。
- shadcn 是基础组件，小人儿保险品牌是最终标准；允许按品牌调整样式与变体，但保持全站按钮、表单、弹窗一致。
- 此接入不自动改变现有品牌配色。仅在用户要求视觉改造时推进目标风格，遵循 `prefers-reduced-motion` 并检查文字对比度、键盘焦点和触屏尺寸。
- 不得为了使用组件改变业务逻辑或擅自删除功能。保护 Agent 工作流、RAG、聊天、分析、报告、路由、API、权限判断、事件处理、流式输出和取消行为。
- 组件库与业务组件冲突时，优先保护业务功能，采用兼容封装或保留现有组件。替换表单需核对 `type`、原生事件与 `onValueChange` 等回调区别、禁用状态和中文输入法行为。

## 验收

执行与改动匹配的检查：`pnpm typecheck`、`pnpm lint`、`pnpm build` 及相关现有测试。涉及 UI 时，验证导入路径、Tailwind 生成样式、浅深色切换、自定义品牌、移动端和受影响业务交互；不要使用真实付费 AI 请求或生产知识库来验证纯 UI 改动。

官方参考：[仓库](https://github.com/shadcn-ui/ui)、[CLI](https://ui.shadcn.com/docs/cli)、[配置](https://ui.shadcn.com/docs/components-json)。
