// fs-tree：文件目录面板的纯逻辑（原型-20261026-001 落地）
// 从 FilesView.vue 内联实现中抽离，便于 vitest 直接覆盖：
//   flattenRows      摊平展开中的树 → 行 + 层级引导线位图（D3）
//   groupHits        搜索结果按文件分组 + 命中数（D6）
//   splitHits        搜索结果按「目录命中 / 文件分组」分离（20261028-004 D6）
//   highlightParts   关键词切片高亮，indexOf 实现，避免正则元字符（D6）
//   crumbOf          选中文件所在目录链面包屑（D9）
//   fmtBytes         字节格式化（自 FilesView 迁入）
// 约定：path 一律以 '/' 分隔且相对工作空间根，根为 ''；本模块零依赖、无副作用。

/** 目录节点（与 GET /fs/tree 返回结构一致） */
export interface FsNode {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  children?: FsNode[];
}

/** 搜索命中项（与 GET /fs/search 返回结构一致） */
export interface SearchResult {
  path: string;
  name: string;
  line: number;
  text: string;
  /** 命中类型（20261028-004）：名称命中与目录命中 line=0；缺省视为内容命中（兼容旧后端） */
  kind?: 'content' | 'name' | 'dir';
}

/** 树行：depth 决定缩进，guides[k] = 第 k 层祖先是否需续画引导线 */
export interface FsRow {
  node: FsNode;
  depth: number;
  guides: boolean[];
}

/** 搜索结果分组：一个文件一组 */
export interface HitGroup {
  path: string;
  /** 所在目录（含尾斜杠），根级文件为 '' */
  dir: string;
  /** 文件名（path 最后一段） */
  name: string;
  /** 组内内容命中，按行号升序（不含 line=0 的名称命中，D7） */
  hits: SearchResult[];
  /** 该文件是否文件名命中（组头据此高亮文件名，D7） */
  nameHit: boolean;
}

/** 目录名命中项（D6）：点击在树中展开并定位 */
export interface DirHit {
  path: string;
  name: string;
  /** 所在目录（含尾斜杠），根级目录为 '' */
  dir: string;
}

/** 高亮切片：hit=true 的片段用 <mark> 包裹 */
export interface HiPart {
  t: string;
  hit: boolean;
}

/** 面包屑段：label 为显示名，path 为该段对应的目录相对路径（点击可定位） */
export interface Crumb {
  label: string;
  path: string;
}

/**
 * 摊平展开中的树。仅递归展开集合内的目录，未展开目录只出自身一行。
 * guides 长度恒等于 depth：第 k 项表示「第 k 层祖先在其兄弟序列中不是最后一个」，
 * 渲染时据此在每个缩进步长处画一条竖线，四层以上也能看清归属。
 */
export function flattenRows(tree: FsNode[], expanded: ReadonlySet<string>): FsRow[] {
  const out: FsRow[] = [];
  const walk = (nodes: FsNode[], depth: number, guides: boolean[]): void => {
    nodes.forEach((node, i) => {
      out.push({ node, depth, guides: guides.slice() });
      if (node.type === 'dir' && expanded.has(node.path)) {
        walk(node.children ?? [], depth + 1, guides.concat([i < nodes.length - 1]));
      }
    });
  };
  walk(tree, 0, []);
  return out;
}

/**
 * 搜索结果按文件分组：组顺序取 path 首次出现顺序（贴近后端返回的扫描序），
 * 组内按行号升序。同一 path+line 的重复命中不去重（后端可能同文本多行命中）。
 * D7（20261028-004）：line=0 / kind='name' 的名称命中不计入 hits，只置 nameHit 标记；
 * kind='dir' 的目录命中不参与分组（由 splitHits 分离）。
 */
export function groupHits(results: SearchResult[]): HitGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, SearchResult[]>();
  const nameHit = new Set<string>();
  for (const r of results) {
    if (r.kind === 'dir') continue;
    let bucket = byPath.get(r.path);
    if (!bucket) {
      bucket = [];
      byPath.set(r.path, bucket);
      order.push(r.path);
    }
    if (r.line === 0 || r.kind === 'name') {
      nameHit.add(r.path); // 名称命中只做标记，不占内容行
      continue;
    }
    bucket.push(r);
  }
  return order.map((path) => {
    const hits = (byPath.get(path) ?? []).slice().sort((a, b) => a.line - b.line);
    const i = path.lastIndexOf('/');
    return {
      path,
      dir: i >= 0 ? path.slice(0, i + 1) : '',
      name: i >= 0 ? path.slice(i + 1) : path,
      hits,
      nameHit: nameHit.has(path),
    };
  });
}

/**
 * 把搜索结果拆成「目录命中」与「文件分组」（D6）。
 * groupHits 的契约（按文件分组 / 组内行号升序 / 组顺序取首次出现）已被既有单测锁定，
 * 故不改其签名，另设本函数只做分离：目录命中单独成行（点击定位），其余交给 groupHits。
 */
export function splitHits(results: SearchResult[]): { files: HitGroup[]; dirs: DirHit[] } {
  const dirs: DirHit[] = [];
  const files: SearchResult[] = [];
  for (const r of results) {
    if (r.kind === 'dir') {
      const i = r.path.lastIndexOf('/');
      dirs.push({ path: r.path, name: r.name, dir: i >= 0 ? r.path.slice(0, i + 1) : '' });
    } else {
      files.push(r);
    }
  }
  return { files: groupHits(files), dirs };
}

/**
 * 关键词切片高亮：大小写不敏感、命中原文大小写保留、全部命中（不跳词）。
 * 用 indexOf 而非 RegExp，因此关键词含 ( ) * . \ 等元字符时不会抛错。
 * 关键词为空 / 全空白时返回整段非命中，不产生空切片。
 */
export function highlightParts(text: string, kw: string): HiPart[] {
  if (!text) return [];
  const key = kw.trim().toLowerCase();
  if (!key) return [{ t: text, hit: false }];
  const lower = text.toLowerCase();
  const parts: HiPart[] = [];
  let pos = 0;
  for (let i = lower.indexOf(key); i >= 0; i = lower.indexOf(key, pos)) {
    if (i > pos) parts.push({ t: text.slice(pos, i), hit: false });
    parts.push({ t: text.slice(i, i + key.length), hit: true });
    pos = i + key.length;
  }
  if (pos < text.length) parts.push({ t: text.slice(pos), hit: false });
  return parts;
}

/**
 * 面包屑：根段 + 选中文件所在目录链（不含文件名本身）。
 * 未选中文件（''）或根级文件（无 '/'）时只返回根段。
 */
export function crumbOf(filePath: string, rootLabel: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: rootLabel, path: '' }];
  if (!filePath) return crumbs;
  const i = filePath.lastIndexOf('/');
  if (i < 0) return crumbs;
  const segs = filePath.slice(0, i).split('/').filter(Boolean);
  segs.forEach((seg, k) => {
    crumbs.push({ label: seg, path: segs.slice(0, k + 1).join('/') });
  });
  return crumbs;
}

/** 字节格式化：1 位小数的 MB / 整数 KB / 原值 B */
export function fmtBytes(n: number): string {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
