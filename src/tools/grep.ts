// 内容检索工具：模仿 grep，支持正则、忽略大小写、递归搜索目录
// 20261106-001：超限完整输出落临时文件 + 告知路径（方案 B：文件内治理）
import { readFile, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  buildFullOutputNotice,
  summarizeParam,
  buildTmpFilePath,
} from './output-governor.js';

/** 跳过这些目录，避免递归过深或读取依赖 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** 匹配行展示窗口半径：超长行（如 minified 单行）只保留匹配点前后各这么多字符 */
const SPAN_RADIUS = 500;
/** 行长度超过该值才触发窗口截取（短行原样返回，保持输出干净） */
const MAX_MATCH_LINE_CHARS = 2 * SPAN_RADIUS + 200;

/**
 * 围绕正则匹配位置截取超长行：保留匹配点前后各 SPAN_RADIUS 字符，
 * 两端标注被省略的字符数，保证 minified 单行不会原样进入上下文打爆 token，
 * 同时让 LLM 始终能看到命中处的局部上下文。
 */
function clipMatchLine(line: string, matchIndex: number, matchLength: number): string {
  if (line.length <= MAX_MATCH_LINE_CHARS) return line;
  const center = matchIndex + Math.floor(matchLength / 2);
  const start = Math.max(0, center - SPAN_RADIUS);
  const end = Math.min(line.length, center + SPAN_RADIUS);
  const prefix = start > 0 ? `… [省略前 ${start} 字符] ` : '';
  const suffix =
    end < line.length
      ? ` … [省略后 ${line.length - end} 字符，该行共 ${line.length} 字符]`
      : ` [该行共 ${line.length} 字符]`;
  return prefix + line.slice(start, end) + suffix;
}

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
      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          // 用 exec 取匹配位置（regex 无 g 标志，lastIndex 不会被污染），
          // 供超长行围绕命中点截取窗口
          const m = regex.exec(lines[i]);
          if (m) {
            matches.push(
              `${filePath}:${i + 1}: ${clipMatchLine(lines[i], m.index, m[0].length)}`,
            );
          }
        }
      } catch {
        // 二进制或无权限文件跳过
      }
    }

    async function searchDir(dirPath: string, depth = 0): Promise<void> {
      // 防止过深递归（保持硬限制，不随 matches.length 放宽）
      if (depth > 5) return;
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
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

    // 20261106-001：超限治理
    if (matches.length > maxResults) {
      const head = matches.slice(0, maxResults);
      const totalText = matches.join('\n');
      const bytes = Buffer.byteLength(totalText, 'utf-8');
      let pathHint = '';
      try {
        const fullPath = buildTmpFilePath(ctx?.sessionId, 'grep', summarizeParam(args, 'grep'));
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, totalText, 'utf-8');
        const suggestion = `建议: 完整匹配已保存，可按需用 fileRead 分段读取或再次用 grep 加更精确的正则缩小范围`;
        pathHint = buildFullOutputNotice({
          path: fullPath,
          bytes,
          lines: matches.length,
          suggestion,
        });
      } catch {
        // 落盘失败：降级为截断提示
      }
      const suffix = pathHint || `\n\n[完整匹配 ${matches.length} 条因超限未返回，请缩小搜索范围或用 grep 加更精确正则]`;
      return `找到 ${matches.length} 处匹配（已达上限 ${maxResults}）:\n${head.join('\n')}${suffix}`;
    }

    return `找到 ${matches.length} 处匹配:\n${matches.join('\n')}`;
  },
};
