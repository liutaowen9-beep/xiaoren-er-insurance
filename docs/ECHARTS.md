# 公共 ECharts 使用与验收

接入日期：2026-11-09。安装 `echarts@6.1.0`，通过 `echarts/core` 与每类 `engines/` 动态模块注册使用到的图型、坐标组件及 Canvas 渲染器；不使用全量入口或第三方 React 包装库。

## 使用方式

`src/components/charts` 提供 BarChart、LineChart、PieChart、GaugeChart、RadarChart、HeatmapChart、SankeyChart；对应 props 类型从同目录导出。普通数字仍优先使用现有卡片。

```tsx
import { BarChart } from '@/components/charts/bar-chart';

// categories / series 均来自上游已经定义口径的数据接口。
<BarChart
  title="当前文档状态"
  source={{ kind: 'business', label: '文档统计接口', scope: '调用方明确的数据范围', metricDefinition: '上游确认的统计口径' }}
  categories={categories}
  series={series}
/>
```

示例仅演示变量传递，没有虚构业务统计值。组件不自动 fetch 或访问 SQLite；不会进行任何业务写入。Server Component 可传序列化数据，交互回调留在局部 Client Component。

- `source` 必填；评测数据使用 `kind: 'evaluation'`，必须给出口径、数据集版本和评测记录 ID。缺失元数据时显示错误，不画缺少出处的评测曲线。
- `loading`、`error`、`notConnected` 和空数据分开显示；0 为真实零，null 为缺失。Line 保留断点，Pie 不为全零伪造相等占比，Radar 不补齐缺失维度。无效量程和循环流转给出明确错误。
- `onSelect` 支持图形点击及数据表键盘选择；`onLegendChange` 支持向上层传递图例选择。父组件负责筛选和联动，图表不更改业务状态或指标定义。
- `chartRef` 可获取 `exportImage('png'|'jpeg', pixelRatio?)`，返回 Promise<data URL|null>；未就绪/已卸载时不可导出。返回图片不等于已经接入 Word/PDF 报告导出。
- `height` 默认300px，最小180px；宽度跟随卡片与 ResizeObserver，紧凑容器使用较小标签与间距。Canvas 的多个内部图层不等于重复初始化；实例跟随组件生命周期管理。

## 性能、主题与可访问性

不在根布局注册引擎或添加 Provider。只有可见、有尺寸的容器才加载图型并初始化；异步导入完成前若卸载则取消创建，卸载断开 observers、取消 RAF、dispose 实例。支持 StrictMode 重挂载、隐藏容器重新展示和侧栏/窗口导致的尺寸变化。

颜色、字体、背景、图例和 tooltip 从现有品牌/科技风 CSS 变量读取，响应根节点 data-theme 和品牌样式变化；不覆盖全局配色。布局使用 shadcn Card/Button 与局部 CSS Modules，默认关闭图表动画，支持减少动态效果。Tooltip 使用 richText，避免将文档/模型内容作为 HTML 注入。

保留可展开数据表、来源、ARIA 和键盘选择。业务页面没有导入公共图表时，不加载 ECharts 引擎。本次没有改造现有页面或新建中台/业务演示路由。

## 数据与下一步

真实结构、现有接口与各指标缺口见 [数据来源与中台接入计划](ECHARTS-DATA-PLAN.md)。目前“有真实来源”表示源码记录可支撑部分事实，并不表示已读取生产统计；本次未打开生产数据库或调用可能初始化写库的生产 GET 接口。

已创建 `.agents/skills/echarts/SKILL.md` 和自动调用配置，根 AGENTS.md 要求后续可视化需求先检查组件、数据来源和指标口径。Skill 中的选型规则区分数字卡片、比较、趋势、组成、量程、矩阵、多维指标及真实流转。

## 隔离测试

`pnpm test:e2e charts.spec.ts` 使用现有桌面/移动 Playwright 项目、独立生产构建和 API 模拟。`charts-harness.tsx` 由 esbuild 构建为独立模块，通过 Playwright 路由夹具提供测试文档；它不被任何应用路由导入或部署。esbuild 已是 tsx 使用的工具，此次显式声明为开发依赖以稳定测试构建接口，没有新增另一套运行时图表引擎。

测试数据明确标注“Playwright 合成夹具，非生产统计”，根据当前文档 API 类型验证值的逐项传递，不冒充真实客户、评测或数据库统计；组件验证不调用付费模型、不操作生产 SQLite、WAL、SHM 或向量文件。

验收覆盖七类模块实际渲染、原值和来源、空/加载/错误/未接入、容器变化、浅深色、外部筛选、原生点击/键盘/图例事件、null 与0区别、卸载释放和重挂载、不可见容器延迟创建、循环流转拒绝、评测元数据约束、PNG/JPEG 格式与减少动态效果。最终执行结果记录在交付汇报中；HTML 报告位于已忽略的 `tmp/reports/e2e/latest/html/`。

官方参考：[按需引入](https://echarts.apache.org/handbook/zh/basics/import/)、[容器尺寸与释放](https://echarts.apache.org/handbook/zh/concepts/chart-size/)。

## 本次实际验收结果

- `pnpm typecheck`、`pnpm lint`：通过。
- `pnpm test`：211 项通过，无失败/跳过。
- `pnpm test:e2e`：72 项通过，包含新增图表 9 场景 × 桌面/移动共18项，其余54项为现有回归。
- `pnpm build`：通过。保留原有 RAG 临时目录广泛匹配的两条构建警告，未为消除警告更改业务或存储代码。
- `test:e2e:before`、`test:e2e:after`：各10项截图通过；`test:e2e:compare`：五个关键页面 × 两种设备共10张截图完全一致。
- 新图表的七类桌面/移动截图已保存于 `tmp/reports/e2e/latest/results/` 对应图表用例目录；抽查移动端柱状图、雷达图显示正常。
- Skill 格式校验通过；既有源码文件的哈希保持不变。对既有跟踪文件仅保留 AGENTS、package.json、pnpm-lock.yaml 的计划变更。

以上为隔离环境的真实执行结果。没有查询生产统计或调用真实付费模型，因此不能宣称生产指标已对账、真实模型质量已验证或生产数据中台已上线。
