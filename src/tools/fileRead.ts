// 文件读取工具：支持全文读取或按行范围部分读取
import { readFile } from 'node:fs/promises';
import type { Tool } from '../types.js';

export const fileRead: Tool = {
  name: 'fileRead',
  description:
    '读取文件内容，支持全文读取或按行范围部分读取。默认在每行前加 "行号: " 前缀以便定位与引用；如需原始内容（如读-改-写）可设置 lineNumbers=false。当文件较大时建议用 startLine/endLine 分段读取。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径或相对路径' },
      startLine: {
        type: 'number',
        description: '起始行号（从 1 开始，可选）。不传则读全文',
      },
      endLine: {
        type: 'number',
        description: '结束行号（包含，可选）。需与 startLine 一起使用',
      },
      encoding: { type: 'string', description: '编码，默认 utf-8' },
      lineNumbers: {
        type: 'boolean',
        description: '是否在每行前加 "行号: " 前缀，默认 true；设为 false 返回原始内容',
      },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path);
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
    const content = await readFile(path, encoding);
    const lines = content.split('\n');

    const startLine = args.startLine != null ? Number(args.startLine) : null;
    const endLine = args.endLine != null ? Number(args.endLine) : null;
    const lineNumbers = args.lineNumbers !== false; // 默认 true

    // 全文读取
    if (startLine === null && endLine === null) {
      return lineNumbers ? withLineNumbers(lines, 1) : content;
    }

    // 部分读取：startLine 与 endLine 必须同时指定
    if (startLine === null || endLine === null) {
      throw new Error('startLine 与 endLine 必须同时指定，或都不指定');
    }
    if (startLine < 1 || endLine < startLine) {
      throw new Error('行号非法：startLine >= 1 且 endLine >= startLine');
    }

    const sliced = lines.slice(startLine - 1, endLine);
    const body = lineNumbers ? withLineNumbers(sliced, startLine) : sliced.join('\n');
    return `文件 ${path} 第 ${startLine}-${endLine} 行（共 ${lines.length} 行）:\n${body}`;
  },
};

/**
 * 为行数组添加 "行号: 内容" 前缀
 * @param lines 行数组
 * @param startNumber 首行对应的真实行号（从 1 开始）
 */
function withLineNumbers(lines: string[], startNumber: number): string {
  return lines.map((line, i) => `${startNumber + i}: ${line}`).join('\n');
}
