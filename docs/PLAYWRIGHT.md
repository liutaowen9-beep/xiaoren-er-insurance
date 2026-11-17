# Playwright 测试体系与验收

完成日期：2026-11-05。本次仅建立测试与 Codex 工具配置，没有修改 `src/` 内的页面、样式、组件、Agent、RAG、聊天、分析或报告业务逻辑。

## 安装与环境

- Next.js 16.4.2、React 19.3.1、TypeScript 5.9.3、pnpm 11.25.0。
- 新增开发依赖 `@playwright/test@1.64.1`；原有 `pnpm test` 保持不变。
- 已执行 `playwright install chromium`，安装匹配的 Chromium 1248、Headless Shell 和 FFmpeg。
- `playwright.config.ts` 使用桌面 Chrome 设备参数与移动 Pixel 7 参数，两者实际均运行 Playwright 安装的 Chromium。
- 每条用例有独立 BrowserContext 和内存模拟数据；默认 2 workers、单测 30 秒、整体 5 分钟，CI 重试一次、本地不自动重试，防止用重试隐藏不稳定问题。
- 失败自动保存截图、trace、视频和 HTML 报告；首轮定位失败时已实际产生这些诊断文件。修复测试定位后全套通过。

## 命令

```powershell
pnpm test:e2e                         # 自动生产构建、启动隔离服务、运行两个 Chromium 项目
pnpm test:e2e --project=desktop-chromium
pnpm test:e2e --project=mobile-chromium
pnpm test:e2e tests/e2e/chat-agent.spec.ts
pnpm test:e2e:ui                      # 交互测试界面
pnpm test:e2e:headed                  # 有界面浏览器
pnpm test:e2e:report                  # 打开最近一轮 HTML 报告
pnpm test:e2e:install                 # 升级 Playwright 后安装匹配 Chromium
pnpm test:acceptance                  # 类型、Lint、既有业务测试、含生产构建的 E2E
```

`pnpm typecheck`、`pnpm lint`、`pnpm test` 仍可分别执行。生产构建由 E2E 启动器调用同一 Next CLI 的 `build`，只将产物放入专用 `.next-e2e`。普通开发和现有 V7 启动方式保持原行为。

## 安全边界

`scripts/e2e-server.mjs` 使用专用 3108（UI 代理）和 3109（Next 内部）端口，拒绝复用已有服务；配置 `MOYU_E2E=1` 时 Next 使用 `.next-e2e`，不覆盖 `.next` / `.next-v7`。TypeScript、ESLint 与 Git 忽略规则已适配新产物目录。

启动器清空模型凭据与生产连接环境，并为每次运行注册一个全新的空测试知识库目录（`tmp/reports/e2e-environments/`），满足现有路径校验；不读取 `run-v7` 的生产连接描述。Next 自动更新的 `next-env.d.ts` 类型路径在已确认仅为框架路径变化时恢复原样。

浏览器模拟由 `tests/e2e/fixtures.ts` 管理，上传文档目录仅存在于单条测试的内存中。独立代理会拒绝全部业务 API 和非 GET/HEAD 请求；遗漏模拟或使用 APIRequestContext 时也不会调用业务端点。已有用例实际验证了 DELETE 请求被拒绝。浏览器发出未知 API 或外部 HTTP 请求会导致用例失败。

测试不连接真实模型、不消耗 API 额度、不清空真实知识库、不删除用户文件、不修改生产数据库。不要绕过 UI 代理直连内部端口执行 API。

## 首批覆盖

共 21 个场景，每个在桌面与移动端各运行一次，共 42 项：

| 文件 | 场景 |
| --- | --- |
| navigation.spec.ts（4） | 首页及侧栏跳转、主题刷新/移动导航/减少动态效果、404、隔离代理拒绝未模拟 API |
| chat-agent.spec.ts（5） | 聊天发送与回复及刷新、失败重试不重复消息、等待时停止、知识库模式检索/来源展开与重读、Agent 工具事件和结果展示 |
| knowledge.spec.ts（2） | 文件选择器上传合成文件并刷新目录、文档状态筛选与比较资料勾选/按钮启用条件 |
| reports-needs.spec.ts（5） | 报告提交/工作流/Word 与 PDF 下载、损坏响应和重试、下载过期、需求分析空输入校验及虚构案例、连接异常与重试 |
| visual.spec.ts（5） | 首页、聊天、知识库、需求分析和报告页面的布局检查及截图 |

下载用例不仅等待下载事件，还检查文件名、失败状态，并解析 DOCX 的正文 XML 和 PDF 页数。下载文件由测试夹具生成，为有效的合成文件；不冒充真实模型报告或真实后端导出。

## 改造前后截图

```powershell
pnpm test:e2e:before
# 实施已授权的 UI 改造，再运行类型、Lint、业务与 E2E 检查
pnpm test:e2e:after
pnpm test:e2e:compare
```

两套截图分别保存在 `tmp/reports/e2e/before` 与 `after`，普通回归使用 `latest`，不会相互覆盖。每套有五个页面 × 两个视口的 10 张图片。比较脚本输出 `tmp/reports/e2e/screenshot-comparison.json`；图片字节变化即报告差异并退出非零，需查看图片判断是否是预期设计变化，不自动接受基线。

本次已实际运行前后两套截图测试，各 10 项通过，10 对图片全部一致，并查看了桌面首页与移动聊天截图。本次未做视觉改造；此流程验证截图留存与比较机制，供未来真实改造使用。字节比较不等于跨操作系统像素容差评估。

## Codex Skill 与 MCP

- `.agents/skills/playwright-testing/SKILL.md`：按功能选择浏览器用例、安全数据要求、截图比较、失败定位修复与重测规则；`agents/openai.yaml` 允许自动调用，格式校验通过。
- 根 `AGENTS.md` 已加入读取入口和浏览器验收规范，保留 Next.js、shadcn 和 Motion 的已有内容。
- `.codex/config.toml` 新增且仅新增一个 Playwright MCP 服务，保留原 Motion MCP。本环境没有 npx，因此使用等价的 `pnpm dlx @playwright/mcp@latest` 启动官方 Microsoft 包；本次实际下载版本为 0.0.84。
- `tests/e2e/mcp.config.json` 使用独立内存浏览器上下文、headless Chrome 通道、工作区范围文件访问和 3108 测试来源。MCP 复用本机已有 Chrome，与用户浏览器登录会话分离；Test 使用已安装的 Chromium。MCP 的允许来源规则只是辅助限制，实际 API 隔离由代理提供。

实时探索时先运行 `pnpm test:e2e:serve`。MCP 配置已被 `codex mcp get playwright --json` 正确识别，另使用相同启动命令进行了真实 stdio MCP 握手、工具发现和调用：导航聊天页、读取快照、输入合成问题、点击发送、显示模拟回复、截图及关闭浏览器均成功。结果和截图位于 `tmp/reports/e2e/mcp/`。

本次服务返回的浏览器实现版本是 `1.65.0-alpha-2026-10-30`。工具参数以实际 schema 为准，例如当前输入和点击工具使用 `target`；不要依赖旧版的 `ref` 参数或固定工具名称。新配置可能需要新会话/重载 MCP 才进入当前聊天的原生工具目录；协议级实际调用已验证，未把配置文件存在当成调用成功。

日后可直接要求“修改聊天后运行浏览器回归”，也可明确使用 `$playwright-testing`。MCP 适合实时观察；最终可重复回归优先使用 Playwright Test。

## 本次验证与未执行范围

- TypeScript、ESLint、Skill 校验、生产构建、42 项 E2E 均通过。
- 原有业务测试 211 项和需求分析相关测试 53 项通过，共 264 项；没有改写原有测试文件。
- 前后截图 10 对全部一致；MCP 真实工具调用通过。
- 所有 `src/`、原有 UI 样式和业务组件的文件哈希与本次安装前快照一致；新增/更新仅涉及开发依赖、测试、启动/比较脚本、工具配置与规范。
- 构建保留两条原有 RAG 测试目录的文件追踪范围警告，不影响构建成功，未扩大范围修改业务代码。
- **未执行真实 DeepSeek 调用、生产知识库上传/索引/检索或生产报告下载。** 浏览器功能用例使用明确标注的模拟响应；这证明前端请求、协议消费和交互，不证明真实外部服务可用。后端逻辑由既有隔离测试覆盖，真实集成须另用专门账号、独立数据及明确额度授权。

官方参考：[Playwright Test](https://playwright.dev/)、[配置](https://playwright.dev/docs/test-configuration)、[Web server](https://playwright.dev/docs/test-webserver)、[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)。
