// Test-only browser entry; never imported by an application route.
import React, { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrandProvider } from '../../src/components/brand-provider';
import { Button } from '../../src/components/ui/button';
import { BarChart, LineChart, PieChart, GaugeChart, RadarChart, HeatmapChart, SankeyChart } from '../../src/components/charts';
import type { ChartHandle, ChartSource, ChartSelection } from '../../src/components/charts';
import type { KnowledgeDocument } from '../../src/lib/rag/types';
import type { EChartsType } from 'echarts/core';

type Kind = 'bar' | 'line' | 'pie' | 'gauge' | 'radar' | 'heatmap' | 'sankey';
const source: ChartSource = { kind: 'test', label: 'Playwright 合成夹具，非生产统计', scope: '只验证组件，模拟现有文档 API 数据结构', datasetVersion: 'e2e-synthetic-v1', metricDefinition: '传入值原样显示，不计算业务指标' };
let remembered: EChartsType | undefined;
declare global {
  interface Window {
    __chartProbe: {
      read: () => Promise<{ width: number; height: number; series: Record<string, unknown>[]; background: unknown; animation: unknown; textStyle: unknown } | null>;
      remember: () => Promise<void>;
      disposed: () => boolean;
      point: () => Promise<number[]>;
      toggleLegend: () => Promise<void>;
    };
  }
}
window.__chartProbe = {
  async read() {
    const { getInstanceByDom } = await import('echarts/core');
    const host = document.querySelector<HTMLElement>('[data-chart-surface]');
    const chart = host ? getInstanceByDom(host) : undefined;
    if (!chart) return null;
    const option = chart.getOption();
    return { width: chart.getWidth(), height: chart.getHeight(), series: option.series as Record<string, unknown>[], background: option.backgroundColor, animation: option.animation, textStyle: option.textStyle };
  },
  async remember() {
    const { getInstanceByDom } = await import('echarts/core');
    remembered = getInstanceByDom(document.querySelector<HTMLElement>('[data-chart-surface]')!);
  },
  disposed() { return !!remembered?.isDisposed(); },
  async point() {
    const { getInstanceByDom } = await import('echarts/core');
    const chart = getInstanceByDom(document.querySelector<HTMLElement>('[data-chart-surface]')!)!;
    return chart.convertToPixel({ seriesIndex: 0 }, [0, 3]) as number[];
  },
  async toggleLegend() {
    const { getInstanceByDom } = await import('echarts/core');
    getInstanceByDom(document.querySelector<HTMLElement>('[data-chart-surface]')!)!.dispatchAction({ type: 'legendToggleSelect', name: '切片数量' });
  },
};

function Harness() {
  const [documents, setDocuments] = useState<KnowledgeDocument[] | null>(null);
  const [kind, setKind] = useState<Kind>('bar');
  const [phase, setPhase] = useState('ready');
  const [mounted, setMounted] = useState(true);
  const [hidden, setHidden] = useState(new URLSearchParams(location.search).has('hidden'));
  const [narrow, setNarrow] = useState(false);
  const [filtered, setFiltered] = useState(false);
  const [selected, setSelected] = useState('');
  const [legend, setLegend] = useState('');
  const [withGap, setWithGap] = useState(false);
  const [cycle, setCycle] = useState(false);
  const ref = useRef<ChartHandle>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/knowledge/documents').then(r => r.json()).then(body => { if (!cancelled) setDocuments(body.documents); });
    return () => { cancelled = true; };
  }, []);
  const docs = phase === 'empty' ? [] : (documents ?? []).slice(0, filtered ? 1 : undefined);
  const categories = docs.map(d => d.name);
  const values = docs.map((d, i) => withGap && i === 1 ? null : d.chunkCount);
  const series = [{ name: '切片数量', values }];
  const chartSource: ChartSource = new URLSearchParams(location.search).has('incomplete') ? { ...source, kind: 'evaluation', metricDefinition: '', datasetVersion: '', evaluationRunId: '' } : source;
  const common = { source: chartSource, title: `E2E ${kind}`, loading: phase === 'loading' || !documents, error: phase === 'error' ? 'E2E 模拟接口错误' : null, notConnected: phase === 'unconnected', chartRef: ref, onSelect: (value: ChartSelection) => setSelected(value.name), onLegendChange: (value: Record<string, boolean>) => setLegend(JSON.stringify(value)) };
  async function exportImage(type: 'png' | 'jpeg') {
    const url = await ref.current?.exportImage(type);
    if (!url) return;
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `E2E-chart.${type}`; anchor.click();
  }
  function leaveHarness() {
    // This standalone test document has no Next router; a full document exit is intentional.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    location.assign('/');
  }
  return <main style={{ padding: 16, maxWidth: 1000, margin: 'auto', fontFamily: 'var(--font-ui)' }}>
    <h1>图表隔离验收 · 合成数据</h1><p>此页面仅由 Playwright 路由夹具提供，不是业务页面。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <label>图表类型<select aria-label="图表类型" value={kind} onChange={e => setKind(e.target.value as Kind)}>{['bar', 'line', 'pie', 'gauge', 'radar', 'heatmap', 'sankey'].map(name => <option key={name}>{name}</option>)}</select></label>
      <label>数据状态<select aria-label="数据状态" value={phase} onChange={e => setPhase(e.target.value)}>{['ready', 'loading', 'empty', 'error', 'unconnected'].map(name => <option key={name}>{name}</option>)}</select></label>
      <Button onClick={() => { const root = document.documentElement; root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; }}>切换主题</Button>
      <Button onClick={() => setNarrow(v => !v)}>改变容器宽度</Button>
      <Button onClick={() => setHidden(v => !v)}>切换容器可见</Button>
      <Button onClick={() => setMounted(v => !v)}>切换图表挂载</Button>
      <Button onClick={() => setFiltered(v => !v)}>筛选第一份</Button>
      <Button onClick={() => setWithGap(v => !v)}>缺失值夹具</Button>
      <Button onClick={() => setCycle(v => !v)}>循环流转夹具</Button>
      <Button onClick={() => void exportImage('png')}>导出 PNG</Button>
      <Button onClick={() => void exportImage('jpeg')}>导出 JPEG</Button>
    </div>
    <output aria-label="选择事件">{selected}</output><output aria-label="图例事件">{legend}</output>
    <div style={{ display: hidden ? 'none' : 'block', width: narrow ? '65%' : '100%', marginTop: new URLSearchParams(location.search).has('below') ? 1800 : 20 }}>
      {mounted && (kind === 'bar' ? <BarChart {...common} categories={categories} series={series} />
        : kind === 'line' ? <LineChart {...common} categories={categories} series={series} />
        : kind === 'pie' ? <PieChart {...common} data={docs.map(d => ({ name: d.name, value: d.chunkCount }))} />
        : kind === 'gauge' ? <GaugeChart {...common} value={docs[0]?.chunkCount ?? null} range={[0, 10]} />
        : kind === 'radar' ? <RadarChart {...common} indicators={[{ name: '维度A', max: 10 }, { name: '维度B', max: 10 }, { name: '维度C', max: 10 }]} series={docs.length ? [{ name: '合成样本', values: [7, 3, 0] }] : []} />
        : kind === 'heatmap' ? <HeatmapChart {...common} xCategories={categories} yCategories={['合成样本']} data={docs.map(d => ({ x: d.name, y: '合成样本', value: d.chunkCount }))} range={[0, 10]} />
        : <SankeyChart {...common} nodes={docs.length ? [{ name: '合成起点' }, { name: '合成终点' }] : []} links={docs.length ? [{ source: '合成起点', target: '合成终点', value: 7 }, ...(cycle ? [{ source: '合成终点', target: '合成起点', value: 3 }] : [])] : []} />)}
    </div>
    <Button onClick={leaveHarness}>离开测试页面</Button>
  </main>;
}
document.documentElement.dataset.theme = 'light';
createRoot(document.getElementById('charts-test-root')!).render(<StrictMode><BrandProvider><Harness /></BrandProvider></StrictMode>);
