// 技能页纯逻辑（原型-20261109-001 D1/D4/D8）
// 仅放可单测的纯函数：搜索过滤、排序、关键字高亮分段、zip 前置校验。
// 需求 20261112-008：skill 只剩全局一份，来源筛选/来源文案相关函数已移除。
// 视图层（SkillsView.vue）只负责渲染与 API 调用，不重复实现这些规则。

export interface SkillRow {
  name: string;
  description: string;
  scope: string;
  path: string;
}

export type SortMode = 'name';

/** 上传 zip 包大小上限（与后端 UPLOAD_MAX_TOTAL_BYTES 一致） */
export const UPLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** 唯一安装位置（全局；展示用） */
export const SKILLS_INSTALL_DIR = '~/.loop-agent/skills/';

/** 卡片渐变图标文字：取前两个词首字母，单词名取前两位；空名返回 ? */
export function skillInitials(name: string): string {
  const tokens = name.trim().split(/[^0-9A-Za-z\u4e00-\u9fa5]+/).filter(Boolean);
  if (tokens.length === 0) return '?';
  if (tokens.length >= 2) return (tokens[0][0] + tokens[1][0]).toUpperCase();
  return tokens[0].slice(0, 2).toUpperCase();
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 名称 / 描述 / 路径三字段不区分大小写匹配；空查询恒为真 */
export function matchSkill(s: SkillRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.name, s.description, s.path].some((v) => v.toLowerCase().includes(q));
}

/** 关键字过滤（顺序保持入参顺序，排序由 sortSkills 负责） */
export function filterSkills(rows: SkillRow[], query: string): SkillRow[] {
  return rows.filter((r) => matchSkill(r, query));
}

/** name：按名称 A→Z（localeCompare 稳定） */
export function sortSkills(rows: SkillRow[], mode: SortMode): SkillRow[] {
  const copy = [...rows];
  if (mode === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  return copy;
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** 关键字高亮分段：不区分大小写，保留原文大小写；空查询返回单段 */
export function highlightSegments(text: string, query: string): Segment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  while (i < text.length) {
    const at = lower.indexOf(q, i);
    if (at < 0) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + q.length), hit: true });
    i = at + q.length;
  }
  return out;
}

export type ZipCheck = { ok: true; rootName: string } | { ok: false; error: string };

/** 选包前置校验：仅 .zip、文件名可作目录名、大小不超过 20MB */
export function validateZipFile(fileName: string, size: number): ZipCheck {
  if (!/\.zip$/i.test(fileName)) {
    return { ok: false, error: `仅支持 .zip 文件，已忽略「${fileName}」` };
  }
  const rootName = fileName.replace(/\.zip$/i, '');
  if (!rootName || rootName === '.' || rootName === '..') {
    return { ok: false, error: `zip 文件名「${fileName}」无法作为安装目录名，请重命名后重试` };
  }
  if (size > UPLOAD_MAX_TOTAL_BYTES) {
    return { ok: false, error: `zip 包 ${fmtSize(size)}，超过 ${UPLOAD_MAX_TOTAL_BYTES / 1024 / 1024}MB 上限` };
  }
  return { ok: true, rootName };
}

/** 相对时间：<1 分钟「刚刚」、<1 小时「N 分钟前」、其余「N 小时前」 */
export function fmtAgo(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时前`;
}
