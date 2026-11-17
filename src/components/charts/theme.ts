import type { ChartPalette } from './types';

export function readChartPalette(element: HTMLElement): ChartPalette {
  const styles = getComputedStyle(element);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--panel', '#ffffff'), text: token('--text', '#14233c'),
    muted: token('--muted', '#526580'), line: token('--line', '#d9e2f1'),
    colors: [...new Set([token('--accent', '#2563eb'), token('--tech-cyan', '#0e7490'), token('--tech-violet', '#6d4ad3'), '#3b82f6', '#f59e0b', '#10b981'])],
    font: styles.fontFamily || 'Arial, "Microsoft YaHei", sans-serif',
  };
}
