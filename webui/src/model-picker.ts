/**
 * 会话级模型选择器的纯逻辑（task-20261025-002 D8/D9）
 *
 * 与 Vue 解耦，便于单测：把 `GET /models` 的原始响应整理成面板行，
 * 并把「当前选择」解析成 pill 的展示状态。
 */

/** `GET /models` 单条 profile（apiKey 已被服务端遮蔽） */
export interface ModelProfileRow {
  alias: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  temperature?: number;
  isCurrent?: boolean;
}

/** 面板行（已补齐 host 与「是否全局」标记） */
export interface PickerRow {
  alias: string;
  name: string;
  /** baseUrl 中的主机名，用于区分同名模型的不同供应商 */
  host: string;
  isCurrent: boolean;
  /** 是否为全局激活项（唯一） */
  isGlobal: boolean;
  /** 是否为当前会话所选 */
  isSelected: boolean;
}

/** pill 的展示状态 */
export interface PillState {
  /** 展示文案（alias 优先，缺失时回落 '模型'） */
  label: string;
  /** 是否为「覆盖全局」状态（决定是否转品牌色、是否露出「跟随全局」） */
  pinned: boolean;
  /** 是否显示「跟随全局」复位入口 */
  showFollowGlobal: boolean;
}

/** 从 baseUrl 提取主机名；解析失败时原样返回，避免整行不可读 */
export function hostOf(baseUrl: string): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  }
}

/**
 * 构建面板行：按 alias 排序，标记全局激活项与当前会话所选项。
 *
 * @param profiles `GET /models` 返回的 profiles
 * @param activeAlias 全局激活别名（`active` 字段，可为 null）
 * @param selectedAlias 当前会话所选（未选则 undefined → 视为跟随全局）
 */
export function buildPickerRows(
  profiles: ModelProfileRow[],
  activeAlias: string | null | undefined,
  selectedAlias?: string | null,
): PickerRow[] {
  const active = activeAlias ?? '';
  const selected = selectedAlias ?? '';
  return [...profiles]
    .sort((a, b) => a.alias.localeCompare(b.alias))
    .map((p) => ({
      alias: p.alias,
      name: p.name,
      host: hostOf(p.baseUrl),
      // isCurrent 以 activeAlias 为准（服务端字段与 active 理应一致，这里以显式入参兜底）
      isCurrent: active ? p.alias === active : p.isCurrent === true,
      isGlobal: active ? p.alias === active : false,
      isSelected: selected ? p.alias === selected : false,
    }));
}

/**
 * 解析 pill 状态。
 *
 * - 未选（selected 为空）→ 跟随全局：label 取全局 alias，pinned=false；
 * - 选中全局项本身 → 同样视为跟随全局（不让「选了当前项」出现假的覆盖态）；
 * - 选中其它项 → pinned=true，露出「跟随全局」复位。
 */
export function resolvePill(
  selected: string | null | undefined,
  activeAlias: string | null | undefined,
): PillState {
  const sel = (selected ?? '').trim();
  const active = (activeAlias ?? '').trim();
  const pinned = sel !== '' && sel !== active;
  const label = (pinned ? sel : active) || '模型';
  return { label, pinned, showFollowGlobal: pinned };
}
