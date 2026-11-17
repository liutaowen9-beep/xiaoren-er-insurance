import type { Metadata } from 'next';
import './globals.css';
import './branding.css';
import './showcase.css';
import './visual-system.css';
import { BrandProvider } from '@/components/brand-provider';
import { PRODUCT_NAME, PRODUCT_DESCRIPTION } from '@/lib/product-identity';

export const metadata: Metadata = { title: `${PRODUCT_NAME} · AI 保险智能解决方案平台`, description: PRODUCT_DESCRIPTION, applicationName: PRODUCT_NAME, manifest:'/manifest.webmanifest', appleWebApp:{title:PRODUCT_NAME} };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" data-theme="dark"><body><BrandProvider>{children}</BrandProvider></body></html>;
}
