import { platformApi } from '@/lib/data-platform/api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=150;
export async function POST(request:Request){return platformApi(request,'scans');}
