// 内容检索工具：模仿 grep，支持正则、忽略大小写、递归搜索目录
import { readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';

/** 跳过这些目录，避免递归过深或读取依赖 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

export const grep: Tool = {
  name: 'grep',
  description:
    '在文件或目录中检索内容（模仿 grep）。支持正则表达式、忽略大小写、递归搜索目录。返回 "path:line: content" 格式的匹配列表。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '文件或目录路径' },
      ignoreCase: {
        type: 'boolean',
        description: '是否忽略大小写，默认 false',
      },
      recursive: {
        type: 'boolean',
        description: '是否递归搜索目录（仅 path 为目录时生效），默认 true',
      },
      maxResults: {
        type: 'number',
        description: '最大返回匹配数，默认 50',
      },
    },
    required: ['pattern', 'path'],
  },
  async execute(args, ctx?: ToolContext) {
    const pattern = String(args.pattern);
    // 相对路径按空间根解析（D3/D20）：递归起点跟随空间，不再依赖隐式 process.cwd()
    const path = resolveToolPath(toolWorkspaceRoot(ctx), String(args.path));
    const ignoreCase = args.ignoreCase === true; // 默认 false
    const recursive = args.recursive !== false; // 默认 true
    const maxResults = Number(args.maxResults ?? 50);

    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    const matches: string[] = [];

    async function searchFile(filePath: string): Promise<void> {
      if (matches.length >= maxResults) return;
      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${filePath}:${i + 1}: ${lines[i]}`);
            if (matches.length >= maxResults) return;
          }
        }
      } catch {
        // 二进制或无权限文件跳过
      }
    }

    async function searchDir(dirPath: string, depth = 0): Promise<void> {
      // 防止过深递归
      if (depth > 5 || matches.length >= maxResults) return;
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        // 跳过敏感目录
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dirPath, entry.name);
        if (entry.isDirectory() && recursive) {
          await searchDir(full, depth + 1);
        } else if (entry.isFile()) {
          await searchFile(full);
        }
      }
    }

    const info = await stat(path);
    if (info.isDirectory()) {
      await searchDir(path);
    } else {
      await searchFile(path);
    }

    if (matches.length === 0) {
      return `未在 ${path} 中找到匹配 /${pattern}/ 的内容`;
    }
    const truncated = matches.length >= maxResults ? '（已达上限）' : '';
    return `找到 ${matches.length} 处匹配${truncated}:\n${matches.join('\n')}`;
  },
};
