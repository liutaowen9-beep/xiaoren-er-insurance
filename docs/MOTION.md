# Motion 接入与 Codex 能力

完成日期：2026-11-05。此次仅接入依赖、Skill 和开发辅助 MCP，没有为业务页面增加动画、修改业务逻辑或重构组件。

## 依赖与现有结构

- 检查时使用 Next.js 16.4.2、React / React DOM 19.3.1、Tailwind CSS v4、pnpm 11.25.0，与 Motion 的 React 18.2+ 要求兼容。
- 接入前没有 motion / framer-motion 动画包，已有动画主要为 CSS transition / keyframes；已有 13 个显式 Client Component，本次数量及内容不变。
- 执行 `pnpm add motion`，实际安装 Motion 14.9.0；遵循现有 pnpm 解析策略，没有强制升级框架或其他依赖。
- `framer-motion@14.9.0`、`motion-dom@14.9.0` 和 `motion-utils@14.7.0` 是 Motion 的正常传递依赖，依赖树中各只有一个版本。项目只声明 motion 这一项新的直接依赖，React 动画导入使用 `motion/react`。
- 没有增加全局 Motion Provider、业务动画封装、演示路由或新的应用客户端边界；保留 shadcn 组件、品牌变量、data-theme 和已有减少动态效果 CSS。

## 官方 AI Kit 与 Codex

核对了官方仓库、安装指南、npm 发布信息和实际下载的安装器代码。`motion-ai@14.2.0` 的代理表明确包含 Codex，技能目标是 `.agents/skills/`，MCP 配置目标是 `.codex/config.toml`。官方网页部分描述尚未列出 Codex，以实际发布代码的明确支持为依据。

该发布版交互安装器默认会同时加入 Motion 与 Motion+ 两个服务器。为仅配置免费能力，本次通过 `pnpm dlx` 下载官方安装器，调用其导出的 `writeSkills(process.cwd(), ['.codex'])` 安装官方 Skill 内容，再按 Codex 原生项目格式配置免费 MCP。没有运行默认的双服务器配置步骤，没有写入其他 AI 工具目录或全局用户配置，没有添加 Motion+。

- `.agents/skills/motion/SKILL.md`：官方 Skill 入口叠加小人儿保险规则，调整为符合项目校验器的 frontmatter；保留官方最佳实践、文档搜索等配套参考文件。项目规则对应用范围和业务保护有明确优先级。
- `.agents/skills/motion/agents/openai.yaml`：显式允许自动调用。
- `AGENTS.md`：保留原有 Next.js 和 shadcn 规则，新增动画任务的 Skill 读取入口、选型与验收要求。
- `.codex/config.toml`：项目级 Streamable HTTP MCP，地址 `https://mcp.motion.dev`，无账号、密钥或付费要求；启动超时 10 秒、调用超时 30 秒，作为可选开发工具使用。

已通过 `codex mcp get motion --json` 验证 Codex 正确识别配置；另直接完成 MCP 协议初始化、工具发现、`search-motion-docs` 调用和 `resources/read`，读取了 `motion://docs/react/react-use-reduced-motion` 官方文档。服务端返回协议版本 2025-06-18。工具能力以实际列表为准，上游 Skill 提及的其他能力不等于本项目已连接。

配置可被受信任项目的新 Codex 会话读取；当前已打开会话的 Skill / MCP 工具目录可能需要新会话或重载后刷新。配置识别和协议连通已验证，不将它表述为当前聊天原生工具列表已经热加载。

## 后续使用

可直接要求“优化卡片交互”“给弹窗增加退出效果”或明确写“使用 $motion”。Codex 应先判断实际需求：简单悬停/颜色优先 CSS，复杂进入退出、布局、弹簧及拖拽才使用 Motion，优先复用现有 shadcn 组件。

完整动画规范在 Skill 中：统一短时长和缓动、轻量位移、克制弹簧、触屏与键盘支持、局部客户端边界、真实业务状态以及 prefers-reduced-motion。首屏内容不能被初始隐藏态延迟展示，动画不能阻塞聊天、上传、分析、报告下载或停止操作。

MCP 不可用时仍可直接读取 motion.dev 官方文档；不影响依赖安装、编译、页面运行或普通开发。付费审计、示例源码及 Motion+ 不属于此次配置范围。

## 验收记录

- TypeScript、ESLint、生产构建均通过；构建保留两条原有 RAG 文件追踪范围警告，位置为 `src/lib/rag/config.ts`、`src/lib/rag/migration-safety.ts`，此次未修改。
- 现有 `pnpm test` 的 211 项测试，以及需求分析相关四个测试文件的 53 项测试全部通过，共 264 项，均在隔离环境中运行。
- 项目 Skill 格式验证通过；Codex CLI 配置识别及 MCP 官方文档读取通过。
- 独立临时 TSX 样例通过类型检查与打包，验证 `motion/react`、MotionConfig、useReducedMotion、AnimatePresence、motion.create(Button) 和 Button asChild 组合。
- 在本地生产页面样式环境，使用独立 headless Chrome 临时注入测试样例：移动端触屏点击正常，退出和再次进入正常，普通模式 x=24px、减少动态效果模式 x=0，shadcn 外观保留，无未处理浏览器异常。没有将样例写入业务页面。
- 复验现有 11 个页面入口、聊天输入、旧按钮样式、浅深色切换、自定义品牌保存与刷新、390px 移动端导航，均通过。浏览器验证隔离了业务 API，没有执行真实付费 AI、上传或私有知识库操作。
- 与接入前快照逐文件哈希对比：已有文件仅 AGENTS.md、package.json、pnpm-lock.yaml 因本次接入发生变化；所有 src 文件、样式、shadcn Skill 和 components.json 均逐字节保持原样。生产构建自动切换的 next-env 类型路径已恢复为原状态，未回退其他用户修改。
- 临时脚本、截图和结果位于已忽略的 `tmp/reports/motion-acceptance/`。Playwright 仅使用工具缓存，没有加入项目依赖。

参考：[Motion React 安装指南](https://motion.dev/docs/react-installation)、[官方 AI Kit 源码](https://github.com/motiondivision/ai-kit)、[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。
