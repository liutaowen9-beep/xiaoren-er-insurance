import type { EChartsCoreOption } from 'echarts/core';
import type { ChartPalette, CategoryChartProps, PieChartProps, GaugeChartProps, RadarChartProps, HeatmapChartProps, SankeyChartProps } from './types';

function tooltip(p: ChartPalette) {
  return { trigger: 'item', renderMode: 'richText', backgroundColor: p.background, borderColor: p.line, textStyle: { color: p.text, fontFamily: p.font }, confine: true };
}
function base(p: ChartPalette, compact: boolean): EChartsCoreOption {
  return {
    backgroundColor: p.background, color: p.colors, animation: false,
    textStyle: { color: p.text, fontFamily: p.font, fontSize: compact ? 11 : 12 },
    aria: { enabled: true, decal: { show: true } },
    tooltip: tooltip(p),
    legend: { type: 'scroll', bottom: 0, textStyle: { color: p.muted, fontFamily: p.font, fontSize: compact ? 10 : 12 } },
  };
}
function axis(p: ChartPalette) {
  return { axisLabel: { color: p.muted, hideOverlap: true }, axisLine: { lineStyle: { color: p.line } }, splitLine: { lineStyle: { color: p.line, type: 'dashed' } } };
}
export function categoryOption(type: 'bar' | 'line', data: Pick<CategoryChartProps, 'categories' | 'series' | 'unit'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return {
    ...base(p, compact), tooltip: { ...tooltip(p), trigger: 'axis' },
    grid: { left: compact ? 12 : 20, right: 20, top: 30, bottom: 55, containLabel: true },
    xAxis: { ...axis(p), type: 'category', data: [...data.categories], boundaryGap: type === 'bar' },
    yAxis: { ...axis(p), type: 'value', name: data.unit || undefined, nameTextStyle: { color: p.muted } },
    series: data.series.map(s => ({ name: s.name, type, data: [...s.values], connectNulls: false, barMaxWidth: 42, symbolSize: 6 })),
  };
}
export function pieOption(data: Pick<PieChartProps, 'data'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return { ...base(p, compact), series: [{ type: 'pie', radius: ['35%', '60%'], center: ['50%', '44%'], stillShowZeroSum: false, label: { color: p.text, show: !compact }, data: data.data.filter(d => d.value !== null).map(d => ({ ...d })) }] };
}
export function gaugeOption(data: Pick<GaugeChartProps, 'value' | 'range' | 'unit'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return { ...base(p, compact), legend: { show: false }, series: [{ type: 'gauge', min: data.range[0], max: data.range[1], radius: '78%', progress: { show: true, width: 12 }, axisLine: { lineStyle: { width: 12, color: [[1, p.line]] } }, axisLabel: { color: p.muted, fontSize: compact ? 10 : 12 }, axisTick: { show: false }, splitLine: { lineStyle: { color: p.muted } }, pointer: { itemStyle: { color: p.colors[0] } }, detail: { formatter: `{value}${data.unit || ''}`, color: p.text, fontSize: compact ? 20 : 26, valueAnimation: false }, data: [{ value: data.value }] }] };
}
export function radarOption(data: Pick<RadarChartProps, 'indicators' | 'series'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return { ...base(p, compact), radar: { center: ['50%', '44%'], radius: compact ? '52%' : '60%', indicator: data.indicators.map(i => ({ ...i })), axisName: { color: p.text }, axisLine: { lineStyle: { color: p.line } }, splitLine: { lineStyle: { color: p.line } }, splitArea: { show: false } }, series: [{ type: 'radar', data: data.series.map(s => ({ name: s.name, value: [...s.values] })) }] };
}
export function heatmapOption(data: Pick<HeatmapChartProps, 'data' | 'range' | 'xCategories' | 'yCategories'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return { ...base(p, compact), legend: { show: false }, grid: { left: 15, right: 15, top: 20, bottom: 65, containLabel: true },
    xAxis: { ...axis(p), type: 'category', data: [...data.xCategories], splitArea: { show: false } }, yAxis: { ...axis(p), type: 'category', data: [...data.yCategories], splitArea: { show: false } },
    visualMap: { min: data.range[0], max: data.range[1], calculable: false, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: [p.line, p.colors[0]] }, textStyle: { color: p.muted } },
    series: [{ type: 'heatmap', label: { show: true, color: p.text }, data: data.data.filter(d => d.value !== null).map(d => [data.xCategories.indexOf(d.x), data.yCategories.indexOf(d.y), d.value]) }],
  };
}
export function sankeyOption(data: Pick<SankeyChartProps, 'nodes' | 'links'>, p: ChartPalette, compact: boolean): EChartsCoreOption {
  return { ...base(p, compact), legend: { show: false }, series: [{ type: 'sankey', left: compact ? 5 : 20, right: compact ? 65 : 95, top: 25, bottom: 25, nodeWidth: 14, nodeGap: 18, emphasis: { focus: 'adjacency' }, label: { color: p.text, fontSize: compact ? 10 : 12, width: compact ? 62 : 90, overflow: 'truncate' }, lineStyle: { color: 'source', opacity: 0.3, curveness: 0.45 }, data: data.nodes.map(n => ({ ...n })), links: data.links.map(l => ({ ...l })) }] };
}
