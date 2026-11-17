# V10.0 第一阶段：数据中台基础版

本阶段提供资产目录、只读扫描、质量检查、文档版本观察与不可变哈希快照，不包含评测中台。导航“数据中台”，入口 `/data-platform`，子页面 `/assets`、`/quality`、`/versions`、`/snapshots`。

## 数据与安全边界

- 继续使用现有 `run-v7.mjs` 登记的独立知识库连接。适配器复用配置与路径验证，不创建 `KnowledgeStore`，不调用普通知识库 GET；缺少稳定库 ID 或 schema 不是 1 时拒绝扫描，不回退到空库。
- 新数据库为项目下 **`tmp/reports/data-platform/platform.sqlite`**，独立 schema 1。仅保存资产和版本元数据、扫描质量结果、切片/向量哈希和清单。不保存原文件、正文、向量值或密钥。
- 为避免 SQLite 只读连接仍可能改变源 SHM，只通过文件读取访问源 DB/WAL/SHM。扫描前后核对 SHA-256，将稳定 DB/WAL 临时复制到受控 `scratch/scan-*` 目录，复核副本哈希，只在副本打开 `DatabaseSync(readOnly: true)`。所有 SQLite 读事务、WAL 读取和 SHM 创建只发生在副本，结束清理临时目录。
- 复制不等于原子文件系统快照：如果源文件/日志在复制或扫描期间变化，拒绝发布，不忽略 WAL。非空回滚日志、路径链接、超限文件、未知 schema、读失败均失败关闭。文件可能包含私有内容，临时目录应保持本机用户专用，不共享到网络或云盘。
- 不能保证服务进程被强制终止时立即清理临时副本；重新扫描不会自动清理未知任务目录。若发现残留，停机核实后人工处理。正式快照不包含原数据，**不能替代完整备份**。
- 当前只支持本地单用户。API 做本机 Host/Origin 检查，但不是互联网认证/RBAC，禁止直接公开部署。

## 表与版本

七个业务表：`data_sources`、`assets`、`asset_versions`、`corpus_snapshots`、`snapshot_members`、`quality_rules`、`quality_checks`。另有 `scan_locks` 控制跨连接并发。

新空中台库在事务内从 schema 0 初始化到 1；不识别的非空库或更高版本拒绝自动修改。迁移失败回滚 DDL 和 user_version。生产知识库不迁移。

库 ID 取已有登记 marker UUID。资产键按库 ID + 源文档 ID 命名空间化。当前有效文档口径为 `active` + 当前指针归属正确 + `ready`，历史/停用/归档不能计入有效文档。目录标记源库已移除对象，保留既有元数据和历史快照。

每次扫描追加 UUID 快照。清单采用键排序的确定性 JSON，数组有稳定顺序；内容哈希不包含扫描时间/快照 ID。相同内容仍生成独立快照，但标记未变化。差异覆盖逻辑文档、版本、切片的新增、删除、修改与逻辑状态变化。历史快照没有更新或删除 API。

一次发布在单个事务完成：目录更新、版本更新、快照、成员和质量检查同时提交。扫描失败、取消或提交故障保留上次成功结果。租约 150 秒，扫描超时 120 秒；超时租约可接管，旧持有者不能发布。中台使用自己的数据库，不与知识库建立跨文件外键。

## 质量口径

质量结果为 PASS/FAIL/WARNING/UNKNOWN。检查原始字节哈希及长度、外键与版本归属、当前版本、切片数量/序号/正文/页码、向量数量/维度/有限值/归一化、固定 Embedding 规格、索引状态、重复文件和检索状态。

停用/归档及相同哈希历史版本标记 WARNING，不据此自动认定数据损坏。没有向量时模型/维度检查 UNKNOWN，不当作通过。异常数为 FAIL + WARNING + UNKNOWN **检查项数**，不是异常文档数或业务风险分。模型规格使用现有固定模型修订版与 384 维配置。

## API

统一前缀 `/api/data-platform`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/overview` | 最近成功扫描、真实统计、中台完整性 |
| GET | `/assets` | 资产搜索、状态、排序、分页 |
| GET | `/assets/[id]` | 资产详情与版本元数据 |
| GET | `/assets/[id]/versions` | 版本分页与当前版本指针 |
| GET | `/quality` | 最近扫描质量检查、结果过滤、分页 |
| POST | `/scans` | `{}` 或 `{"snapshot":true}`；不接受数据库路径 |
| GET | `/snapshots` | 不可变快照摘要分页 |
| GET | `/snapshots/[id]` | 清单；切片成员分页 |
| GET | `/snapshots/[id]/diff` | 与前一同库快照比较；`from=UUID` 可指定同库快照 |

分页参数 `page>=1`、`pageSize=1..100`；资产可用 `search`、`state`、`sort=name|createdAt|updatedAt`、`order=asc|desc`，质量可用 `result`。未知参数拒绝。所有结果禁用缓存；错误不返回异常堆栈或私有路径。

扫描为有界请求，不是后台队列。浏览器取消可请求中断，但若事务已成功提交，不能撤销完成的快照；刷新可核对最终结果。前端不显示伪进度，不因页面初始化自动扫描。

图表从成功扫描 DTO 生成；未扫描显示未接入，不用零填未知。版本趋势是最近 20 次扫描的版本数，不冒充每日上传量。复用现有 shadcn、ECharts 与支持减少动态效果的 PageSurface，不引入新框架。

## 验证与启动

```powershell
pnpm test:data-platform
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:e2e
```

`pnpm data-platform:audit` 需已登记的真实独立知识库，执行只读扫描并写入独立中台记录，保存本地指纹验证到 `tmp/reports/data-platform/readonly-verification.json`。输出只含统计和检查汇总，不输出正文、密钥。不能在未知连接上运行此命令。

日常运行沿用 `pnpm dev` 或构建后 `pnpm start`，默认 `http://127.0.0.1:3002/data-platform`。本阶段不用新环境变量或 API Key，不调用模型。

浏览器自动化只用 3108/3109 隔离服务及显式合成数据，验证 UI 协议；后端测试使用临时虚构 SQLite，覆盖非空 WAL 源指纹不变、迁移/发布回滚、租约接管、取消/超时、质量失败、版本及快照差异。真实数据只做扫描与指纹核对，不做破坏性测试。

回退只需停用新页面与 API；知识库未修改。独立中台数据应保留备份，不靠 Git 回滚数据库。
