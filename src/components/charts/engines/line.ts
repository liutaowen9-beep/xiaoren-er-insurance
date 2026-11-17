import { use as register } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
register([LineChart, GridComponent]);
export { init } from './base';
