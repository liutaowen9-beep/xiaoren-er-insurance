# ECharts 数据来源盘点与分期接入计划

盘点日期：2026-11-09，基于当前 `feature/v9.0.3-report-upgrade` 分支源码。此文档不是生产库查询结果，不包含真实统计数值；本次没有打开生产 SQLite、执行 PRAGMA、迁移数据库或改动 WAL / SHM / 向量文件。

## 当前页面和图表基础

项目使用 Next.js 16.4.2、React 19.3.1、TypeScript 5.9.3、Tailwind 4.3.3 和 pnpm 11.25.0。接入前没有 ECharts、Recharts、Chart.js 或其他图表引擎。现有界面主要是 shadcn 卡片、文档概况数字、Agent 节点与执行条、报告正文/对比表，而非通用图表组件。

当前路由包含知识库、聊天、智能业务分析、客户需求分析、产品对比、报告及技术架构展示，没有独立数据中台/评测中台页面，也没有统一治理统计 API、评测 API 或评测记录表。本次只建立公共能力，不新增这些业务页面。

## 可核对的真实来源

| 来源 | 真实结构/字段 | 范围与限制 |
| --- | --- | --- |
| `src/lib/rag/schema-sql.ts` | `knowledge_documents`：逻辑文档 state、current_version_id、revision、created_at、updated_at | 管理版 schema 1；逻辑文档不等于所有版本记录 |
| 同上 `documents` | 物理版本 id、logical_id、version、hash、status、chunk_count、created_at、error、model、dimension，以及原文 raw | version 失败候选、历史版本与当前版本需分开统计，不能读取 raw 用来做图表 |
| 同上 `chunks` | document_id、sequence、text/page/title、vector/model/dimension | 切片数可计量；不向图表暴露正文、向量或私有路径 |
| 同上 `document_jobs` | 索引任务 state、started_at、finished_at、owner_pid | 当前任务记录；重试可能更新既有任务行，不是完整事件/尝试历史 |
| `GET /api/knowledge/documents` | `getStore().list()` 的文档目录及 config | schema 1 每个逻辑文档选择当前版本或首个候选，并补充版本/状态/候选信息；不是所有版本明细。已有知识库页面据此显示概况 |
| `GET /api/knowledge/documents/[id]/manage` | 文档版本明细 | 单文档生命周期与历史版本；不等于全库异常审计结果 |
| `GET /api/knowledge/readiness` | ready、mode、schemaVersion、documents、chunks、指纹信息 | `ready: true` 表示该接口/连接路径就绪，不等于数据库完整性率 100% |
| `src/lib/rag/database-audit.ts` | schema、integrity_check、foreign_key_check、原文哈希、切片/向量与版本关联校验 | 现有迁移/审计函数可给结果；目前没有带时间与审计记录 ID 的中台快照接口 |
| `src/lib/agent/workflow.ts`、`graph-events.ts`、`observe.ts` | run/node/tool 的真实状态、时间、elapsedMs、attempt、retryCount、来源关联 | SSE 单次执行和浏览器保存历史，不是跨用户、跨版本的权威服务端评测仓库 |
| `src/lib/needs/types.ts`、`retrieval-types.ts` | 客户原话类别、沟通顺序、检索诊断、证据状态、待确认判断、候选资料 | 单次分析结果，未建立跨客户统计授权或统一风险评分；不能从“待确认”推算风险分 |
| `src/lib/reports/types.ts`、`storage.ts` | 段落、表格、来源、限制、引擎、生成时间及临时下载记录 | 本地报告 TTL 60 分钟；不能作为长期使用量、模型质量或成本统计仓库 |

**读取边界：** 上述 API 有真实来源，但本次未请求生产接口。现有 `getStore()` 初始化会做异常任务恢复等写操作，不能把 GET 名称或“只查目录”当作绝对无副作用。后续中台应先明确无副作用的只读连接/统计快照边界，不能直接从图表组件调用数据库或审计函数。

## 数据中台指标规划

“可支撑”表示现有记录足以提供部分事实，不表示本次已经读取生产数值或接入业务图表。以下统计定义均需产品/数据模块确认后由后端实现；ECharts 不承担计算。

| 指标 | 当前支撑 | 接入前需要补充/确认 | 建议展示 |
| --- | --- | --- | --- |
| 文档总量、有效文档量 | 逻辑文档目录、state、status、isCurrent 已有 | 明确“逻辑总量/版本总量”；有效检索条件应与现有服务一致：active、当前版本、ready | 少量数字优先卡片；按状态比较可用 Bar/Pie |
| 文档解析成功率 | status 和 error 只有整体索引结果 | 独立解析阶段事件、成功/失败分母、时间窗；不能用 ready 比例冒充解析成功率 | Gauge/Line，量程和单位明确 |
| 文档重复率 | 原文 hash 和上传 duplicate 布尔结果已有 | 去重请求未形成完整尝试日志；需上传尝试总数、重复判定口径和统计窗口 | Gauge/Line；缺记录显示未接入 |
| 文档完整率 | 原文/切片/向量结构校验已有 | 业务字段完整性的规则版本、适用文档类型与分母；非空字节不等于业务完整 | Bar/Heatmap，或状态卡片 |
| 版本异常数量 | 当前版本关联及 auditDatabase 校验存在 | 定义异常类别，独立只读审计记录、时间和错误码接口；不能由版本号大于1判异常 | Bar；单次结果优先状态卡片 |
| 失效文档数量 | inactive、archived、旧版本等事实可区分 | 确认失效是否含停用/归档/旧版本/失败及去重范围，保持与检索排除策略一致 | Bar/Pie，分类互斥 |
| 向量索引成功率 | ready/failed、模型/维度、chunks、job 状态已有 | 独立向量阶段与任务尝试记录；总索引成功不能直接称向量阶段成功 | Gauge/Line |
| 数据库完整性 | 审计函数有多项实际校验 | 只读审计服务/快照、审计版本/时间；不能将 readiness.ready 展示成完整性百分比 | 文字/状态优先，失败项可用 Bar |
| 每日新增趋势 | `knowledge_documents.created_at` 存在 | 后端按 Asia/Shanghai 时间桶聚合，明确只看仍存在逻辑文档还是所有上传尝试；当前版本 created_at 不能冒充首次新增时间 | Line |
| 上传→解析→切片→向量入库流转 | 当前状态、索引任务部分字段存在 | 需要同一批对象的 stage event、run/document ID、分支结果和可追踪时间；当前状态快照不能拼成 Sankey 流量 | 数据齐全后 Sankey |

## 评测中台指标规划

目前没有统一评测数据集版本、标注、评测记录和指标接口。下表全部属于后续能力；现有阈值/相似度、schema 校验、单次 SSE 或单元测试通过数不能冒充评测结果。

| 指标组 | 需要的后端/评测记录 | 视图 |
| --- | --- | --- |
| RAG Recall@K、Precision@K、MRR、nDCG | query ID、固定语料/数据集版本、ground truth/relevance 标注、检索排名、K、过滤策略、计算版本；nDCG 还需明确分级相关性与归一化约定 | Bar 比较、Line 趋势、Heatmap 模型×数据集 |
| 引用准确率、版本准确率 | 可审核标注、实际引用/证据版本、判定规则、合格/总数、失败案例和记录 ID；本地引用存在性校验不等于统计准确率 | Bar/Gauge/Line |
| Agent 节点/工具成功率、失败率 | 权威执行记录、成功/失败/取消/重试计数口径，样本集、工作流/工具版本、时间窗；现有事件只支持单次展示 | Bar/Gauge，趋势用 Line |
| Agent 耗时、重试次数 | 单次真实 elapsedMs / attempt / retryCount 已有；聚合需明确端到端/节点、重试是否单独样本、平均值或分位数及数据范围 | Bar/Line；只有真实路径权重时用 Sankey |
| 模型准确性、事实一致性、幻觉率 | 版本化题集/证据库、人工或评判器规则和版本、原始评分、审核记录、分母 | Bar/Heatmap；可比量纲齐全才 Radar |
| 结构化输出准确率 | 模型输出的 schema 版本、初次/修复后成功标记、总调用数、异常样本、评测 run | Bar/Line；不能把最终页面能解析当作首次输出准确 |
| 模型响应时间、Token 成本 | 请求时间边界、provider usage、输入/输出/缓存 token、币种、价格表版本和计费日期；现有聊天传输未提供可用的统一 token 账本 | Line/Bar；成本未接入不显示估算值 |
| 模型/Prompt/Agent 工作流版本回归 | 同版本数据集、模型/Prompt/工作流版本 ID、参数、评测引擎版本、时间、run ID、逐样本结果及指标口径 | Bar、Line、Heatmap；Radar 需同尺度维度 |

建议未来 DTO 至少包含 `metricId`、`value: number|null`、`unit`、分母/时间窗、`metricDefinitionVersion`、`datasetVersion`、`evaluationRunId`、模型/Prompt/工作流版本与 `observedAt`；未知值用 null，接口缺失用未接入。数据比较前核对口径与数据集是否可比，不由图表自动重算或相减生成“提升”。

## 需求分析与报告规划

- 需求类别和优先级已有单次结果，可在授权的单次报告中按类别/顺序展示；优先级是沟通顺序，不是风险值或产品适合性得分。若要跨客户分类统计，需先定义授权范围、去重单位和汇总接口。
- 方案对比已有经核验的字段、原文、状态和缺失信息，当前表格应保留。只有统一数值单位、明确原文依据的字段才可画 Bar/Radar，不从自由文本保费或未知字段构造数值。
- 风险分析与多维能力对比尚无统一量表、评分规则和完备数值；暂不绘制风险 Radar/Gauge，显示未接入。评测能力 Radar 同样要求每维范围和评测记录。
- 公共图表通过 `chartRef.exportImage('png'|'jpeg')` 预留图片导出，适配报告卡片宽度。本次不修改 DOCX/PDF 导出引擎；后续接入需明确导出权限、数据时间、字体、图片清晰度和敏感信息范围。服务端离线导图是另一项能力，不由浏览器方法冒充。

## 推荐最短接入顺序

1. 本次先完成七类公共组件、来源约束与隔离测试；业务页面保持原样。
2. 在只读边界落实后，提供文档当前目录统计 DTO，先接数量/状态 Bar 与逻辑新增趋势 Line，标注范围和时间。没有真正新增趋势数据时不展示。
3. 建立解析/索引/上传尝试事件日志和审计快照，再接成功率、重复率与流转；不得改动现有生产数据来“补齐演示”。
4. 建立版本化评测集、逐样本结果与评测 run API，再接 RAG/Agent/模型与回归面板。
5. 最后按单次报告真实数据选择图型，并单独实现经过授权的报告图片嵌入。

在这些接口完成之前，中台指标均显示未接入或暂无数据，不用预置示例值填充业务页面。
