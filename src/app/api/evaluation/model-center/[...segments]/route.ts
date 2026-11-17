import {modelCenterApi} from '@/lib/model-center/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{segments:string[]}>};
async function handle(request:Request,context:Context){return modelCenterApi(request,(await context.params).segments);}
export {handle as GET,handle as POST};
