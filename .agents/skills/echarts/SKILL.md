---
name: echarts
description: 在小人儿保险处理统计、趋势、评测、工作流或报告可视化时，判断是否需要 ECharts，复用公共图表并核对真实来源、指标口径、主题和浏览器行为。
---

# 小人儿保险数据可视化

## 先确认需求与来源

- 先检查现有页面、API、数据模型及 `src/components/charts/`；优先复用，保留已有图表库与业务组件。普通文字、单个数字或状态提示不强行画图。
- 图表仅展示传入值，不计算或改变业务指标、排名、风险分、成功率和评测算法；复杂聚合由后端或专门分析模块完成。禁止依据相似度、状态数量或 AI 定性文字自创“准确率”“幻觉率”“风险分”。
- 业务图表必须对应真实记录、明确范围和口径。无接口用 `notConnected`，接口正常但无记录用空数组/null；不以 0 替代未知，不用示例值冒充真实统计。
- 传入 `source` 标明来源、范围与口径；评测图表使用 `kind: 'evaluation'`，必须带 `metricDefinition`、`datasetVersion`、`evaluationRunId`。组件会拒绝缺少这些信息的评测图表。合成数据只用于隔离测试并明确标注 `kind: 'test'`。
- 接数据中台、评测中台前先读 [现有来源与接入计划](../../../docs/ECHARTS-DATA-PLAN.md) 的实际项目位置：仓库根 `docs/ECHARTS-DATA-PLAN.md`。该计划是源码盘点，不是生产数据库审计或真实统计结果；以当前代码为准。

## 图型与接口

从 `@/components/charts` 或对应子文件导入。七类公共组件均为 Client Component，可由 Server Component 传递可序列化数据；事件处理仅放在小范围客户端边界，不将整页或根布局改为客户端。

| 组件 | 合适的数据 | 关键约束 |
| --- | --- | --- |
| BarChart | 类别、版本之间的数量/指标对比 | 分类和系列唯一，values 与分类等长 |
| LineChart | 具有明确顺序或时间范围的趋势 | 时间桶及缺测处理由上游确定；null 保留断点 |
| PieChart | 同口径、互斥类别的组成 | 非负；未知项不画切片，真实零不伪造占比 |
| GaugeChart | 单项指标相对明确量程 | 调用方提供 range；越界显示错误，不自动截断或乘100 |
| RadarChart | 口径可比且有范围的多维指标 | 至少三维，max/min 明确；不将缺失维度当零 |
| HeatmapChart | 模型×数据集、日期×分类等矩阵 | 坐标唯一、range 明确、缺失单元格不补零 |
| SankeyChart | 同一批对象的真实流转及分支 | links 由真实事件聚合提供；不能用各状态当前快照伪造流量，环图应改用合适视图 |

- 筛选、联动由调用方控制数据。`onSelect` 传递真实选中项；`onLegendChange` 传递图例选择，不能因此自行触发业务写入或重跑 Agent。
- 源数据不原地修改；传给 ECharts 的数组/对象由封装复制。分类校验、图结构校验和坐标映射是展示结构检查，不是业务指标计算。
- `chartRef.current?.exportImage('png' | 'jpeg')` 返回图像 data URL；未就绪/卸载时不可导出，调用方需处理 null。用于未来 Word/PDF 集成，不自动修改现有报告导出流程或写文件。

## 按需与生命周期

- 严禁 `import * as echarts from 'echarts'`、dist 全量入口或另装 React 包装器。使用 `echarts/core`、`echarts/charts`、`echarts/components`、`echarts/renderers`；类型使用 `import type`。
- 现有每个组件通过自己的动态 `engines/<kind>` 入口加载图型，公共核心注册 tooltip、legend、ARIA、CanvasRenderer；网格、雷达、色阶按图型注册。仅在容器可见且尺寸非零时初始化，不把七个引擎合并成一个全量初始化文件。
- 修改 `ChartCanvas` 必须保留：异步导入取消检查、ResizeObserver、IntersectionObserver、根主题监听、RAF 合并、卸载 disconnect/cancel/dispose、重挂载和 StrictMode 兼容。尺寸变化不仅是 window resize，还包括侧栏/卡片变化与隐藏容器重新展示。
- 保持 loading、error、暂无数据与未接入分离，加载失败不能保留旧数据冒充新结果。数据更新用干净 option 替换，主题/尺寸更新保留用户图例选择。
- 大数据应先在上游限定范围，避免无界热力图和长表；按场景评估窗口化和聚合，不偷偷抽样或更改统计分母。性能优化不得改变指标含义。

## 视觉与安全

- 复用 shadcn Card/Button；样式局限在 `charts.module.css`，颜色/字体从现有 CSS 变量读取。不覆盖品牌或 data-theme，不另建全局主题 Provider。
- 未来科技风 + 极简高级风：统一配色、字体、图例、间距和 tooltip，兼容浅深色与移动端，克制渐变、光效和装饰。
- tooltip 使用 Canvas richText，不把文档或模型内容作为 HTML formatter；保留来源信息、ARIA 和数据表/键盘选择。缺失值与真实零必须可区分。
- 图表默认关闭自身动画，保证数值稳定与减少动态效果偏好；确需进入/状态动效再按 Motion Skill 局部处理。不要给流式 token 或执行步骤添加虚假进度动画。
- 不访问、迁移或写入生产 SQLite、WAL、SHM、向量文件。不要仅为检查图表而调用 `getStore()` 或生产 GET 接口：现有存储初始化可能恢复任务并写库；先使用源码盘点和隔离夹具，真实只读接入需明确无副作用的后端边界。

## 验收

遵循项目 Playwright Skill。运行 `pnpm typecheck`、`pnpm lint`、`pnpm test:e2e charts.spec.ts`（含独立生产构建），再运行受影响回归。验证传入值逐项一致、空/错误/未接入、resize、浅深色、筛选/点击/键盘、卸载/重挂载、移动端、减少动态效果及图片导出；不能只看 canvas 存在就通过。

测试入口 `tests/e2e/charts-harness.tsx` 由 Playwright 路由夹具和 esbuild 提供，使用模拟 API 数据，不作为生产页面。诊断接口仅存在于夹具，严禁挂到应用 window 上。业务页面未使用图表时不应请求 ECharts 引擎。

官方参考：[按需引入](https://echarts.apache.org/handbook/zh/basics/import/)、[尺寸与释放](https://echarts.apache.org/handbook/zh/concepts/chart-size/)、[ECharts 手册](https://echarts.apache.org/handbook/zh/)。
