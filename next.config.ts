import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  ...(process.env.MOYU_E2E==='1'?{distDir:'.next-e2e'}:process.env.MOYU_V7_BUILD==='1'?{distDir:'.next-v7'}:{}),
  devIndicators: false,
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node', 'pdfjs-dist', '@napi-rs/canvas', 'yauzl'],
  // Runtime data and credentials are never deployment artifacts, even when tracing dynamic code.
  outputFileTracingExcludes: { '/*': ['./.env*','./.moyu/**/*','./tmp/**/*','./uploads/**/*','./vectors/**/*','./models/**/*','./data/**/*','./storage/**/*','./.cache/**/*'] },
};
export default nextConfig;
