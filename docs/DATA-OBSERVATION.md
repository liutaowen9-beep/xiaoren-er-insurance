# V10.0.2 数据中台增强版

## 模块与真实来源

- 血缘 `/data-platform/lineage`：读取已保存的知识库快照与实际检索记录，展示逻辑文档→版本→切片→向量哈希→实际检索。连线是关联，不是流量；不使用伪造权重绘制桑基图。节点可点选，检索、运行与资产支持关联跳转。已移除文档可从保留的历史快照溯源，明确标记不是当前有效证据。
- 运行 `/data-platform/runs`：在通用 LangGraph Agent、客户需求分析、产品对比、报告工作流外做被动观察；原事件、返回值、工具执行、停止与有限重试机制保持原样。记录真实节点/工具状态、时间、耗时、工作流和配置模型；运行结果保留 partial/insufficient，不强行归为成功。
- 检索 `/data-platform/retrievals`：接入已有 `retrieve` 和 `searchNeeds`。普通向量/文档概览、混合检索保留不同策略标识；混合检索的子请求单独关联，汇总不重复计算。存查询 SHA-256 和长度，不存问题文本。关键词片段没有余弦分数，用 NULL；实际排名与返回来源分别保留。
- 质量 `/data-platform/quality-analysis`：复用只读扫描与规则记录，展示数量、非默认检索文档、非当前版本、空内容版本、孤立切片、关联异常、源库完整性与历史趋势。旧快照没有空内容标记时显示 UNKNOWN，重新只读扫描后才能获得此指标。
- 既有总览、目录、版本、质量明细及快照页面继续保留。前端复用 shadcn、已有 Motion PageSurface 与 ECharts，无新依赖。

原始文档与向量从未复制进观测表；观测阶段不创建知识库连接，库 ID 仅来自已登记 marker。扫描仍走 V10.0 的稳定临时副本方法。首次增强扫描新增空白标记/孤立切片计数，清单哈希和成员元数据可能变化，不代表原文件或向量被重建。

## 统计口径

- 运行失败率 = error / (success + partial + insufficient + error)。取消、运行中和未确认不在分母。
- 节点成功率 = success / (success + partial + insufficient + error)，不是任务正确率或保险准确率。
- 平均耗时仅统计有耗时的已确认终态记录；没有记录时 NULL，不填零。
- 超过十分钟仍没有终态的运行/检索在读取时显示 unknown，不伪造结束事件或改写历史状态。
- 检索命中频率是实际返回片段次数；Top-K 比较为请求 K 与实际返回数，不冒充 Recall@K。按 Asia/Shanghai 日桶统计，仅绘制有记录的日期。
- 质量规则 `quality-pass-rate-v1`：100 × PASS / (PASS+FAIL+WARNING+UNKNOWN)，检查项等权，四舍五入两位，分母零时 UNKNOWN。停用/归档的合法警告也会降分，因此这只是检查项通过分，不是业务质量或模型准确率。不同检查覆盖范围不可直接当作效果提升。
- 原有扫描指标仍区分逻辑文档与物理版本；“非默认检索”包含停用/归档、没有有效当前版本；“非当前版本”不是损坏结论。空内容为没有切片或所有切片为空白；关联异常以失败检查项计数。

## 隐私、完整性与限制

不持久化客户录入、工具参数/结果正文、Prompt、隐藏推理、密钥、密码、异常堆栈或完整模型输出。错误只保存固定分类代码，页面给出安全说明。查询哈希是关联标识，不承诺匿名化或不可字典猜测。

`report_citation` 是结构化报告实际采用的来源编号；`source_card` 是实际发送的来源卡片，两者不能混为“答案一定正确”。没有引用采集记录不是证明模型没有使用资料。普通聊天的检索请求可追踪，但其最终自由文本引用尚无统一逐句采用证明。模型名称是运行配置，Token 当前没有统一 usage 账本，全部保留 UNKNOWN，不估算成本。

历史未采集任务不回填。默认节点记录每运行最多 300 次更新、运行最多 10000 条、请求最多 20000 条；达到容量拒绝继续采集并增加丢失计数，不自动删除历史。进程内丢失计数重启后不可追溯，UI 明确标注。写入故障不改变业务返回或流式协议；不承诺观测零开销。测试默认关闭生产采集，仅对专用隔离库显式启用。

真实上传、替换、索引完成/失败、删除及状态操作仅在既有操作成功或排队后记录事件，不额外执行业务操作。扫描之间的差异只标记“观察到变化”，不能推断历史某时刻一定进行了重新索引或删除。运行和检索使用 AsyncLocalStorage 隔离，不在不同任务间共享客户上下文。

## 独立数据库迁移与恢复

只升级项目 `tmp/reports/data-platform/platform.sqlite`，知识库 schema 仍为 1。中台 schema 1→2 新增：

| 表 | 数据 |
| --- | --- |
| observed_runs | 运行 ID、类型、模式、库 ID、配置模型、时间、状态、耗时、可空 Token、错误码 |
| observed_steps | 运行关联、节点/工具 ID、名称、状态、开始/结束及耗时 |
| retrieval_requests | 请求/父请求/运行 ID、查询哈希、长度、策略、K、时间、状态 |
| retrieval_hits | 实际排名、文档版本、切片、可靠页码、可空分数、方式、文本哈希 |
| observed_citations | 运行、文档版本、切片、页码与采用类型 |
| asset_changes | 实际生命周期事件，不保存原文和参数 |
| platform_migrations | 版本、时间、备份文件名及 SHA-256 |

迁移源码 `src/lib/data-platform/migrations/002-observation.ts`。原八表保留；新表与知识库无跨文件外键。

迁移过程：确认 schema 1、无活动扫描租约 → SQLite `VACUUM INTO` 创建唯一的 schema 1 一致性备份 → 备份完整性/外键/SHA-256 验证及 JSON 回执 → BEGIN IMMEDIATE → 建表和索引 → 完整性校验 → COMMIT。异常执行 ROLLBACK；重复迁移不重复建表。不支持自动降级。首次新版本中台连接会执行受保护迁移，也可显式执行 CLI；迁移阻塞或失败时不会动知识库。

```powershell
pnpm data-platform:observation-migrate
# 默认仅输出计划，不写入
pnpm data-platform:observation-migrate --upgrade
pnpm data-platform:observation-migrate --restore-copy <备份绝对路径> <全新目录/platform.sqlite绝对路径>
```

备份与回执在 `tmp/reports/data-platform/backups/`，全部被 Git 忽略。恢复命令核对 SHA-256、schema、完整性和外键，只恢复到尚不存在的独立目标，绝不覆盖当前库。隔离测试同时验证事务故障回滚及备份恢复。

正式故障切换：先停止相关新旧网站和中台写入 → 保留当前 schema 2 库及其日志 → 恢复到全新路径并核对原八表、快照哈希及完整性 → 使用匹配的 V10.0 稳定代码和 schema 1 副本 → 维护窗口内保留旧文件再切换路径 → 验证后开放。不能只切 Git 就宣称数据库已恢复；schema 2 下新增观测记录不会出现在旧备份，切换前需另行保留。不要让旧版本服务和新版本同时写中台。本文步骤是故障预案，本轮没有覆盖式恢复或回退当前库。

## API 与运行

均在 `/api/data-platform`：GET `/lineage`、`/runs`、`/runs/[id]`、`/runs/stats`、`/retrievals`、`/retrievals/[id]`、`/retrievals/stats`、`/quality-analysis`。本机同源限制、Zod 严格参数、分页 1..100、查询缓存禁用、错误脱敏。无执行工具/任意路径/SQL 输入接口。过滤 `window=24h|7d|30d|all`、`mode=all|live|mock|test-adapter|unknown`、`type=all|agent|needs|reports|comparison`、状态；血缘可指定已登记 libraryId/assetId。

页面每五秒刷新独立中台记录，不轮询原库、不自动扫描、不自动运行 Agent。不同 URL 的旧响应不会覆盖新选择。

```powershell
pnpm test:data-observation
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

生产只读数据核对仍用 `pnpm data-platform:audit`，不生成 Embedding。真实付费模型需用户另行操作；自动验收只用测试传输及虚构资料。当前是本地单用户平台，不具备企业认证、多租户隔离或永久日志审计保证，禁止直接公开部署。
