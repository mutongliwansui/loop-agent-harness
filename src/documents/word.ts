// Word 文本提取（需求 20261112-001 / 任务 01；需求 20261112-005 修复挂起）
//
// .docx → 本项目零依赖 zip 解析（documents/docx.ts），不再经过 yauzl 流式管道；
// .doc  → 复用 word-extractor@1.x 的 OLE 解析（OLE 路径不走 zip 流，无挂起风险）。
//
// 兜底超时：任何第三方解析器都可能「Promise 永不 settle」，一旦发生，工具层的时间预算
// 只能告警无法中断（pending 的 Promise 不会自行释放，进程内句柄也不回收）。故此处对所有
// 非同步路径加硬超时，到点抛 DocumentExtractError('timeout')，保证调用方总能拿到结果。

import { open } from 'node:fs/promises';
import WordExtractor from 'word-extractor';
import { DocumentExtractError } from './types.js';
import { extractDocxBody } from './docx.js';

/** ZIP 本地文件头魔数（docx 及其它 OOXML 容器） */
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 第三方解析器硬超时（毫秒）：远小于 runner 默认 30s 工具超时，保证超时前返回 */
export const WORD_PARSE_TIMEOUT_MS = 15_000;

/**
 * 给 Promise 套硬超时：到点以 DocumentExtractError('timeout') 失败。
 * 底层 Promise 无法真正取消（第三方实现不接 signal），但调用方不会继续被拖住。
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  // 小于 1s 时用毫秒，避免出现「超过 0s」这种读不懂的提示
  const human = ms >= 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new DocumentExtractError('timeout', `${label}解析超过 ${human} 未返回，已中止等待`),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 前 4 字节是否为 ZIP 容器（docx 实为 zip；.doc 为 OLE 复合文档） */
async function isZipContainer(absPath: string): Promise<boolean> {
  const fh = await open(absPath, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    return bytesRead === 4 && head.equals(ZIP_SIGNATURE);
  } finally {
    await fh.close();
  }
}

/**
 * 提取 Word 正文文本（doc/docx 自适应，按文件头魔数分派）。
 *
 * - docx（ZIP 容器）：零依赖解包 + 标签扫描，同步完成，不存在挂起；
 * - 其余（.doc OLE 等）：word-extractor，带硬超时。
 *
 * 失败时抛出底层错误或 DocumentExtractError('timeout')，由 extract.ts 统一映射。
 */
export async function extractWordBody(absPath: string): Promise<string> {
  if (await isZipContainer(absPath)) {
    return extractDocxBody(absPath);
  }
  return withTimeout(
    new WordExtractor().extract(absPath).then((doc) => doc.getBody()),
    WORD_PARSE_TIMEOUT_MS,
    'Word 文档',
  );
}
