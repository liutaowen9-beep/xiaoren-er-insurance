# shadcn/ui 接入与验收

接入日期：2026-11-05。使用 pnpm 11.25.0 和官方 shadcn CLI 4.23.0，通过已有项目配置及 `add` 完成接入，未执行覆盖全局主题的 `init`。

## 组件与配置

- `components.json`：new-york / Radix、RSC、TSX、Tailwind v4、`@/*` 别名；CSS 入口 `src/app/globals.css`。
- `src/components/ui/`：Button、Card、Badge、Input、Textarea、Separator。
- `src/lib/utils.ts`：项目统一的 `cn` 导入路径，复用官方 CLI 选择的 `cn` 包。
- 仅新增四项直接依赖：`cn`、`class-variance-authority`、`@radix-ui/react-slot`、`@radix-ui/react-separator`。CLI 是通过 `pnpm dlx` 运行的工具；未作为运行时依赖安装。未增加新的图标库、主题提供器或动画库。
- 所有业务组件、路由和业务处理保持原位置；本次没有迁移已有页面或新增展示路由。

## 样式兼容

`src/app/ui-theme.css` 用独立 `--ui-*` 变量将现有品牌变量映射为 Tailwind 语义工具类。保留旧 `--muted`（文字色）、`--accent`（强调文字色）等变量，不与 shadcn 的背景语义混用。

深色模式和 `dark:` 工具类都跟随 `html[data-theme="dark"]`。品牌主色与前景分别跟随 `--brand-solid` 和 `--on-brand`，继续由原有 BrandProvider 和浏览器存储控制。

旧全局控件重置通过 `:where(:not([data-slot]))` 排除新组件，保留旧选择器优先级。没有应用 shadcn 默认的全站 body / universal reset。今后将新组件放入旧 CSS 容器时，还需检查后代选择器的覆盖。

视觉方向是未来科技风 + 极简高级风，具体由品牌规范控制；本次保留现有配色，没有进行全站视觉改造。

## Codex 自动使用

项目根 `AGENTS.md` 要求 UI 任务先读取 `.agents/skills/shadcn-ui/SKILL.md`；Skill 有合法的 name / description，并通过 `agents/openai.yaml` 显式允许自动调用。

后续可直接提出“美化设置页”“开发新表单”等 UI 需求，Codex 应先检查并复用现有组件。也可明确写“使用 $shadcn-ui”。已打开会话的技能目录列表可能需要新建会话才能刷新；AGENTS 中的读取规则提供直接入口。此配置不替代实际模型的规则遵循，也不授权超出任务范围的业务或视觉修改。

示例：

```tsx
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
```

缺少组件时先预览，再按需加入；不得强制覆盖已有文件：

```powershell
pnpm dlx shadcn@4.23.0 add dialog --dry-run
pnpm dlx shadcn@4.23.0 add dialog
```

## 本次验收

- `pnpm typecheck`、`pnpm lint`、`pnpm build`：通过。
- `pnpm test`：211 项通过。
- `tests/needs.test.ts`、`tests/needs-ai.test.ts`、`tests/needs-retrieval.test.ts`：43 项通过。
- `tests/needs-product-evidence.test.ts`：8 项通过。
- Skill 的 `quick_validate.py`：通过；官方 CLI `info` 正确识别六个已安装组件及全部目录别名。
- 通过实际导入和 SSR 验证六个组件、类名覆盖合并、disabled 与 asChild。
- 使用本地生产构建和独立 headless Chrome 会话检查：首页、聊天、知识库问答、Agent、知识库、分析入口、需求分析、产品对比、报告、架构、设置共 11 个页面入口均 HTTP 200，未捕获未处理的浏览器异常。
- 在真实页面样式环境临时插入组件渲染结果，验证按钮背景/文字、边框、焦点环、输入、多行文本、横纵分隔线、浅深色卡片、自定义品牌保存与刷新、`dark:` 样式、390px 移动端以及旧聊天发送按钮、知识库操作按钮和移动导航。
- 浏览器验收拦截业务 API，未执行真实上传、付费 AI 或私有知识库操作；业务行为回归由隔离测试覆盖。组件渲染结果只注入测试浏览器，没有写入业务页面。
- 临时验收脚本、JSON 结果和截图位于已忽略的 `tmp/reports/shadcn-ui-acceptance/`；Playwright 仅运行于包管理器缓存，未加入项目依赖。

构建成功但保留两条原有 RAG 代码的文件追踪范围警告，位置为 `src/lib/rag/config.ts` 和 `src/lib/rag/migration-safety.ts`，涉及 `tmp/rag-tests` 的宽泛路径。为保护业务范围，本次未修改这些代码。
