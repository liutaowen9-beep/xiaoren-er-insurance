'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { categoryOption } from './options';
import { categoryError, formatValue } from './validation';
import type { CategoryChartProps, OptionBuilder } from './types';
const load = () => import('./engines/bar');
export function BarChart({ categories, series, unit, ...common }: CategoryChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => categoryOption('bar', { categories, series, unit }, p, compact), [categories, series, unit]);
  return <ChartFrame {...common} kind="bar" load={load} buildOption={buildOption} inputError={categoryError(categories, series)} empty={!series.some(s => s.values.some(v => v !== null))}
    rows={series.flatMap(s => s.values.map((value, index) => ({ label: `${s.name} · ${categories[index]}`, value: formatValue(value, unit), selection: { name: categories[index], seriesName: s.name, dataIndex: index, value } })))} />;
}
