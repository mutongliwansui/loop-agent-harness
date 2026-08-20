// 输出抽象层
// 命令处理器的输出通过 OutputChannel 接口抽象，CLI 和 Web 各实现一个

/**
 * 命令处理器的输出通道
 * - CLI 场景：ConsoleOutputChannel（带 ANSI 彩色输出）
 * - Web 场景：JsonOutputChannel（收集数据返回 JSON，由 Web 入口实现）
 */
export interface OutputChannel {
  /** 常规输出（替代 console.log） */
  log(message: string): void;
  /** 错误输出（代替 console.error） */
  error(message: string): void;
  /** 结构化数据输出（列表/表格等，Web 可直接序列化为 JSON） */
  data(data: unknown): void;
  /** 空行（CLI 输出换行，Web 可忽略） */
  blank(): void;
}

/**
 * 控制台输出实现（CLI 默认）
 * 彩色输出到 process.stdout / process.stderr
 */
export class ConsoleOutputChannel implements OutputChannel {
  log(message: string): void {
    console.log(message);
  }
  error(message: string): void {
    console.error(message);
  }
  blank(): void {
    console.log('');
  }
  data(data: unknown): void {
    if (typeof data === 'string') {
      console.log(data);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
  }
}
