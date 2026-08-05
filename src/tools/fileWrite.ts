// 文件写入工具：支持覆盖与追加，自动创建父目录
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from '../types.js';

export const fileWrite: Tool = {
  name: 'fileWrite',
  description:
    '写入文件。mode=overwrite 覆盖原内容（默认），mode=append 追加到文件末尾。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: '写入模式，默认 overwrite',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = String(args.path);
    const content = String(args.content);
    const mode = (args.mode as 'overwrite' | 'append') ?? 'overwrite';

    // 自动创建父目录
    await mkdir(dirname(path), { recursive: true });

    if (mode === 'append') {
      await appendFile(path, content, 'utf-8');
    } else {
      await writeFile(path, content, 'utf-8');
    }

    return `已写入 ${path}（模式: ${mode}，${content.length} 字符）`;
  },
};
