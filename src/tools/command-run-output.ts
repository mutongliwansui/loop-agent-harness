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

/** 去掉尾部不完整的多字节字符（缓冲区末尾截断） */
function trimIncompleteTail(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && buf[i] >= 0x80 && buf[i] < 0xc0) {
    i--;
    cont++;
  }
  if (i < 0) return buf;
  const lead = buf[i];
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return cont + 1 >= need ? buf : buf.subarray(0, i);
}

/** 单侧解码容错：截断点可能落在多字节 UTF-8 字符中间 */
function decode(buf: Buffer, side: 'head' | 'tail'): string {
  if (side === 'tail') {
    // 尾部开头可能从续字节开始：跳到下一个字符起始字节
    let i = 0;
    while (i < buf.length && buf[i] >= 0x80 && buf[i] < 0xc0) i++;
    buf = buf.subarray(i);
  } else {
    buf = trimIncompleteTail(buf);
  }
  return buf.toString('utf8');
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
