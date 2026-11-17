'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BRAND_STORAGE_KEY, DEFAULT_BRAND, brandPalette, decodeBrand, serializeBrand, type BrandSettings } from '@/lib/branding';

type BrandContextValue={brand:BrandSettings;ready:boolean;notice:string;save:(value:BrandSettings)=>void};
const BrandContext=createContext<BrandContextValue>({brand:{...DEFAULT_BRAND},ready:false,notice:'',save:()=>{throw new Error('设置尚未初始化。');}});
export function useBranding(){return useContext(BrandContext);}
export function BrandMark(){const {brand}=useBranding();return <span className="brand-mark brand-text-mark" data-long={brand.logoText.length>2} aria-hidden="true">{brand.logoText}</span>;}
export function BrandProvider({children}:{children:React.ReactNode}){
  const [brand,setBrand]=useState<BrandSettings>({...DEFAULT_BRAND}),[ready,setReady]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{
    let alive=true;
    const read=()=>{let next:BrandSettings={...DEFAULT_BRAND},message='';try{next=decodeBrand(localStorage.getItem(BRAND_STORAGE_KEY));}catch{message='外观设置无法读取，已使用默认外观；原始记录未覆盖。';}queueMicrotask(()=>{if(alive){setBrand(next);setNotice(message);setReady(true);}});};
    read();try{const theme=localStorage.getItem('moyu-theme');if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme;}catch{/* Optional preference. */}
    const sync=(e:StorageEvent)=>{if(e.key===BRAND_STORAGE_KEY||e.key===null)read();};window.addEventListener('storage',sync);return()=>{alive=false;window.removeEventListener('storage',sync);};
  },[]);
  useEffect(()=>{
    const root=document.documentElement;
    const apply=()=>{for(const [key,value] of Object.entries(brandPalette(brand,root.dataset.theme==='dark')))root.style.setProperty(key,value);};
    apply();
    // App Router metadata can replace <title> during navigation. Keep the saved
    // display name without changing routes or server metadata/response behavior.
    const title=brand.siteName+' · '+brand.subtitle;
    const applyTitle=()=>{if(document.title!==title)document.title=title;};applyTitle();
    const titles=new MutationObserver(applyTitle);titles.observe(document.head,{childList:true,subtree:true,characterData:true});
    const observer=new MutationObserver(apply);observer.observe(root,{attributes:true,attributeFilter:['data-theme']});return()=>{observer.disconnect();titles.disconnect();};
  },[brand]);
  const save=useCallback((value:BrandSettings)=>{const raw=serializeBrand(value);try{localStorage.setItem(BRAND_STORAGE_KEY,raw);}catch{throw new Error('浏览器未允许保存设置，请检查存储权限后重试。');}setBrand(decodeBrand(raw));setNotice('');},[]);
  return <BrandContext.Provider value={{brand,ready,notice,save}}>{children}</BrandContext.Provider>;
}
