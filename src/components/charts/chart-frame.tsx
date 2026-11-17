'use client';

import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EChartsType } from 'echarts/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { readChartPalette } from './theme';
import type { ChartCommonProps, ChartLoader, ChartRow, OptionBuilder } from './types';
import styles from './charts.module.css';

type Props = ChartCommonProps & { kind: string; empty: boolean; inputError?: string | null; rows: readonly ChartRow[]; buildOption: OptionBuilder; load: ChartLoader };

export function ChartFrame(props: Props) {
  const { title, description, source, className, rows, onSelect } = props;
  const sourceError = !source.label.trim() ? '请注明数据来源。' : source.kind === 'evaluation' && (!source.metricDefinition?.trim() || !source.datasetVersion?.trim() || !source.evaluationRunId?.trim()) ? '评测图表缺少口径、数据集版本或评测记录。' : null;
  const message = props.error || (props.loading ? '正在加载图表数据…' : props.notConnected ? '指标未接入' : sourceError || props.inputError || (props.empty ? '暂无数据' : null));
  const failed = !!(props.error || (!props.loading && !props.notConnected && (sourceError || props.inputError)));
  return <Card role="figure" aria-label={title} className={cn(styles.card, className)} data-chart-kind={props.kind}>
    <CardHeader className={styles.header}><CardTitle><h3 className={styles.title}>{title}</h3></CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader>
    <CardContent className={styles.content}>
      {message ? <div className={styles.status} role={failed ? 'alert' : 'status'}>{message}</div> : <ChartCanvas {...props} />}
      <div className={styles.source}><p>来源：{source.label}{source.scope ? ` · ${source.scope}` : ''}</p>{source.metricDefinition && <p>口径：{source.metricDefinition}</p>}{source.datasetVersion && <p>数据集版本：{source.datasetVersion}</p>}{source.evaluationRunId && <p>评测记录：{source.evaluationRunId}</p>}{source.observedAt && <p>数据时间：{source.observedAt}</p>}</div>
      {!message && <details className={styles.table}><summary>查看图表数据</summary><div className={styles.scroll}><table aria-label={`${title}数据`}><thead><tr><th scope="col">数据项</th><th scope="col">数值</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.label}-${index}`}><th scope="row">{onSelect ? <Button variant="ghost" size="sm" onClick={() => onSelect(row.selection)} aria-label={`选择 ${row.label}`}>{row.label}</Button> : row.label}</th><td>{row.value}</td></tr>)}</tbody></table></div></details>}
    </CardContent>
  </Card>;
}

function ChartCanvas({ load, buildOption, title, height = 300, chartRef, onSelect, onLegendChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<EChartsType | null>(null);
  const latest = useRef({ buildOption, onSelect, onLegendChange });
  const redraw = useRef<(() => void) | null>(null);
  const [runtime, setRuntime] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);

  useImperativeHandle(chartRef, () => ({
    async exportImage(type = 'png', pixelRatio = 2) {
      const chart = instance.current;
      if (runtime !== 'ready' || !chart || chart.isDisposed()) return null;
      chart.getZr().flush();
      return chart.getDataURL({ type, pixelRatio: Number.isFinite(pixelRatio) ? Math.max(1, Math.min(pixelRatio, 3)) : 2, backgroundColor: readChartPalette(host.current!).background });
    },
  }), [runtime]);

  useEffect(() => {
    latest.current = { buildOption, onSelect, onLegendChange };
    redraw.current?.();
  }, [buildOption, onSelect, onLegendChange]);

  useEffect(() => {
    const element = host.current!;
    let cancelled = false, importing = false, inView = typeof IntersectionObserver === 'undefined', frame = 0;
    function render() {
      const chart = instance.current;
      if (!chart || chart.isDisposed()) return false;
      try {
        const option = latest.current.buildOption(readChartPalette(element), element.clientWidth < 480);
        const previous = (chart.getOption()?.legend as { selected?: Record<string, boolean> }[] | undefined)?.[0];
        const legend = option.legend as { selected?: Record<string, boolean> } | undefined;
        if (legend) option.legend = { ...legend, selected: { ...previous?.selected, ...legend.selected } };
        chart.setOption(option, { notMerge: true });
        chart.resize();
        return true;
      } catch { if (!cancelled) setRuntime('error'); return false; }
    }
    async function mount() {
      if (cancelled || importing || instance.current || !inView || !element.clientWidth || !element.clientHeight) return;
      importing = true;
      try {
        const engine = await load();
        if (cancelled) return;
        const chart = engine.init(element);
        instance.current = chart;
        chart.on('click', (event: unknown) => {
          if (!event || typeof event !== 'object') return;
          const item = event as { name?: string; seriesName?: string; dataIndex?: number; value?: unknown };
          latest.current.onSelect?.({ name: item.name ?? '', seriesName: item.seriesName, dataIndex: item.dataIndex, value: item.value });
        });
        chart.on('legendselectchanged', (event: unknown) => {
          const selected = (event as { selected?: Record<string, boolean> }).selected;
          if (selected) latest.current.onLegendChange?.({ ...selected });
        });
        const rendered = render();
        if (!cancelled && rendered) setRuntime('ready');
      } catch { if (!cancelled) setRuntime('error'); }
    }
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { if (instance.current) render(); else void mount(); });
    };
    redraw.current = schedule;
    const sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    sizes?.observe(element);
    const visibility = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting);
      if (inView) void mount();
    }, { rootMargin: '100px' }) : null;
    visibility?.observe(element);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    window.addEventListener('resize', schedule);
    void mount();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      visibility?.disconnect(); sizes?.disconnect(); theme.disconnect();
      window.removeEventListener('resize', schedule);
      redraw.current = null;
      instance.current?.dispose();
      instance.current = null;
    };
  }, [load, attempt]);

  return <div className={styles.frame} style={{ height: Math.max(180, height) }} data-chart-state={runtime}>
    <div ref={host} className={styles.surface} data-chart-surface="" aria-label={`${title}图形`} />
    {runtime === 'loading' && <div className={cn(styles.status, styles.pending)} role="status">正在准备图表…</div>}
    {runtime === 'error' && <div className={cn(styles.status, styles.overlay)} role="alert">图表加载失败，请重试或核对数据。<Button variant="outline" onClick={() => { setRuntime('loading'); setAttempt(value => value + 1); }}>重试图表</Button></div>}
  </div>;
}
