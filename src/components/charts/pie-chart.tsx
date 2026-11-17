'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { pieOption } from './options';
import { finite, formatValue, unique } from './validation';
import type { PieChartProps, OptionBuilder } from './types';
const load = () => import('./engines/pie');
export function PieChart({ data, unit, ...common }: PieChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => pieOption({ data }, p, compact), [data]);
  const invalid = !unique(data.map(d => d.name)) || data.some(d => !finite(d.value) || (d.value !== null && d.value < 0));
  return <ChartFrame {...common} kind="pie" load={load} buildOption={buildOption} inputError={invalid ? '饼图要求唯一名称和非负有限数值。' : null} empty={!data.some(d => d.value !== null)}
    rows={data.map((d, index) => ({ label: d.name, value: formatValue(d.value, unit), selection: { name: d.name, dataIndex: index, value: d.value } }))} />;
}
