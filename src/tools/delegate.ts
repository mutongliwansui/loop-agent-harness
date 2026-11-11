// 子 Agent 委托工具（需求 20261107-001）
// 主 Agent 通过本工具把自包含子任务交给独立子 Agent 执行：
// - 独立消息历史（不污染主对话）
// - 共享 L2/L3 记忆（子任务拥有项目背景与用户偏好）
// - 独立 L1 工作记忆（子任务上下文不进入主 Agent 压缩窗口）
// - 工具集排除 delegate（防无限递归，见 ReActAgent.run 的 excludeTools）
// 执行器由 ReActAgent.run() 通过 ToolContext.runSubAgent 注入；未注入时降级报错。
import type { Tool, ToolContext } from '../types.js';

export const delegate: Tool = {
  name: 'delegate',
  // 子 Agent 可能跑完整的多步 ReAct 链（含工具调用），远超普通工具默认 30s；
  // 超时后主 Agent 放弃等待（子 Agent Promise 仍会自然结束，结果被丢弃）。
  timeoutMs: 600000,
  description:
    '把「自包含、可独立完成」的子任务委托给独立子 Agent 执行，返回其最终结论。' +
    '子 Agent 看不到当前对话（task 须写全，可用 context 补背景），拥有独立上下文与完整工具能力（共享项目记忆），且不能再委托。' +
    '多个互不相干的任务可设 background=true 并行后台执行（立即返回 taskId，结果完成后投递回会话）。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '子任务描述：必须自包含、可独立执行，含明确的产出要求',
      },
      context: {
        type: 'string',
        description: '补充背景（子 Agent 看不到当前对话，必要时把相关约束/结论写这里）',
      },
      background: {
        type: 'boolean',
        description: '后台并行执行（默认 false 同步等待结论）；仅在确有互不相干任务时使用',
      },
    },
    required: ['task'],
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) return '错误：delegate 需要非空的 task 参数';
    if (!ctx?.runSubAgent) {
      return '错误：当前环境不支持子 Agent 委托（未注入 runSubAgent 执行器）';
    }
    const context = typeof args.context === 'string' && args.context.trim()
      ? args.context.trim()
      : undefined;
    const background = args.background === true;
    const result = await ctx.runSubAgent(task, {
      context,
      background,
      callId: ctx.callId,
    });
    return result.answer;
  },
};
