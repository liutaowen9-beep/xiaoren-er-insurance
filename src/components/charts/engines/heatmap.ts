import { use as register } from 'echarts/core';
import { HeatmapChart } from 'echarts/charts';
import { GridComponent, VisualMapComponent } from 'echarts/components';
register([HeatmapChart, GridComponent, VisualMapComponent]);
export { init } from './base';
