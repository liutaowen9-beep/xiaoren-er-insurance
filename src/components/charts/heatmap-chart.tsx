'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { heatmapOption } from './options';
import { finite, formatValue, unique, validRange } from './validation';
import type { HeatmapChartProps, OptionBuilder } from './types';
const load = () => import('./engines/heatmap');
export function HeatmapChart({ xCategories, yCategories, data, range, unit, ...common }: HeatmapChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => heatmapOption({ xCategories, yCategories, data, range }, p, compact), [xCategories, yCategories, data, range]);
  const cells = data.map(d => JSON.stringify([d.x, d.y]));
  const invalid = !validRange(range) || !unique(xCategories) || !unique(yCategories) || new Set(cells).size !== cells.length || data.some(d => !xCategories.includes(d.x) || !yCategories.includes(d.y) || !finite(d.value) || (d.value !== null && (d.value < range[0] || d.value > range[1])));
  return <ChartFrame {...common} kind="heatmap" load={load} buildOption={buildOption} inputError={invalid ? '热力图坐标、单元格或色阶范围无效。' : null} empty={!data.some(d => d.value !== null)}
    rows={data.map((d, index) => ({ label: `${d.x} · ${d.y}`, value: formatValue(d.value, unit), selection: { name: `${d.x} · ${d.y}`, dataIndex: index, value: d.value } }))} />;
}
