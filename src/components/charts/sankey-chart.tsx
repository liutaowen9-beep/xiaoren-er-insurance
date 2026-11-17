'use client';
import { useCallback } from 'react';
import { ChartFrame } from './chart-frame';
import { sankeyOption } from './options';
import { formatValue, sankeyError } from './validation';
import type { SankeyChartProps, OptionBuilder } from './types';
const load = () => import('./engines/sankey');
export function SankeyChart({ nodes, links, unit, ...common }: SankeyChartProps) {
  const buildOption = useCallback<OptionBuilder>((p, compact) => sankeyOption({ nodes, links }, p, compact), [nodes, links]);
  return <ChartFrame {...common} kind="sankey" load={load} buildOption={buildOption} inputError={sankeyError({ nodes, links })} empty={!nodes.length || !links.length}
    rows={links.map((link, index) => ({ label: `${link.source} → ${link.target}`, value: formatValue(link.value, unit), selection: { name: `${link.source} → ${link.target}`, dataIndex: index, value: link.value } }))} />;
}
