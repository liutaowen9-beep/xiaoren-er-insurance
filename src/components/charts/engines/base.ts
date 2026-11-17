import { init as initECharts, use as register } from 'echarts/core';
import { TooltipComponent, LegendComponent, AriaComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
register([TooltipComponent, LegendComponent, AriaComponent, CanvasRenderer]);
export function init(element: HTMLDivElement) { return initECharts(element, undefined, { renderer: 'canvas' }); }
