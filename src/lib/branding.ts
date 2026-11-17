import { z } from 'zod';
import { PRODUCT_NAME, currentDisplayName, LEGACY_PRODUCT_NAMES } from './product-identity';

export const BRAND_STORAGE_KEY='moyu-branding-v1';
const label=(max:number)=>z.string().trim().min(1).max(max).refine(v=>!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v),'不能包含控制字符');
export const brandSchema=z.object({
  siteName:label(24),subtitle:label(60),welcome:label(64),
  chatName:label(16),knowledgeName:label(16),reportName:label(16),agentName:label(16),
  primary:z.string().regex(/^#[0-9a-f]{6}$/i),secondary:z.string().regex(/^#[0-9a-f]{6}$/i),logoText:label(4),
}).strict();
export type BrandSettings=z.infer<typeof brandSchema>;
export const DEFAULT_BRAND:Readonly<BrandSettings>=Object.freeze({siteName:PRODUCT_NAME,subtitle:'AI 保险智能解决方案平台',welcome:'让小人儿给您说道说道',chatName:'智能聊天',knowledgeName:'我的知识库',reportName:'AI 报告',agentName:'Agent 工作流',primary:'#2563eb',secondary:'#8b5cf6',logoText:'小'});
export function decodeBrand(raw:string|null):BrandSettings {
  if(!raw)return {...DEFAULT_BRAND};
  if(raw.length>5000)throw new Error('设置数据超过大小限制，请恢复默认设置。');
  const saved=brandSchema.parse(JSON.parse(raw));
  const display={...saved};
  for(const field of ['siteName','subtitle','welcome','chatName','knowledgeName','reportName','agentName'] as const)display[field]=currentDisplayName(saved[field]);
  if(LEGACY_PRODUCT_NAMES.some(name=>saved.logoText===name))display.logoText=DEFAULT_BRAND.logoText;
  return display;
}
export function serializeBrand(value:unknown){return JSON.stringify(brandSchema.parse(decodeBrand(JSON.stringify(brandSchema.parse(value)))));}
function luminance(hex:string){const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(n=>n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;}
export function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
export function foregroundFor(bg:string){return contrast(bg,'#ffffff')>=contrast(bg,'#000000')?'#ffffff':'#000000';}
function readable(color:string,bg:string){if(contrast(color,bg)>=4.5)return color;const target=foregroundFor(bg);for(let t=0.1;t<=1.01;t+=0.1){const mixed='#'+[1,3,5].map(i=>Math.round(parseInt(color.slice(i,i+2),16)*(1-t)+parseInt(target.slice(i,i+2),16)*t).toString(16).padStart(2,'0')).join('');if(contrast(mixed,bg)>=4.5)return mixed;}return target;}
export function brandPalette(brand:BrandSettings,dark:boolean){
  const bg=dark?'#101b17':'#f7f3ea';
  return {'--brand-solid':brand.primary,'--on-brand':foregroundFor(brand.primary),'--brand-secondary':brand.secondary,'--secondary-ink':readable(brand.secondary,bg),'--sidebar-gold':readable(brand.secondary,brand.primary),'--accent':readable(brand.primary,bg),'--accent-soft':brand.primary+(dark?'45':'12')};
}
