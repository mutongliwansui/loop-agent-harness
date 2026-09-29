// 文件编辑工具：默认按字面文本替换（唯一匹配才替换，防止误改），可选正则模式；支持按行范围整段替换
import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from '../types.js';

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

export const editFile: Tool = {
  name: 'editFile',
  description:
    '在已有文件中替换内容，支持三种用法：①默认按字面量精确匹配替换 oldText（要求唯一出现，多处匹配会报错以避免误改，可用 replaceAll=true 替换全部）；②regex=true 时 oldText 按正则解释（flags 指定 i/m/s 等，g 自动补充），newText 支持 $1/$& 捕获引用；③指定 startLine/endLine 时进入“整段行替换”，把第 startLine-endLine 行整体替换为 newText（oldText 可选，提供则用作校验）。文件必须已存在（新建文件请用 fileWrite）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      oldText: {
        type: 'string',
        description:
          '要被替换的原文本（未指定行范围时必填）；regex=true 时为正则表达式',
      },
      newText: {
        type: 'string',
        description:
          '替换后的新文本；regex=true 时支持 $1/$& 等捕获引用；行范围模式下为空字符串表示删除这些行',
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
  async execute(args) {
    const path = String(args.path);
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

      // oldText 提供时用作安全校验，防止行号偏移改错位置
      if (oldText.length > 0) {
        const hit = useRegex
          ? toRegex(oldText, flags).re.test(sliceText)
          : sliceText.includes(oldText);
        if (!hit) {
          throw new Error(
            `第 ${startLine}-${endLine} 行内容与 oldText 不匹配，已中止（可用于防止行号偏移改错位置）`,
          );
        }
      }

      const replacementLines = newText.length === 0 ? [] : newText.split('\n');
      const updatedLines = [
        ...lines.slice(0, startLine - 1),
        ...replacementLines,
        ...lines.slice(endLine),
      ];
      await writeFile(path, updatedLines.join('\n'), 'utf-8');

      return `已编辑 ${path}（整段替换第 ${startLine}-${endLine} 行：${endLine - startLine + 1} 行 → ${replacementLines.length} 行）`;
    }

    // 以下为全文件范围替换
    if (oldText.length === 0) {
      throw new Error('oldText 不能为空（未指定 startLine/endLine 时必填）');
    }

    // 正则模式：支持 flags 与 $ 捕获引用
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

      const updated = content.replace(re, newText);
      await writeFile(path, updated, 'utf-8');

      const replaced = replaceAll ? count : 1;
      return `已编辑 ${path}（正则替换 ${replaced} 处，flags: ${effectiveFlags}）`;
    }

    // 字面量模式（默认）
    const count = content.split(oldText).length - 1;

    if (count === 0) {
      throw new Error(`未在 ${path} 中找到要替换的文本`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(
        `oldText 在 ${path} 中出现 ${count} 处，为避免误改已中止。请补充更长的上下文使其唯一，或设置 replaceAll=true 替换全部`,
      );
    }

    // 用 split/join 而非 replace：字面量替换，避免 newText 中的 $ 等字符被当作替换模式解释
    const updated = content.split(oldText).join(newText);
    await writeFile(path, updated, 'utf-8');

    const replaced = replaceAll ? count : 1;
    return `已编辑 ${path}（替换 ${replaced} 处，${oldText.length} → ${newText.length} 字符）`;
  },
};
