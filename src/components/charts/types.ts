import type { Ref } from 'react';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';

type SourceBase = {
  label: string;
  scope?: string;
  observedAt?: string;
};
export type ChartSource = SourceBase & (
  | { kind: 'evaluation'; metricDefinition: string; datasetVersion: string; evaluationRunId: string }
  | { kind?: 'business' | 'test'; metricDefinition?: string; datasetVersion?: string; evaluationRunId?: string }
);
export type ChartSelection = { name: string; seriesName?: string; dataIndex?: number; value: unknown };
export type ChartHandle = { exportImage: (type?: 'png' | 'jpeg', pixelRatio?: number) => Promise<string | null> };
export type ChartCommonProps = {
  title: string;
  description?: string;
  source: ChartSource;
  loading?: boolean;
  error?: string | null;
  notConnected?: boolean;
  height?: number;
  className?: string;
  chartRef?: Ref<ChartHandle>;
  onSelect?: (selection: ChartSelection) => void;
  onLegendChange?: (selected: Record<string, boolean>) => void;
};
export type NamedValue = { name: string; value: number | null };
export type CategorySeries = { name: string; values: readonly (number | null)[] };
export type CategoryChartProps = ChartCommonProps & { categories: readonly string[]; series: readonly CategorySeries[]; unit?: string };
export type PieChartProps = ChartCommonProps & { data: readonly NamedValue[]; unit?: string };
export type GaugeChartProps = ChartCommonProps & { value: number | null; range: readonly [number, number]; unit?: string };
export type RadarChartProps = ChartCommonProps & { indicators: readonly { name: string; min?: number; max: number }[]; series: readonly CategorySeries[] };
export type HeatmapChartProps = ChartCommonProps & { xCategories: readonly string[]; yCategories: readonly string[]; data: readonly { x: string; y: string; value: number | null }[]; range: readonly [number, number]; unit?: string };
export type SankeyChartProps = ChartCommonProps & { nodes: readonly { name: string }[]; links: readonly { source: string; target: string; value: number }[]; unit?: string };
export type ChartPalette = { background: string; text: string; muted: string; line: string; colors: string[]; font: string };
export type OptionBuilder = (palette: ChartPalette, compact: boolean) => EChartsCoreOption;
export type ChartEngine = { init: (element: HTMLDivElement) => EChartsType };
export type ChartLoader = () => Promise<ChartEngine>;
export type ChartRow = { label: string; value: string; selection: ChartSelection };
