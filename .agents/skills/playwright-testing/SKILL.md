---
name: playwright-testing
description: 在小人儿保险开发、修改、美化 UI 或修复浏览器问题时，选择并执行 Playwright 桌面/移动回归、截图与 MCP 实时定位，安全修复后重测。
---

# 小人儿保险浏览器验收

## 何时运行

- UI、布局、动画或交互改动后主动判断受影响路径，优先运行现有 `tests/e2e/` 用例；交互改动不能只凭页面能打开判定通过。
- 聊天：输入、发送/Enter、回复展示、失败重试、停止、刷新历史；知识库：上传合成文件、目录/状态选择、检索及来源展开；Agent：操作和真实协议驱动的状态展示；分析：输入校验、连接失败与重试、结果展示；报告：提交、完成/异常与实际浏览器下载。
- 布局同时检查桌面 Chromium 和移动 Chromium；动画另检查减少动态效果、触摸/键盘及重复操作是否被阻塞。保持 shadcn 与 Motion 规则，不为测试重构页面。

## 可重复测试优先

`pnpm test` 保留原有单元/业务测试，不替换成浏览器测试。`pnpm test:e2e` 自动构建并启动独立生产 UI 环境，执行两个 Chromium 项目；失败保留截图、trace、视频和 HTML 报告。

```powershell
pnpm test:e2e
pnpm test:e2e --project=desktop-chromium tests/e2e/chat-agent.spec.ts
pnpm test:e2e --project=mobile-chromium
pnpm test:e2e:ui
pnpm test:e2e:report
```

- 使用角色、label、可访问名称和稳定业务区域定位；等待具体结果和请求，不以固定 sleep 或 networkidle 掩盖时序问题。
- 默认使用独立 BrowserContext、合成数据和 `fixtures.ts` 的协议响应；新增 API 行为先补显式模拟，不放开未知请求。模拟事件需符合项目 schema，断言请求内容、UI 状态及输出，不能只校验标题。
- 失败时查看错误、截图/trace、控制台及请求，区分测试夹具错误、环境问题和实际产品问题。在授权范围内修复，保留用户修改；不为通过测试移除断言、编造业务结果、自动接受所有截图或改动业务逻辑。
- 修复后重跑失败用例和受影响回归；完成 UI 任务时执行 TypeScript、ESLint、独立生产构建/浏览器测试及必要业务测试。无法执行时如实列出阻塞与未执行项。

## 视觉改造前后

改造前先跑现有回归，然后保存关键页面截图：

```powershell
pnpm test:e2e:before
```

改造后先通过 `pnpm typecheck`、`pnpm lint`、`pnpm test:e2e`（含生产构建），再执行：

```powershell
pnpm test:e2e:after
pnpm test:e2e:compare
```

五个关键页面 × 两个视口分别保存在 `tmp/reports/e2e/before` 与 `after`，普通测试使用 `latest`，互不覆盖。比较脚本检查 PNG 字节一致性；差异会退出非零并列出路径，需要查看前后图片判断是否符合设计，不能把“有变化”直接当成业务故障或盲目更新基线。这不是跨系统像素容差评测。

## MCP 实时观察

项目 `.codex/config.toml` 通过 `pnpm dlx @playwright/mcp@latest` 启动官方 Microsoft Playwright MCP（本环境没有 npx），使用 `tests/e2e/mcp.config.json` 的内存隔离 Chrome 通道，复用已安装的 Chrome，绝不连接用户已登录的浏览器会话。Playwright Test 则使用其安装的 Chromium。需要实时观察时先在受控终端运行 `pnpm test:e2e:serve`，再使用已连接的浏览器工具导航到 `http://127.0.0.1:3108`、读取快照、操作、截图及定位错误；以实际工具列表为准。

- MCP 适合探索与复现；有价值的交互结果最终沉淀到 Playwright Test，而不是只保留一次性浏览器脚本。
- 不连接用户已有浏览器配置或生产地址。MCP 允许来源列表只是辅助限制，不是安全边界；实际测试代理拒绝全部业务 API。
- 未设置路由模拟时 API 会返回明确隔离错误，这不表示业务端点坏了。需要成功场景时使用测试夹具或浏览器运行代码中的显式路由模拟，不能把代理改为透传真实业务请求。
- 新配置可能需重载 MCP 或新会话才能出现在工具列表；不能将“配置文件存在”表述成“已成功调用”。MCP 不可用时继续使用 Playwright Test，并如实报告。

## 数据与环境约束

- UI 测试仅使用专用 3108 代理和 3109 Next 端口、`.next-e2e` 构建目录。拒绝复用已运行服务，避免连接用户开发会话；不要绕过代理直连 Next 内部端口执行 API。
- `scripts/e2e-server.mjs` 不加载 run-v7 的知识库连接描述，不把请求转发到业务 API；即使模拟遗漏或使用 APIRequestContext，也不能上传/删除真实文档或调用付费模型。未知浏览器 API 和外部请求使测试失败。
- 不写真实密钥，不使用真实客户数据，不清空数据库或用户浏览器记录，不改动生产知识库和业务权限，不重置 Git。测试文档只存在于每条用例的内存目录，下载为合成有效 DOCX/PDF。
- 模拟浏览器用例证明前端交互及协议消费，不证明真实 DeepSeek、向量索引、生产权限或服务端导出可用；配合既有隔离业务测试验证后端，真实集成需单独授权和独立账号/数据。
- Playwright 升级后运行 `pnpm test:e2e:install` 安装匹配 Chromium；不要为缺少浏览器而静默改用未经配置的生产浏览器或伪报通过。

官方参考：[Playwright Test](https://playwright.dev/docs/intro)、[调试与 trace](https://playwright.dev/docs/trace-viewer)、[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)。
