/** 壳启动期可预期的失败，统一转成用户可读文案（D1-x 错误分支） */
export interface UserFacingError {
  /** 标题：一句话说明发生了什么 */
  title: string;
  /** 详情：补充原因与已尝试的动作 */
  detail: string;
  /** 日志尾部（可选，便于直接看到后端报错） */
  tail?: string;
}

/** 把任意错误转成用户可读结构，避免把堆栈甩给非技术用户 */
export function toUserFacing(err: unknown): UserFacingError {
  if (err && typeof err === 'object' && 'name' in err) {
    const e = err as {
      name: string;
      message?: string;
      searched?: string[];
      tried?: number[];
      tail?: string;
      backendExited?: boolean;
    };

    switch (e.name) {
      case 'BackendNotFoundError':
        return {
          title: '未找到后端程序',
          detail: [
            '没有在预期位置找到后端程序，请确认安装完整或重新安装 LoopAgent。',
            '',
            '已查找以下位置：',
            ...(e.searched ?? []).map((p) => `  · ${p}`),
          ].join('\n'),
        };

      case 'PortUnavailableError':
        return {
          title: '端口全部被占用',
          detail: [
            '以下端口均已被其他程序占用，暂时无法启动：',
            '',
            (e.tried ?? []).join('、'),
            '',
            '请关闭占用端口的程序后重试，或在 ~/.loop-agent/config.json 里把 api.port 改成其他值。',
          ].join('\n'),
        };

      case 'HealthTimeoutError':
        return {
          title: e.backendExited ? '后端启动失败' : '后端启动超时',
          detail: e.backendExited
            ? '后端进程刚启动就退出了，没能进入就绪状态。下面是它最后的输出：'
            : `后端进程已拉起，但在规定时间内没有就绪。下面是它最后的输出：`,
          tail: e.tail,
        };

      case 'HealthMismatchError':
        return {
          title: '端口被其他程序占用',
          detail: `${e.message ?? ''}\n换一个端口后重试通常可以解决。`,
        };

      /**
       * 后端启动后意外退出（任务 03 D3-5：错误页需要给出「为什么」）。
       *
       * 与 HealthTimeoutError 分开：那条是「启动期没就绪」，措辞固定；
       * 这条是「已经在跑的后端死了」，原因（退出码/信号）必须出现在正文里，
       * 否则用户只看到一句「已意外停止」却不知道查什么。
       */
      case 'BackendExitedError':
        return {
          title: '后台服务已意外停止',
          detail: [
            `原因：${e.message ?? '未知'}`,
            '',
            '界面可能已无法使用。可以点「重试」重新启动后端；若反复失败，请点「查看日志」把日志发给维护者。',
          ].join('\n'),
          tail: e.tail,
        };

      default:
        break;
    }
  }

  // 字段可能是 undefined（如 non-Error 值），统一兜底成可读结构而非抛二次异常
  const message = err instanceof Error ? err.message : String(err);
  return {
    title: '启动失败',
    detail: message || '发生了未知错误，请查看日志后重试。',
  };
}
