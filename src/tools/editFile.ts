// 文件编辑工具：默认按字面文本替换（唯一匹配才替换，防止误改），可选正则模式；支持按行范围整段替换
// Task-20261023-001：①行尾归一化匹配（oldText 按 \n 产出也能匹配 CRLF/混合行尾文件），
// 写回偏移映射——未触及区域字节级保留、替换段适配主导行尾；②同文件写经 file-lock 串行化；
// ③失配时区分「文件已被并发修改」与「未找到」（附首个差异行与近似候选）。
import { readFile, writeFile, stat } from 'node:fs/promises';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import {
  detectEol,
  normalizeEol,
  adaptEol,
  firstDiffLine,
  similarCandidates,
  replaceNormalized,
  recordWriteMtime,
  isMtimeChanged,
} from './line-endings.js';
import { withFileLock } from './file-lock.js';

/**
 * 编译正则并确保带 g 标志（全局匹配用于计数与替换）
 * @param pattern 正则表达式
 * @param flags 用户提供的标志
 * @returns 正则实例与规范化后的标志字符串
 */
function toRegex(pattern: string, flags: string): { re: RegExp; flags: string } {
  const effectiveFlags = flags.includes('g') ? flags : `${flags}g`;
  try {
    return { re: new RegExp(pattern, effectiveFlags), flags: effectiveFlags };
  } catch (e) {
    throw new Error(
      `正则表达式或 flags 非法（/${pattern}/${effectiveFlags}）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** 写文件后登记 mtime（失败诊断用）；登记失败不影响主流程 */
async function writeAndRecord(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf-8');
  try {
    const st = await stat(path);
    recordWriteMtime(path, st.mtimeMs);
  } catch {
    /* mtime 登记失败不影响编辑结果 */
  }
}

/**
 * 字面量失配诊断信息（D5/D6）：
 * - mtime 相比本进程上次写登记已变化 → 提示可能被并发/外部修改；
 * - 最长公共前缀定位首个差异行；oldText 首行足够长时给出近似候选片段。
 */
async function buildNotFoundMessage(path: string, content: string, oldText: string): Promise<string> {
  const parts: string[] = [`未在 ${path} 中找到要替换的文本`];
  try {
    const st = await stat(path);
    if (isMtimeChanged(path, st.mtimeMs)) {
      parts.push(
        '检测到文件 mtime 相比本进程上次写入已变化：文件可能已被其他写操作（并发工具调用/外部编辑器）修改，建议先 fileRead 重新读取后再编辑',
      );
    }
  } catch {
    /* stat 失败忽略，不影响诊断输出 */
  }
  const contentNorm = normalizeEol(content);
  const oldNorm = normalizeEol(oldText);
  const diff = firstDiffLine(contentNorm, oldNorm);
  if (diff) {
    parts.push(
      `首个差异在第 ${diff.line} 行\n  期望: ${diff.expected}\n  实际: ${diff.actual}`,
    );
  }
  const candidates = similarCandidates(contentNorm, oldNorm);
  if (candidates.length > 0) {
    parts.push(`近似候选（供对照）:\n${candidates.join('\n---\n')}`);
  }
  return parts.join('\n');
}

async function executeLocked(path: string, args: Record<string, unknown>): Promise<string> {
  const newText = String(args.newText);
  const oldText = args.oldText != null ? String(args.oldText) : '';
  const replaceAll = args.replaceAll === true;
  const useRegex = args.regex === true;
  const flags = args.flags != null ? String(args.flags) : '';
  const startLine = args.startLine != null ? Number(args.startLine) : null;
  const endLine = args.endLine != null ? Number(args.endLine) : null;

  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (e) {
    throw new Error(
      `无法读取文件 ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 行范围模式：整段行替换
  if (startLine !== null || endLine !== null) {
    if (startLine === null || endLine === null) {
      throw new Error('startLine 与 endLine 必须同时指定');
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new Error('行号必须为整数');
    }
    if (startLine < 1 || endLine < startLine) {
      throw new Error('行号非法：startLine >= 1 且 endLine >= startLine');
    }

    const lines = content.split('\n');
    if (startLine > lines.length || endLine > lines.length) {
      throw new Error(
        `行号超出文件范围：共 ${lines.length} 行，请求第 ${startLine}-${endLine} 行`,
      );
    }

    const sliceText = lines.slice(startLine - 1, endLine).join('\n');

    // oldText 提供时用作安全校验（行尾归一化比较，CRLF 文件不再因 \r 失配）
    if (oldText.length > 0) {
      const sliceNorm = normalizeEol(sliceText);
      const oldNorm = normalizeEol(oldText);
      const hit = useRegex ? toRegex(oldNorm, flags).re.test(sliceNorm) : sliceNorm.includes(oldNorm);
      if (!hit) {
        throw new Error(
          `第 ${startLine}-${endLine} 行内容与 oldText 不匹配，已中止（可用于防止行号偏移改错位置）`,
        );
      }
    }

    // 替换段适配文件主导行尾；未触及行的行尾字节原样保留（\r 属于行 token 的一部分，
    // 「被替换末行的行尾 \r」需恢复到新末行之后，否则会引入 LF）
    const eol = detectEol(content);
    const replacementText = newText.length === 0 ? '' : adaptEol(newText, eol);
    const replacementLines = replacementText.length === 0 ? [] : replacementText.split('\n');
    const removedTail = /(\r?)$/.exec(lines[endLine - 1])?.[1] ?? '';
    const updatedLines = [
      ...lines.slice(0, startLine - 1),
      ...(replacementLines.length > 0
        ? replacementLines
            .slice(0, -1)
            .concat(replacementLines[replacementLines.length - 1] + removedTail)
        : []),
      ...lines.slice(endLine),
    ];
    await writeAndRecord(path, updatedLines.join('\n'));

    return `已编辑 ${path}（整段替换第 ${startLine}-${endLine} 行：${endLine - startLine + 1} 行 → ${replacementLines.length} 行）`;
  }

  // 以下为全文件范围替换
  if (oldText.length === 0) {
    throw new Error('oldText 不能为空（未指定 startLine/endLine 时必填）');
  }

  // 正则模式：支持 flags 与 $ 捕获引用；匹配语义不变（D1），仅替换文本行尾适配主导行尾
  if (useRegex) {
    const { re, flags: effectiveFlags } = toRegex(oldText, flags);

    const count = [...content.matchAll(re)].length;

    if (count === 0) {
      throw new Error(
        `未在 ${path} 中找到匹配 /${oldText}/${effectiveFlags} 的内容`,
      );
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `正则 /${oldText}/${effectiveFlags} 在 ${path} 中匹配 ${count} 处，为避免误改已中止。请收窄正则使其唯一，或设置 replaceAll=true 替换全部`,
      );
    }

    const replacement = adaptEol(newText, detectEol(content));
    const updated = content.replace(re, replacement);
    await writeAndRecord(path, updated);

    const replaced = replaceAll ? count : 1;
    return `已编辑 ${path}（正则替换 ${replaced} 处，flags: ${effectiveFlags}）`;
  }

  // 字面量模式（默认）：行尾归一化匹配 + 偏移映射写回（未触及区域字节级保留）
  const res = replaceNormalized(content, oldText, newText, replaceAll);

  if (res === null) {
    throw new Error(await buildNotFoundMessage(path, content, oldText));
  }
  if (res.multiple && !replaceAll) {
    throw new Error(
      `oldText 在 ${path} 中出现 ${res.count} 处，为避免误改已中止。请补充更长的上下文使其唯一，或设置 replaceAll=true 替换全部`,
    );
  }

  await writeAndRecord(path, res.updated);

  const replaced = replaceAll ? res.count : 1;
  return `已编辑 ${path}（替换 ${replaced} 处，${oldText.length} → ${newText.length} 字符）`;
}

export const editFile: Tool = {
  name: 'editFile',
  description:
    '在已有文件中替换内容，支持三种用法：①默认按字面量精确匹配替换 oldText（要求唯一出现，多处匹配会报错以避免误改，可用 replaceAll=true 替换全部）；②regex=true 时 oldText 按正则解释（flags 指定 i/m/s 等，g 自动补充），newText 支持 $1/$& 捕获引用；③指定 startLine/endLine 时进入“整段行替换”，把第 startLine-endLine 行整体替换为 newText（oldText 可选，提供则用作校验）。匹配与校验按行尾归一化（\\r\\n 与 \\n 等价），写回保持文件原行尾风格（未触及区域字节级不变，替换段适配主导行尾）；同文件写操作自动串行化，失配时报错附首个差异行与近似候选。文件必须已存在（新建文件请用 fileWrite）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      oldText: {
        type: 'string',
        description:
          '要被替换的原文本（未指定行范围时必填）；regex=true 时为正则表达式；多行文本按 \\n 或 \\r\\n 均可匹配',
      },
      newText: {
        type: 'string',
        description:
          '替换后的新文本；regex=true 时支持 $1/$& 等捕获引用；行范围模式下为空字符串表示删除这些行；写入时换行自动适配文件主导行尾',
      },
      startLine: {
        type: 'number',
        description:
          '起始行号（从 1 开始，可选，须与 endLine 同时指定）；指定后进入整段行替换模式',
      },
      endLine: {
        type: 'number',
        description: '结束行号（包含，可选，须与 startLine 同时指定）',
      },
      replaceAll: {
        type: 'boolean',
        description: '是否替换所有匹配，默认 false（仅允许唯一匹配）',
      },
      regex: {
        type: 'boolean',
        description: '是否将 oldText 作为正则解释，默认 false（字面量匹配）',
      },
      flags: {
        type: 'string',
        description:
          '正则标志（如 "i" 忽略大小写、"m" 多行、"s" dotAll），仅 regex=true 时生效；g 会自动补充',
      },
    },
    required: ['path', 'newText'],
  },
  async execute(args, ctx?: ToolContext) {
    // 相对路径按空间根解析（D3/D20）；绝对路径原样
    const path = resolveToolPath(toolWorkspaceRoot(ctx), String(args.path));
    // 同文件写操作串行化（D4）：锁内全程「读→匹配→写」，跨会话/跨空间同物理文件互斥
    return withFileLock(path, () => executeLocked(path, args));
  },
};
