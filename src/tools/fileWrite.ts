// 文件写入工具：整文件写入（overwrite 全文覆盖 / append 追加），自动创建父目录
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';

export const fileWrite: Tool = {
  name: 'fileWrite',
  description:
    '写入文件（整文件写入）。注意：mode=overwrite（默认）是用 content 完整替换文件的全部内容——文件中未被 content 包含的原有内容将永久丢失，它只能整体覆盖，不支持只覆盖某一段/某几行。需要局部修改已有文件请改用 editFile。mode=append 则在原内容之后追加到文件末尾（不丢失原有内容）。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容；overwrite 模式下即为覆盖后的完整文件内容' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description:
          '写入模式，默认 overwrite。overwrite=用 content 全文覆盖（原内容全部丢失，不支持区域覆盖）；append=追加到文件末尾',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx?: ToolContext) {
    // 相对路径按空间根解析（D3/D20）；绝对路径原样
    const path = resolveToolPath(toolWorkspaceRoot(ctx), String(args.path));
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
