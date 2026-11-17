'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { gaugeOption } from './options';
import { finite, formatValue, validRange } from './validation';
import type { GaugeChartProps, OptionBuilder } from './types';
const load = () => import('./engines/gauge');
export function GaugeChart({ value, range, unit, ...common }: GaugeChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => gaugeOption({ value, range, unit }, p, compact), [value, range, unit]);
  const invalid = !validRange(range) || !finite(value) || (value !== null && (value < range[0] || value > range[1]));
  return <ChartFrame {...common} kind="gauge" load={load} buildOption={buildOption} inputError={invalid ? '仪表盘数值或显示范围无效；不自动截断数据。' : null} empty={value === null}
    rows={[{ label: common.title, value: formatValue(value, unit), selection: { name: common.title, value } }]} />;
}
