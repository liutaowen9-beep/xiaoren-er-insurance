import { use as register } from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
register([BarChart, GridComponent]);
export { init } from './base';
