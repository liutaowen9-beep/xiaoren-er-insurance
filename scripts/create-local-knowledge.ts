import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveLocalLibrary } from '../src/lib/rag/local-library';

const input = process.argv[2];
if (!input || !path.isAbsolute(input) || existsSync(input)) throw new Error('请明确指定一个尚不存在的本机绝对目录；不覆盖已有数据。');
const root = path.resolve(input);
// The parent must exist; never create or traverse unknown directory trees.
mkdirSync(root);
writeFileSync(path.join(root, 'local-library.json'), JSON.stringify({ format: 1, purpose: 'moyu-independent-library', root, id: randomUUID() }, null, 2), { flag: 'wx' });
resolveLocalLibrary(root, process.cwd());
console.log('独立知识库空目录已登记；尚未导入任何文档。');
