// 内容检索工具：模仿 grep，支持正则、忽略大小写、递归搜索目录
// 20261106-001：超限完整输出落临时文件 + 告知路径（方案 B：文件内治理）
import { stat, readdir, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Tool, ToolContext } from '../types.js';
import { resolveToolPath, toolWorkspaceRoot } from './workspace-fs.js';
import { createReadStream, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  buildFullOutputNotice,
  summarizeParam,
  buildTmpFilePath,
} from './output-governor.js';

/** 跳过这些目录，避免递归过深或读取依赖 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

/** 二进制探测字节数（与 fileRead 口径一致：前 N 字节含 NUL 视为二进制跳过） */
const BINARY_SNIFF_BYTES = 8000;

/** 匹配条数硬上限：达到即提前停止扫描，防止匹配风暴撑爆 matches 数组与落盘文件 */
const HARD_MATCH_CAP = 2000;

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
    /** 本次扫描的匹配条数上限：用户调大 maxResults 时跟随放大 */
    const matchCap = Math.max(HARD_MATCH_CAP, maxResults);
    /** 达 matchCap 提前停止标记（目录遍历与输出文案共用） */
    let stoppedEarly = false;

    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    const matches: string[] = [];

    async function searchFile(filePath: string): Promise<void> {
      // 二进制嗅探：前 N 字节含 NUL 视为二进制，直接跳过（与 fileRead 口径一致）
      try {
        const fh = await open(filePath, 'r');
        try {
          const sniff = Buffer.alloc(BINARY_SNIFF_BYTES);
          const { bytesRead } = await fh.read(sniff, 0, BINARY_SNIFF_BYTES, 0);
          // 注意按 bytesRead 切片：alloc 零填充，小文件的尾部空洞会被误判为 NUL
          if (sniff.subarray(0, bytesRead).includes(0)) return;
        } finally {
          await fh.close();
        }
      } catch {
        return; // 打不开的文件本就跳过
      }

      // 流式按行扫描：内存只驻留当前行，大文件（GB 级日志）不再整读入内存
      let lineNo = 0;
      const stream = createReadStream(filePath, { encoding: 'utf-8' });
      try {
        const rl = createInterface({
          input: stream,
          crlfDelay: Infinity, // \r\n 视为一个换行（顺带剥离行尾 \r，$ 锚点行为与 grep 一致）
        });
        for await (const line of rl) {
          lineNo++;
          // 用 exec 取匹配位置（regex 无 g 标志，lastIndex 不会被污染），
          // 供超长行围绕命中点截取窗口
          const m = regex.exec(line);
          if (m) {
            matches.push(
              `${filePath}:${lineNo}: ${clipMatchLine(line, m.index, m[0].length)}`,
            );
            // 匹配风暴防护：达硬上限提前停止，matches 数组与落盘文件不无界增长
            if (matches.length >= matchCap) {
              stoppedEarly = true;
              break;
            }
          }
        }
      } catch {
        // 无权限或读取中断的文件跳过（已收集的匹配保留）
      } finally {
        stream.destroy(); // break 提前退出时确保底层 fd 释放（已结束则为 no-op）
      }
    }

    async function searchDir(dirPath: string, depth = 0): Promise<void> {
      // 防止过深递归（保持硬限制，不随 matches.length 放宽）
      if (depth > 5 || stoppedEarly) return;
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        // 匹配条数达硬上限：停止继续遍历
        if (stoppedEarly) return;
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
        // 提前停止时落盘文件只含已收集部分，必须如实声明不完整
        const suggestion = stoppedEarly
          ? `建议: 匹配达 ${matchCap} 条上限扫描已提前停止，落盘结果非完整；请用更精确的正则缩小范围后重试`
          : `建议: 完整匹配已保存，可按需用 fileRead 分段读取或再次用 grep 加更精确的正则缩小范围`;
        pathHint = buildFullOutputNotice({
          path: fullPath,
          bytes,
          lines: matches.length,
          complete: !stoppedEarly,
          ...(stoppedEarly
            ? { incompleteReason: `匹配达 ${matchCap} 条上限，扫描提前停止` }
            : {}),
          suggestion,
        });
      } catch {
        // 落盘失败：降级为截断提示
      }
      const fallback = stoppedEarly
        ? `\n\n[匹配达 ${matchCap} 条上限，扫描提前停止（结果非完整），请用更精确的正则缩小范围]`
        : `\n\n[完整匹配 ${matches.length} 条因超限未返回，请缩小搜索范围或用 grep 加更精确正则]`;
      const suffix = pathHint || fallback;
      return `找到 ${matches.length} 处匹配（已达上限 ${maxResults}）:\n${head.join('\n')}${suffix}`;
    }

    return `找到 ${matches.length} 处匹配:\n${matches.join('\n')}`;
  },
};
