import { use as register } from 'echarts/core';
import { RadarChart } from 'echarts/charts';
import { RadarComponent } from 'echarts/components';
register([RadarChart, RadarComponent]);
export { init } from './base';
