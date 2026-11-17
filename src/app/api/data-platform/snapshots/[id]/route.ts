import { platformApi } from '@/lib/data-platform/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return platformApi(request,'snapshot',(await context.params).id);}
