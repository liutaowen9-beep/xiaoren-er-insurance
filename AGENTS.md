<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 小人儿保险项目 UI 规范

- 开发、修改或美化 UI 页面与组件时，必须先阅读并遵循 [.agents/skills/shadcn-ui/SKILL.md](.agents/skills/shadcn-ui/SKILL.md)。主动判断组件是否适用，优先检查并复用 `src/components/ui`，不要重复创建已有基础组件。
- 缺少基础组件时，通过官方 shadcn CLI 和 pnpm 按需补充；先预览变更，不强制覆盖已有文件，不全量安装。业务组件保留在原位置。
- 技术栈保持 Next.js App Router、TypeScript、React Server Components、Tailwind CSS v4、`@/*` 别名；CSS 入口 `src/app/globals.css`，UI 主题适配 `src/app/ui-theme.css`。
- 保留现有品牌变量、`BrandProvider` 和 `data-theme` 机制；新组件使用语义工具类及 `--ui-*`，避免与旧 `--muted`、`--accent` 等同名变量冲突。不要盲目导入默认全局主题或另建主题状态。
- 最终视觉标准：未来科技风 + 极简高级风，冷色科技背景、清晰卡片层级、统一字体间距与圆角阴影、克制渐变光效与动画，适配桌面和移动端。按任务范围渐进实施，不擅自改动现有品牌配色或进行全站改造。
- 不为组件接入修改业务逻辑或删除功能；组件冲突时优先保护 Agent、RAG、聊天、分析、报告及现有交互，选择兼容封装。
- 保留用户未提交改动。完成相关变更后执行类型检查、Lint、生产构建与必要回归，检查浅深色、自定义品牌及移动端；纯 UI 验证不调用付费 AI 或修改生产知识库。

## Motion 动画开发规范

- 开发、优化、美化 UI 或添加动画时，先阅读 [.agents/skills/motion/SKILL.md](.agents/skills/motion/SKILL.md)，主动判断 CSS 或 Motion 是否适用；复用 shadcn/ui 和现有动画，不为动画重构整页。
- 简单悬停、颜色和阴影优先 CSS；复杂进入/退出、布局、弹簧和拖拽优先 Motion。React 导入优先 `motion/react`，仅必要的小组件使用客户端边界，不把整页或根布局强制转为 Client Component。
- 优先用户体验，动画表达真实操作反馈与层级变化。沿用 Skill 中的时长和缓动建议，避免大量同时运动、过度回弹和反复播放；加载动画不能延迟或遮住主要内容。
- 尊重 `prefers-reduced-motion`，核对局部 MotionConfig / useReducedMotion、键盘与触摸交互，不用 hover 作为唯一反馈，不用动画阻塞聊天、停止生成、上传、分析或报告下载。
- Agent 的执行节点、状态与连接只反映真实业务事件；不以动画完成回调、固定时长、假进度或装饰节点伪造执行结果，不更改业务数据状态。
- 项目级 `.codex/config.toml` 配置免费 Motion 文档 MCP；可用时优先核对官方资料，不可用时直接读取 motion.dev 文档。它是可选开发辅助，不得作为项目运行或构建的依赖。

## Playwright 自动化验收

- UI、聊天、知识库、Agent、分析、报告、布局或动画变更时，读取并遵循 [.agents/skills/playwright-testing/SKILL.md](.agents/skills/playwright-testing/SKILL.md)，主动选择受影响的浏览器用例；不得仅凭页面可打开就判定验收通过。
- 优先使用 `pnpm test:e2e` 做可重复回归；Playwright MCP 用于实时观察、操作、截图和定位。修改聊天要测发送与回复；知识库要测上传、选择、检索；Agent 要测操作与状态；报告要测生成和下载；布局要测桌面/移动，动画要测交互和减少动态效果。
- UI 改造前执行回归并保存 `test:e2e:before` 截图，改造后通过类型检查、Lint、生产构建和浏览器测试，再保存 `test:e2e:after` 并运行 `test:e2e:compare`，查看差异。失败时安全定位和修复，再重跑相关测试，不删断言或改业务逻辑掩盖问题。
- 浏览器测试只用专用隔离服务器和合成模拟数据，不调用真实付费模型，不修改生产知识库、用户文件或真实业务数据。保留 `pnpm test` 的既有测试体系。
- 无法运行、缺凭据或受外部服务限制时明确报告未执行范围；MCP 配置存在不等于浏览器工具已连接或已调用。

## ECharts 数据可视化规范

- 统计、趋势、评测、工作流或报告图表需求先读 [.agents/skills/echarts/SKILL.md](.agents/skills/echarts/SKILL.md)，判断是否需要图表并优先复用 `src/components/charts` 的七类封装，不为普通数字强行画图。
- 只按需引入 ECharts；保留局部客户端边界、延迟加载、容器 ResizeObserver、主题更新和卸载 dispose，不将全量引擎或演示数据放入现有页面。
- 图表展示上游真实业务数据，不自行计算/修改指标定义，不把未知补零或把合成测试数据当成真实统计。评测必须提供口径、数据集版本和评测记录；来源缺失显示未接入/暂无数据。
- 数据/评测中台接入前核对 [现有数据与接口计划](docs/ECHARTS-DATA-PLAN.md)，复杂指标由后端/分析模块计算；保留品牌、shadcn 与 Motion 规范，以及 PNG/JPEG 导出能力。
- 不为图表打开/写入生产数据库、WAL、SHM 或向量文件；现有 getStore 初始化可能写库，不把生产 GET 当作无副作用统计读取。使用隔离 Playwright 用例验证正常数据、空状态、交互、主题、尺寸、卸载和移动端，再做必要回归。

### 项目品牌命名规范

1. 本项目正式名称为「小人儿保险」。
2. 所有新增页面、组件、代码注释、文档、报告和展示内容必须使用「小人儿保险」。
3. 禁止在新开发内容中引入旧项目品牌名称。
4. 修改旧代码时，发现旧品牌引用应一并处理。
5. Agent 系统提示词和生成内容必须遵守新品牌规则。
6. 每次开发完成后，执行品牌一致性检查：`pnpm check:brand`。
7. 如果发现旧品牌展示引用，必须在交付前处理，不能遗留。

统一品牌常量与模型规则位于 `src/lib/product-identity.ts`。历史兼容标识（环境变量、浏览器存储键、协议头、旧数据库路径及登记格式）保留，不得为更名批量改写用户数据或绕过部署校验；兼容层的旧名称编码只用于读取识别，不得用于对外展示。Git 历史、标签、stash 和第三方依赖不做品牌替换。
