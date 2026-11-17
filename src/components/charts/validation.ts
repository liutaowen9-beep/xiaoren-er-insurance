import type { CategorySeries, SankeyChartProps } from './types';

export const formatValue = (value: number | null, unit = '') => value === null ? '未提供' : `${value}${unit}`;
export const finite = (value: number | null) => value === null || Number.isFinite(value);
export const unique = (names: readonly string[]) => names.every(name => name.trim().length > 0) && new Set(names).size === names.length;
export const validRange = (range: readonly [number, number]) => range.every(Number.isFinite) && range[0] < range[1];
export function categoryError(categories: readonly string[], series: readonly CategorySeries[]) {
  if (!unique(categories) || !unique(series.map(s => s.name))) return '分类或系列名称不能为空或重复。';
  if (series.some(s => s.values.length !== categories.length || !s.values.every(finite))) return '系列长度与分类不一致，或含有无效数值。';
  return null;
}
// Structural DAG validation only; never derives a business flow or changes its weights.
export function sankeyError({ nodes, links }: Pick<SankeyChartProps, 'nodes' | 'links'>) {
  if (!unique(nodes.map(n => n.name))) return '流转节点名称不能为空或重复。';
  const indegrees = new Map(nodes.map(n => [n.name, 0]));
  const next = new Map(nodes.map(n => [n.name, [] as string[]]));
  for (const link of links) {
    if (!indegrees.has(link.source) || !indegrees.has(link.target) || !Number.isFinite(link.value) || link.value < 0) return '流转关联缺少节点或含有无效权重。';
    indegrees.set(link.target, indegrees.get(link.target)! + 1);
    next.get(link.source)!.push(link.target);
  }
  const queue = [...indegrees].filter(([, degree]) => degree === 0).map(([name]) => name);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    visited++;
    for (const target of next.get(queue[i])!) {
      const degree = indegrees.get(target)! - 1;
      indegrees.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  return visited === nodes.length ? null : '桑基图要求无环流转；请核对来源数据，不自动修改关联。';
}
