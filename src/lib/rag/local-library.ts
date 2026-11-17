import path from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { z } from 'zod';

const markerSchema = z.object({ format: z.literal(1), purpose: z.literal('moyu-independent-library'), root: z.string(), id: z.uuid() }).strict();

/** Explicit local-library opt-in. Never treats a receipt-bound deployment as a new library. */
export function resolveLocalLibrary(input: string | undefined, projectRoot: string) {
  if (input === undefined) return null;
  if (!input || !path.isAbsolute(input) || input.startsWith('\\\\')) throw new Error('独立知识库必须指定本机绝对路径。');
  const root = path.resolve(input);
  const forbidden = path.join(projectRoot, '.moyu');
  const relative = path.relative(forbidden, root);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('不能将原生产目录注册为独立知识库。');
  for (let part = root; part !== path.dirname(part); part = path.dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('独立知识库禁止符号链接或目录联接。');
  }
  if (!existsSync(root) || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('独立知识库目录不存在或路径不规范。');
  if (['deployment.json', 'migration-target.json', 'migration-receipt.json'].some(file => existsSync(path.join(root, file)))) throw new Error('已登记部署目录不能作为新的独立知识库。');
  const markerFile = path.join(root, 'local-library.json');
  if (!existsSync(markerFile)) throw new Error('缺少独立知识库登记文件。');
  const stat = lstatSync(markerFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2048) throw new Error('独立知识库登记文件不安全。');
  const marker = markerSchema.parse(JSON.parse(readFileSync(/* turbopackIgnore: true */ markerFile, 'utf8')));
  if (marker.root !== root) throw new Error('独立知识库登记路径不匹配。');
  return root;
}
