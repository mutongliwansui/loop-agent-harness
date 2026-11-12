// 前台命令输出头尾累积器（需求 20261104-006 D1/D2）
//
// 目的：替换 exec 的 maxBuffer 语义——无论输出多大都不失败，只保留「头 + 尾」，
// 中间省略并标注省略字节数，既保住命令开头的关键报错，也留住最终失败原因。
// 零新依赖：仅 node:buffer（全局 Buffer）。

/** 累积结果：text 已含省略标记；omittedBytes 为被丢弃的中段字节数 */
export interface AccumulatedOutput {
  text: string;
  omittedBytes: number;
  totalBytes: number;
}

/** 开头连续 UTF-8 续字节数（0-3；缓冲区可能从字符中间开始） */
function leadingContinuationLen(buf: Buffer): number {
  let i = 0;
  while (i < buf.length && i < 3 && buf[i] >= 0x80 && buf[i] < 0xc0) i++;
  return i;
}

/** 末尾不完整的 UTF-8 序列字节数（0 = 末尾完整，或末尾不是多字节序列的开头） */
function incompleteUtf8TailLen(buf: Buffer): number {
  let i = buf.length - 1;
  while (i >= 0 && buf[i] >= 0x80 && buf[i] < 0xc0) i--;
  if (i < 0) return 0;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need === 1) return 0;
  const have = buf.length - i;
  return have < need ? have : 0;
}

/**
 * 严格 UTF-8 解码；只裁掉「确实残缺」的边界字节（开头续字节 / 末尾不完整序列）。
 *
 * 不能盲目尝试任意缩短：GBK 字节有时恰好是合法 UTF-8，
 * 乱裁会把它误判成 UTF-8 并解出乱码（实测 d6d0cec4… 裁 2 字节后即为合法 UTF-8）。
 * 判定不出 UTF-8 时返回 null，由调用方改用 GBK。
 */
function tryDecodeUtf8(buf: Buffer, trimStart: boolean, trimEnd: boolean): string | null {
  const start = trimStart ? leadingContinuationLen(buf) : 0;
  const end = buf.length - (trimEnd ? incompleteUtf8TailLen(buf) : 0);
  if (start >= end) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start, end));
  } catch {
    return null;
  }
}

/**
 * 字节 → 文本（跨平台编码探测）。
 *
 * 背景：Windows 中文环境下 cmd / PowerShell 5.1 的输出是 GBK(cp936)，
 * 直接按 UTF-8 解码会把中文变成 `�`（模型与界面都只看到替换符，等同输出被吞）。
 *
 * 策略：先按严格 UTF-8 解码；失败则按 GBK 解码。
 * - 纯 ASCII 在两种编码下一致，不会误判；
 * - GBK 解码依赖 ICU（Node 官方构建自带），不可用时退回宽松 UTF-8，保持旧行为；
 * - 只影响「进上下文 / 界面展示」的文本，完整输出落盘仍写原始字节。
 */
export function decodeBytes(
  buf: Buffer,
  edges: { start?: boolean; end?: boolean } = {},
): string {
  if (buf.length === 0) return '';
  const utf8 = tryDecodeUtf8(buf, edges.start === true, edges.end === true);
  if (utf8 !== null) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 解码任意字节区间（后台日志增量读）：两端都可能落在字符中间 */
export function decodeByteRange(buf: Buffer): string {
  return decodeBytes(buf, { start: true, end: true });
}

/** 单侧解码：head 可能末尾截断，tail 可能开头截断 */
function decode(buf: Buffer, side: 'head' | 'tail'): string {
  return decodeBytes(buf, side === 'tail' ? { start: true } : { end: true });
}

/**
 * 头尾配额累积器（D2）：
 * - 先填满 headBytes（保留命令开头）
 * - 之后的字节进入 tail 环形区，累计超过 tailBytes 时从最旧块丢弃
 * - 被丢弃的字节累计到 omittedBytes，渲染时输出「…(省略 N 字节)…」
 *
 * 持续消费 stdout/stderr 是必须的（D1 已知坑）：即使超限也要继续 push（丢弃），
 * 否则管道背压会让子进程阻塞。
 */
export class OutputAccumulator {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private total = 0;

  constructor(
    private readonly headBytes = 128 * 1024,
    private readonly tailBytes = 128 * 1024,
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    let rest = chunk;

    if (this.headLen < this.headBytes) {
      const take = Math.min(this.headBytes - this.headLen, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;

    this.tail.push(rest);
    this.tailLen += rest.length;
    // 超配额时从最旧块删除；单块过大时按字节裁剪
    while (this.tailLen > this.tailBytes && this.tail.length > 0) {
      const first = this.tail[0];
      const over = this.tailLen - this.tailBytes;
      if (first.length <= over) {
        this.tail.shift();
        this.tailLen -= first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailLen -= over;
      }
    }
  }

  render(): AccumulatedOutput {
    const headText = decode(Buffer.concat(this.head), 'head');
    const tailText = decode(Buffer.concat(this.tail), 'tail');
    const omittedBytes = this.total - this.headLen - this.tailLen;
    let text = headText;
    if (omittedBytes > 0) {
      text += `\n…(省略 ${omittedBytes} 字节)…\n${tailText}`;
    } else {
      text += tailText;
    }
    return { text, omittedBytes, totalBytes: this.total };
  }
}

/** 前台输出配置（需求 20261104-006 D7；init 由 config.tools.commandRun 注入） */
export interface CommandRunOutputOptions {
  /** 输出总上限（KB），头尾各占一半 */
  outputLimitKb: number;
  /** 默认超时毫秒（仅前台模式） */
  timeoutMs: number;
}

let options: CommandRunOutputOptions = { outputLimitKb: 256, timeoutMs: 30000 };

export function configureCommandRunOutput(opts: Partial<CommandRunOutputOptions>): void {
  options = {
    outputLimitKb: Math.max(1, opts.outputLimitKb ?? options.outputLimitKb),
    timeoutMs: Math.max(1, opts.timeoutMs ?? options.timeoutMs),
  };
}

export function commandRunOutputOptions(): CommandRunOutputOptions {
  return { ...options };
}

/** 按总上限换算单侧配额（上下限保护：单侧 1KB..64MB） */
export function outputQuotas(outputLimitKb: number): { headBytes: number; tailBytes: number } {
  const totalBytes = Math.min(64 * 1024 * 1024, Math.max(2 * 1024, outputLimitKb * 1024));
  const half = Math.floor(totalBytes / 2);
  return { headBytes: half, tailBytes: half };
}
