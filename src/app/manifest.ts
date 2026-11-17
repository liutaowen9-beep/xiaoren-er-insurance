import type { MetadataRoute } from 'next';
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from '@/lib/product-identity';

export default function manifest(): MetadataRoute.Manifest {
  return {name:PRODUCT_NAME,short_name:PRODUCT_NAME,description:PRODUCT_DESCRIPTION,lang:'zh-CN',start_url:'/',display:'standalone',background_color:'#080d19',theme_color:'#2563eb',icons:[{src:'/icon.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]};
}
