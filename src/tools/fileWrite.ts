// 文件写入工具：整文件写入（overwrite 全文覆盖 / append 追加），自动创建父目录
// Task-20261023-001：①同文件写经 file-lock 串行化；②行尾适配——新文件保持 LF，
// 已存在文件 overwrite/append 将内容换行统一到该文件主导行尾（避免 LF 混入 CRLF 文件）。
import { writeFile, appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import { detectEol, adaptEol, recordWriteMtime } from './line-endings.js';
import { withFileLock } from './file-lock.js';

async function executeLocked(
  path: string,
  content: string,
  mode: 'overwrite' | 'append',
): Promise<string> {
  // 自动创建父目录（新文件场景）
  await mkdir(dirname(path), { recursive: true });

  let eolAdapted = false;
  let targetEol: '\n' | '\r\n' | null = null;
  let toWrite = content;

  if (mode === 'append') {
    // append：文件已存在时，追加内容统一到该文件主导行尾；新文件保持原样（LF）
    let exists = false;
    try {
      await stat(path);
      exists = true;
    } catch {
      /* 不存在 */
    }
    if (exists) {
      const existing = await readFile(path, 'utf-8');
      targetEol = detectEol(existing);
      toWrite = adaptEol(content, targetEol);
      eolAdapted = targetEol === '\r\n';
    }
  } else {
    // overwrite：文件已存在时，整体内容统一到该文件主导行尾；新文件保持原样（LF）
    let exists = false;
    try {
      await stat(path);
      exists = true;
    } catch {
      /* 不存在 */
    }
    if (exists) {
      const existing = await readFile(path, 'utf-8');
      targetEol = detectEol(existing);
      toWrite = adaptEol(content, targetEol);
      eolAdapted = targetEol === '\r\n';
    }
  }

  if (mode === 'append') {
    await appendFile(path, toWrite, 'utf-8');
  } else {
    await writeFile(path, toWrite, 'utf-8');
  }

  // 写成功后登记 mtime（editFile 失配诊断用）；失败不影响主流程
  try {
    const st = await stat(path);
    recordWriteMtime(path, st.mtimeMs);
  } catch {
    /* mtime 登记失败不影响写入结果 */
  }

  const eolNote = eolAdapted ? '，换行已适配 CRLF' : '';
  return `已写入 ${path}（模式: ${mode}，${content.length} 字符${eolNote}）`;
}

export const fileWrite: Tool = {
  name: 'fileWrite',
  description:
    '写入文件（整文件写入）。注意：mode=overwrite（默认）是用 content 完整替换文件的全部内容——文件中未被 content 包含的原有内容将永久丢失，它只能整体覆盖，不支持只覆盖某一段/某几行。需要局部修改已有文件请改用 editFile。mode=append 则在原内容之后追加到文件末尾（不丢失原有内容）。自动创建父目录。已存在文件的换行会自动适配该文件主导行尾（如 CRLF），新文件保持 LF；同文件写操作自动串行化。',
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
    // 同文件写操作串行化（D4）：与 editFile 共用同一锁表，跨会话/跨空间同物理文件互斥
    return withFileLock(path, () => executeLocked(path, content, mode));
  },
};
