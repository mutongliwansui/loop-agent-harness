// System Prompt 构造器：仅含行为指导，不重复工具列表
// 工具 schema 由 OpenAI function calling 的 tools 参数暴露，避免冗余
import type { SkillMetadata } from '../skill/types.js';

/**
 * 构造 ReAct Agent 的 System Prompt
 *
 * 设计原则（Task-06/07 重构）：
 * - 工具列表不在 prompt 中重复（由 tools 参数负责）
 * - 仅提供角色定义、工作模式、规则约束
 * - 保留工具使用指导（如 MCP 前缀说明）
 * - 注入 Skill 元信息，供 LLM 判断何时激活 Skill
 */
export function buildSystemPrompt(
  skills: SkillMetadata[] = [],
  workspaceDir?: string,
  visionEnabled?: boolean,
): string {
  // 始终注入 Skill 区块：即使没有任何技能，也要显式告知模型"当前无可用技能"，
  // 否则模型面对"有哪些技能"的提问会误判为需要去文件系统检索技能目录。
  const skillSection = skills.length > 0
    ? `\n## 可用 Skill（技能包）
当用户的需求与以下 Skill 的描述匹配时，使用 activate_skill 工具激活对应 Skill，获取详细的执行指令。
${skills.map((s) => `- **${s.name}**: ${s.description} ${s.scope === 'workspace' ? '(工作空间)' : '(全局)'}`).join('\n')}
- 以上即为当前全部可用 Skill；当用户询问「有哪些技能 / 当前有什么技能」时，请直接依据该列表回答，不要通过检索文件系统去寻找技能目录。
`
    : `\n## 可用 Skill（技能包）
当前没有可用的 Skill（技能包）。当用户询问「有哪些技能 / 当前有什么技能」时，请直接如实回答「当前没有可用的技能」，不要通过 ls / grep / commandRun 等工具去检索文件系统或技能目录。
`;

  // 环境信息：显式告知当前工作空间目录，使模型能准确回答目录相关问题、产出可靠路径
  const envSection = workspaceDir
    ? `\n\n## 环境信息
- 当前工作空间目录：${workspaceDir}
- 工具的相对路径均相对该目录解析；涉及文件位置时以该目录为基准描述路径
`
    : '';

  // 视觉能力段：仅在 vision.enabled 时注入；未启用时 prompt 保持字节级一致，保护前缀缓存
  const visionSection = visionEnabled
    ? `
## 图片理解能力
当前会话已接入视觉模型，你可以借助视觉工具理解图片：
- 你自己无法直接"看到"图片；用户消息中的图片以字符串形式出现（本地路径、http(s) URL 或 data URI），需要理解图片时把该字符串传给视觉工具
- \`ask_image\`：已明确想了解图片的某方面信息时优先使用（定向提问，输出精准、简短）
- \`describe_image\`：需要整体了解图片内容时使用（通用描述，兜底方案）
- \`extract_json\`：需要从图片中提取结构化数据（表格、字段、列表等）时使用，参数中给出 JSON schema
- \`ocr_image\`：仅需识别图片中的文字时使用（速度最快）
- 支持一次传入多张图片（数组参数）；视觉工具失败时会返回错误说明，可修正参数后重试
`
    : '';

  return `你是一个能够使用工具的 ReAct（Reasoning + Acting）Agent。通过 Thought → Action → Observation 的循环解决用户问题。

## 工作模式
1. **Thought**：分析用户问题，判断是否需要使用工具
2. **Action**：如果需要工具，调用合适的工具（可同时调用多个独立工具）
3. **Observation**：根据工具返回结果继续思考
4. 重复以上步骤，直到能给出最终答案
5. 如果不需要工具，直接回答用户问题

## 规则
- 优先使用工具获取准确信息，不要凭空臆造
- 在调用工具前，请先用自然语言简要说明你要做什么
- 工具调用失败时，尝试换一种参数或换一个工具，不要重复同样的失败调用
- 多个独立的工具调用可在同一轮发起，减少迭代次数
- 得到足够信息后，必须直接给出最终答案，不要继续调用工具
- 最终答案要用自然语言清晰回答用户问题，不要包含工具调用的原始格式

## 工具使用指导
- 工具的参数 schema 通过 function calling 协议暴露，按需调用即可
- 工具名前缀 \`{serverName}__\` 表示来自 MCP server 的工具，可正常使用${visionSection}${skillSection}${envSection}`;
}
