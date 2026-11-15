/**
 * 工具行为声明与展示元信息。
 *
 * ## 为什么照搬 MCP 的 `ToolAnnotations`
 *
 * 这是目前已有的事实标准（MCP 2025-03-26 起进入规范），四个 hint 语义清晰
 * 且互不重叠。自造一套「只读 / 危险 / 幂等」字段只会与生态对不上，
 * 将来桥接 MCP server 时还得翻译。
 *
 * ## 默认值取「悲观」口径（重要）
 *
 * MCP 规范给的是 `readOnlyHint=false`、`destructiveHint=true`、
 * `idempotentHint=false`、`openWorldHint=true`——即「什么都不声明 =
 * 可能写、可能破坏、可能不幂等、可能触网」。沿用该默认意味着**未声明的
 * 第三方工具天然按最保守对待**，宿主将来接确认门禁时不会因缺省字段误放行。
 *
 * ## annotations 不是权限
 *
 * MCP 规范明示这些字段是 **hint**，不保证忠实描述行为，客户端不得据此做
 * 安全决策。本包只声明、不强制；权限门禁由宿主实现。
 */

/** 工具行为声明（对齐 MCP `ToolAnnotations`） */
export interface ToolAnnotations {
  /** 人类可读标题（MCP 规定可与 `display.label` 并存，前者更通用） */
  title?: string;
  /** 不修改环境（纯读）。**默认 false** */
  readOnlyHint?: boolean;
  /** 修改是破坏性（删除 / 覆盖）而非追加。**默认 true**，仅在 `readOnlyHint=false` 时有意义 */
  destructiveHint?: boolean;
  /** 同参数重复调用无额外影响。**默认 false**，仅在 `readOnlyHint=false` 时有意义 */
  idempotentHint?: boolean;
  /** 触及开放世界（网络 / 外部系统）。**默认 true** */
  openWorldHint?: boolean;
}

/**
 * 展示元信息。
 *
 * 现状 `webui/src/tool-meta.ts` 把 12 个工具的中文名 / 图标 / 参数标签硬编码
 * 在前端，导致「新增工具必须改前端」。把展示信息作为**可选**字段随契约声明，
 * 将来可由后端下发给前端，前端只保留兜底表。**本期不接入**，只留字段位。
 */
export interface ToolDisplay {
  /** 中文展示名（WebUI 卡片标题） */
  label?: string;
  /** 图标 key（WebUI 线性 SVG 体系） */
  icon?: string;
  /** 参数英文名 → 中文标签 */
  paramLabels?: Record<string, string>;
}

/**
 * 悲观默认值（与 MCP 规范一致）。
 *
 * 用常量而非散落的 `??` 表达式：默认口径是**契约的一部分**，
 * 集中一处才能被单测锁住、被 README 引用。
 */
export const DEFAULT_TOOL_ANNOTATIONS: Required<Omit<ToolAnnotations, 'title'>> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * 补全缺省值：只填未声明的字段，**不覆盖**已声明的 `false`。
 *
 * 注意不能用 `{ ...DEFAULT, ...input }` 之外的花招——`input` 里显式的
 * `undefined` 也应视为「未声明」，故逐字段用 `??`。
 */
export function resolveAnnotations(
  input?: ToolAnnotations,
): Required<Omit<ToolAnnotations, 'title'>> & Pick<ToolAnnotations, 'title'> {
  return {
    ...(input?.title !== undefined ? { title: input.title } : {}),
    readOnlyHint: input?.readOnlyHint ?? DEFAULT_TOOL_ANNOTATIONS.readOnlyHint,
    destructiveHint: input?.destructiveHint ?? DEFAULT_TOOL_ANNOTATIONS.destructiveHint,
    idempotentHint: input?.idempotentHint ?? DEFAULT_TOOL_ANNOTATIONS.idempotentHint,
    openWorldHint: input?.openWorldHint ?? DEFAULT_TOOL_ANNOTATIONS.openWorldHint,
  };
}
