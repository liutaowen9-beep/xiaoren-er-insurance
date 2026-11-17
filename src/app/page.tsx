import ChatWorkspace from '@/components/chat-workspace';
import { ShowcaseHome } from '@/components/showcase-home';
import { chatEntry } from '@/lib/showcase';
export default async function Page({searchParams}:{searchParams:Promise<{mode?:string|string[]}>}){
  const {mode}=await searchParams;
  return chatEntry(mode)?<ChatWorkspace/>:<ShowcaseHome/>;
}
