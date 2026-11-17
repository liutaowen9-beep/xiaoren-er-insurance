# 知识库生产迁移工具与维护操作清单

本工具采用**备份 → 独立候选库 → 事务迁移 → 只读验收 → 显式批准切换**。旧生产 `.moyu/knowledge.sqlite` 永远不是工具目标；当前阶段不允许迁移或启用真实生产库。不能移除路径保护后在原库上运行。

## 保护及边界

- `pnpm rag:migrate` 默认 dry-run，必须提供绝对 `--root`、`--target`、`--backup`。
- target 必须恰好是 root 下 `data/knowledge.sqlite`，并匹配 prepare 生成的目标身份凭证。拒绝原生产路径、UNC、目录联接/符号链接、硬链接、身份不匹配、备份目录充当目标及已有目录覆盖。
- 备份必须含自包含 schema 0 数据库、模型缓存和 V6 稳定源码；全部清单文件大小/SHA-256、恢复报告及控制文件哈希均须通过，备份不超过 24 小时且不能明显来自未来。
- 数据清单与控制清单均兼容 `{file, bytes, sha256}` 和 `{path, size, sha256}`，仅在内存中规范化，不改写原备份。每条必须完整采用一种格式；双重字段、未知字段、重复目标、非法路径、非安全整数大小或大小/哈希不匹配均拒绝。控制清单中的每个文件都校验，不能只凭恢复报告显示 PASS 绕过验证。
- 备份时效只能确认时间及候选数据与备份一致，**工具不连接旧生产库，无法自动证明旧库备份后没有外部写入**。维护人员必须对 sourceUnchangedSinceBackup 作真实确认，必要时重新备份。
- 执行、恢复、启用必须提供绑定 targetId 和备份清单哈希的维护确认，确认时间晚于备份完成、有效期最长一小时。模板全部为 false，不能直接拿模板执行。
- Windows 使用系统自带 PowerShell、CIM、TCP 监听检测和 FileShare.None 探测数据库及 WAL/SHM/journal。探测发现 Next 服务、声明端口被占或文件占用即拒绝，不强杀、不删除协调文件。PowerShell 子进程仅加载系统模块，避免桌面 PowerShell 7 的模块路径影响 Windows PowerShell。
- 句柄检查只是当时观察，不能列举/排除未来所有连接。工具另持有维护锁，事务用 BEGIN EXCLUSIVE、SQLite 锁及迁移前后全量原记录指纹检查；仍必须停止所有服务及外部 SQLite 客户端。
- 非空 WAL/SHM 拒绝执行，要求从新的完整一致性快照重建候选，不进行 checkpoint、拼接旧 WAL 或静默清理。
- 保留原表迁移 SQL；事务内检查 schema、完整性、外键、原始文件哈希、文档/切片计数与序号、向量模型/维度/归一化。提交前比较全部原 ID、元数据、原文、原始文件和向量的综合指纹，差异即回滚，不重切片或重新 Embedding。
- schema 1 重复执行只校验并报告 already-migrated，不再次重建；备份之后的原记录变化拒绝执行。已经 activation 的候选目标禁止再作为迁移工具目标。
- 生产候选入口只接受绑定收据的 deployment.json，启动校验 schema 1、目标身份、源码与依赖锁文件指纹、模型缓存校验和；默认只读，不自动迁移部署库。
- 维护标志只拒绝新请求，不撤回已发送给模型的片段，也不自动终止已在执行的任务。必须先正常结束/停止任务，再关闭服务。
- 本地 JSON 确认是操作凭证，不是数字签名、身份认证或分布式租约。仍限本机单用户，不应公开部署。

## 工具模式

```powershell
# 在项目根目录运行；父目录必须已存在。所有路径替换为本次实际绝对路径。
$migrationRoot = 'C:\XiaorenEr-Deployments\release-本次唯一编号'
$migrationTarget = Join-Path $migrationRoot 'data\knowledge.sqlite'
$migrationBackup = 'C:\XiaorenEr-Private-Backups\最新且恢复验证通过的备份'

# 显式准备：校验备份，创建受限 ACL 的新目录，复制数据库和模型；不修改源备份。
pnpm rag:migrate --prepare --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup"

# 默认 dry-run：只读核对；不执行 DDL。
pnpm rag:migrate --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup"
```

prepare 不覆盖已有 root。失败时保留现场，重新选择唯一目录；不通过删除真实数据来重试。原始文件和向量仍在候选 SQLite 中，没有独立生产上传目录需要迁移；模型只复制缓存。

维护人员在完成实际维护后，将 maintenance.template.json 另存为 confirmed-maintenance.json，逐项真实确认：operatorConfirmed、writersStopped、agentsStopped、servicesStopped、sourceUnchangedSinceBackup 全部 true；confirmedAt/expiresAt 使用 UTC ISO 时间，有效期不超过一小时，端口列表至少含 3000、3001 及所有其他项目端口。维护确认必须在本次备份完成之后。

```powershell
$migrationMaintenance = Join-Path $migrationRoot 'confirmed-maintenance.json'

# 只有另行批准后才执行；事务作用于独立候选库。
pnpm rag:migrate --execute --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup" --maintenance "$migrationMaintenance"

# 重复检查会报告 already-migrated，不重新迁移。
pnpm rag:migrate --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup"
```

成功生成 migration-receipt.json、deployment.json。收据记录数据保留检查、模型清单、目标身份及实现指纹，不输出私有文档内容、私有来源 ID、密钥或堆栈。SQL/工具/配置/源码变化会使旧部署凭证失配，需要重新审查候选，不能直接编辑收据绕过。

## 只读验收与代码/数据库配套切换

1. 固定待发布代码与锁文件，运行 test、lint、typecheck、build。代码冻结后再执行候选迁移和收据封存，保持构建产物与源码一致。
2. 停止所有旧项目服务；不得让旧 V6.0 代码连接 schema 1。不要只关闭浏览器而保留后台索引或 Agent SSE。
3. 指定完整 deployment.json 路径，默认 read-only：

```powershell
$env:MOYU_RAG_DEPLOYMENT = Join-Path $migrationRoot 'deployment.json'
$env:MOYU_RAG_ACCESS = 'read-only'
pnpm start --port 3011
```

4. 检查 `/api/knowledge/readiness`：mode=read-only-verification、schemaVersion=1、计数符合基线，codeFingerprint 和 receiptSha256 与部署文件一致。旧构建缺少此接口或指纹不符时停止，不开放写入。页面应显示候选库只读提示。
5. 验证文档列表、版本元数据、真实检索和旧来源；写入、普通聊天和 Agent 必须返回 503。不得为了验收触发未经授权的付费模型调用。比较候选原记录指纹保持不变。
6. 验收后正常 Ctrl+C 关闭只读服务，确认所有声明端口（包括 3011）退出；更新维护确认。只有用户**另行批准正式启用**后执行：

```powershell
# 从 migration-target.json 人工核对 targetId；不得使用无关运行 ID。
$approvedTargetId = '人工核对的本次 targetId'
pnpm rag:migrate --approve-cutover "$approvedTargetId" --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup" --maintenance "$migrationMaintenance"
$env:MOYU_RAG_ACCESS = 'approved-write'
pnpm start --port 3000
```

启用操作只写候选目录中的 activation.json，不迁移旧库、不启动服务、不修改 .env.local、不自动开放公网。没有 activation.json 或没有明确 approved-write 的服务继续只读或拒绝启动。启用后只通过新服务写新库，保留旧库及备份，不允许两个版本分流写入。

本部署方式需要完整源码工作目录、锁文件与已经构建的 .next；不支持只复制 standalone 输出后缺少源码校验文件。Next 文件追踪明确排除环境文件、生产数据和测试目录；受控运行期文件访问不把私有缓存打包进服务产物。每次构建后应检查 NFT 部署清单中没有这些文件。

如仅需拒绝现有新请求，可在服务启动时设 `MOYU_MAINTENANCE=1`；正式迁移仍必须停机，工具检测到监听/句柄会拒绝执行。上述环境变量只影响当前终端/进程，应按批准后的运行配置管理，不把密钥写入命令。

## 失败、崩溃与回退

- 正常异常：事务 ROLLBACK 并释放工具维护锁；schema 0 的原始记录必须完整一致。发生故障不会将缺失索引标记成功。
- 测试/系统中断：维护锁保留且阻止服务连接。确认所属进程已退出，不手工删除锁或 journal。显式执行恢复：

```powershell
pnpm rag:migrate --recover --root "$migrationRoot" --target "$migrationTarget" --backup "$migrationBackup" --maintenance "$migrationMaintenance"
```

恢复会再次检查备份、维护凭证、端口和句柄，拒绝活着或无法确认退出的锁拥有者；由 SQLite 回滚热日志，再检查原数据指纹。旧锁改名留存。若中断发生在提交后但收据写入前，校验通过后可补全收据；不会把 schema 1 误当成 schema 0 再重建。

- 凭证损坏、外部数据修改、磁盘故障或恢复无法证明一致时保持停止，不自动修复、覆盖或删除候选。保留现场，从可信备份准备新的唯一目录。
- 写入开放前回退：关闭新服务，撤销终端中的部署环境变量，恢复已验证的 V6.0 源码及 schema 0 数据副本到新的目录，核验依赖、模型、数据和旧引用后启动。原库本轮未动，可在维护确认下选择原库；不要在开发分支中删除路径保护来连接它。
- 写入开放后回退：先停止新写入并完整保全新库及 WAL/SHM，评估新版本期间的变更如何导出/协调。不能用旧快照静默覆盖新数据，也不能仅切 Git 标签。
- 原始生产 WAL/SHM 不得混入恢复快照目录。恢复脚本必须匹配备份中的稳定代码；原 .env.local 由用户安全保留，不能被空模板覆盖。

## 测试范围与未覆盖风险

虚构测试覆盖路径/硬链接/联接、备份时效及篡改、维护凭证、占用句柄/端口、WAL/SHM、事务三个故障点、进程强制中断/热日志恢复、重复迁移、只读及独立写批准；原有知识库与 LangGraph 回归继续运行。虚构凭证是用于测试门禁的 stub，不代表真实模型或私有备份的验收结果。

最新私有备份副本单独进行真实迁移/数据保留/恢复与只读服务验证，其含私有内容的证据仅保存在私有演练目录，不能提交 Git。本轮不在旧生产路径执行任何 SQL，不开放真实生产写入，不调用付费 API。

物理断电、磁盘满、硬盘故障、跨机器安装、长期生产并发、多用户权限和公开部署未被模拟。OS 句柄检查存在观察窗口，外部不遵守维护约定的写入仍需运维治理。启用后的数据变更不能靠旧备份无损撤回。正式执行前仍需新鲜维护快照与单独人工批准。
