'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { radarOption } from './options';
import { categoryError, formatValue } from './validation';
import type { RadarChartProps, OptionBuilder } from './types';
const load = () => import('./engines/radar');
export function RadarChart({ indicators, series, ...common }: RadarChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => radarOption({ indicators, series }, p, compact), [indicators, series]);
  const invalid = (indicators.length > 0 && indicators.length < 3) || indicators.some(i => !Number.isFinite(i.max) || !Number.isFinite(i.min ?? 0) || i.max <= (i.min ?? 0)) || series.some(s => s.values.some((v, index) => v === null || v < (indicators[index]?.min ?? 0) || v > indicators[index]?.max));
  const error = categoryError(indicators.map(i => i.name), series) || (invalid ? '雷达图需至少三个有明确范围的完整维度，不将缺失值当成零。' : null);
  return <ChartFrame {...common} kind="radar" load={load} buildOption={buildOption} inputError={error} empty={!series.some(s => s.values.some(v => v !== null))}
    rows={series.flatMap(s => s.values.map((value, index) => ({ label: `${s.name} · ${indicators[index]?.name}`, value: formatValue(value), selection: { name: indicators[index]?.name, seriesName: s.name, dataIndex: index, value } })))} />;
}
