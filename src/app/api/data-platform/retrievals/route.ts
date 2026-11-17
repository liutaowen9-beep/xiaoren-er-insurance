import {monitorApi} from '@/lib/data-platform/monitor-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){return monitorApi(request,'retrievals');}
