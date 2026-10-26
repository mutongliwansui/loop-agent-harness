// L2 情景记忆条目解析与筛选（需求 20261026-004 / 方案 D3）
//
// 后端 GET /memory/episodic 只按天返回原文（{day, content}），条目头
// 「## [ts] [sessionId: x] [scope: session|global] [tag: x]」的元数据
// 由前端解析（方案 D3：≤90 天纯文本量级，前端筛选零延迟，后端不加参数）。
// 纯函数模块，配 Vitest 单测。

/** 单条 L2 条目（解析后） */
export interface MemEntry {
  /** ISO 时间（条目头第 1 段） */
  ts: string;
  /** 会话 id（条目头 [sessionId: x]，可能缺省） */
  sessionId: string;
  /** 会话标题（由会话列表映射，非条目头内容） */
  sessionTitle: string;
  /** scope（session | global；缺省 session） */
  scope: 'session' | 'global';
  /** 标签（[tag: x]，可能为空） */
  tag: string;
  /** 正文（条目头行之后的内容，不含头行） */
  text: string;
  /** 所属天（YYYY-MM-DD，由分组带入） */
  day: string;
}

/** L2 三级筛选条件（会话 / 范围 / 标签；空间与天数在加载参数上，不在条目筛选内） */
export interface MemFilter {
  sessionId: string;
  scope: '' | 'session' | 'global';
  tag: string;
}

/** 条目头正则：## [ts] [sessionId: x] [scope: x] [tag: x]（后两段可缺省） */
const HEAD_RE = /^##\s+\[([^\]]+)\](?:\s+\[sessionId:\s*([^\]]*)\])?(?:\s+\[scope:\s*([^\]]*)\])?(?:\s+\[tag:\s*([^\]]*)\])?\s*$/;

/** 解析一天的内容为条目数组（不带头行的行归入上一条正文；开头无头行的行忽略） */
export function parseDay(content: string, day: string): MemEntry[] {
  const out: MemEntry[] = [];
  let cur: MemEntry | null = null;
  for (const line of content.split(/\r?\n/)) {
    const m = HEAD_RE.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = {
        ts: (m[1] ?? '').trim(),
        sessionId: (m[2] ?? '').trim(),
        sessionTitle: '',
        scope: (m[3] ?? '').trim() === 'global' ? 'global' : 'session',
        tag: (m[4] ?? '').trim(),
        text: '',
        day,
      };
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 解析多天并按时间新 → 旧排序（组间按天倒序，组内按条目倒序——文件写入本就新在上） */
export function parseDays(entries: { day: string; content: string }[]): MemEntry[] {
  const out: MemEntry[] = [];
  for (const e of entries) out.push(...parseDay(e.content, e.day));
  return out;
}

/** 应用三级筛选（空值 = 不过滤该维度） */
export function filterEntries(entries: MemEntry[], f: MemFilter): MemEntry[] {
  return entries.filter(
    (e) =>
      (!f.sessionId || e.sessionId === f.sessionId) &&
      (!f.scope || e.scope === f.scope) &&
      (!f.tag || e.tag === f.tag),
  );
}

/** 从条目集合提取去重后的会话 id 清单（保持首现顺序） */
export function sessionIdsOf(entries: MemEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of entries) if (e.sessionId) seen.add(e.sessionId);
  return [...seen];
}

/** 从条目集合提取去重后的标签清单（保持首现顺序） */
export function tagsOf(entries: MemEntry[]): string[] {
  const seen = new Set<string>();
  for (const e of entries) if (e.tag) seen.add(e.tag);
  return [...seen];
}

/** 按天分组（保持传入顺序；供「按天分组列表」渲染） */
export function groupByDay(entries: MemEntry[]): { day: string; items: MemEntry[] }[] {
  const map = new Map<string, MemEntry[]>();
  for (const e of entries) {
    const arr = map.get(e.day);
    if (arr) arr.push(e);
    else map.set(e.day, [e]);
  }
  return [...map.entries()].map(([day, items]) => ({ day, items }));
}

/** 单元格文本：正文压缩到单行预览（供检索式摘要展示） */
export function previewOf(e: MemEntry, max = 160): string {
  const t = e.text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
