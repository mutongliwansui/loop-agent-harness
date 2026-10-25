/**
 * FilesView 右栏真实渲染验证页（Task-20261026-001）
 *
 * 目的：让「对话右侧文件目录」在真实组件 + 真实样式下渲染出来，供 headless Chrome
 * 截图与像素探针核验。仅拦截 /fs/* 接口返回固定夹具，不改组件本身一行代码。
 * 用法：vite dev server 打开 /verify-fs-panel.html（可带 ?scenario= 选场景）；
 *      本文件与产物不参与构建入口。
 *
 * 场景（`?scenario=`，缺省 tree）：
 *   tree     四层目录夹具 + 搜索夹具（浅色/深色/搜索/窄面板等主截图）
 *   loading  /fs/tree 永不返回 → 骨架屏（D7）
 *   error    /fs/tree 返回 500 → 错误态卡片 + 重试（D7）
 *   empty    /fs/tree 返回空 children → 空态卡片（D7）
 */
import { createApp, h } from 'vue';
import './src/style.css';
import type { FsNode, SearchResult } from './src/fs-tree';
import FilesView from './src/views/FilesView.vue';

/** 场景：tree=正常树 / loading=骨架屏 / error=错误态 / empty=空目录 */
type Scenario = 'tree' | 'loading' | 'error' | 'empty';
const SCENARIOS: readonly Scenario[] = ['tree', 'loading', 'error', 'empty'];
const rawScen = new URLSearchParams(location.search).get('scenario') ?? 'tree';
const scenario: Scenario = (SCENARIOS as readonly string[]).includes(rawScen)
  ? (rawScen as Scenario)
  : 'tree';

const f = (path: string, size: number): FsNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  size,
});
const d = (path: string): FsNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'dir',
});

/** 四层目录夹具：docs › designs › sub › deep.md */
const TREE: Record<string, FsNode[]> = {
  '': [
    d('docs'),
    d('src'),
    d('tests'),
    d('webui'),
    f('README.md', 20480),
    f('package.json', 1024),
    f('tsconfig.json', 512),
  ],
  docs: [d('docs/designs'), d('docs/tasks'), d('docs/requirements'), f('docs/README.md', 3300)],
  'docs/designs': [d('docs/designs/sub'), f('docs/designs/原型-20261026-001+文件目录重设计v2.html', 91200)],
  'docs/designs/sub': [f('docs/designs/sub/deep.md', 860)],
  'docs/tasks': [
    f('docs/tasks/task-20261026-001-文件目录重设计落地.md', 15300),
    f('docs/tasks/task-20261025-001-内联菜单宽度.md', 4200),
  ],
  'docs/requirements': [f('docs/requirements/需求.md', 88000)],
  src: [d('src/api'), d('src/tools'), f('src/index.ts', 5600)],
};

const SEARCH: SearchResult[] = [
  { path: 'docs/tasks/task-20261026-001-文件目录重设计落地.md', name: 'task-20261026-001-文件目录重设计落地.md', line: 12, text: '树行改内联 SVG 图标 + 引导线 + 选中色条，行高 26px' },
  { path: 'docs/tasks/task-20261026-001-文件目录重设计落地.md', name: 'task-20261026-001-文件目录重设计落地.md', line: 88, text: '引导线使用 --line-strong，四层以上也能看清归属' },
  { path: 'docs/tasks/task-20261026-001-文件目录重设计落地.md', name: 'task-20261026-001-文件目录重设计落地.md', line: 141, text: '窄面板下搜索占位改为「搜索文件…」，避免截断' },
  { path: 'webui/src/views/FilesView.vue', name: 'FilesView.vue', line: 1990, text: '/* 层级引导线：每层一条 1px 竖线 */' },
  { path: 'README.md', name: 'README.md', line: 34, text: '右侧文件目录支持搜索、懒加载展开与拖拽上传' },
];

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

window.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw, location.origin);
  const p = u.pathname;
  const q = u.searchParams;
  if (p === '/fs/tree') {
    if (scenario === 'loading') return new Promise<Response>(() => {}); // 永不返回 → 骨架屏常驻
    if (scenario === 'error') {
      return new Response(
        JSON.stringify({
          error: { code: 'fs_tree_failed', message: "EACCES: permission denied, scandir '/srv/workspace/docs'" },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }
    if (scenario === 'empty') return json({ children: [], truncated: false });
    const path = q.get('path') ?? '';
    return json({ children: TREE[path] ?? [], truncated: false });
  }
  if (p === '/fs/search') {
    const kw = (q.get('q') ?? '').toLowerCase();
    const results = kw
      ? SEARCH.filter((r) => r.text.toLowerCase().includes(kw) || r.name.toLowerCase().includes(kw))
      : [];
    return json({ truncated: false, results });
  }
  if (p === '/fs/fingerprint') {
    const paths = q.getAll('path');
    return json({ dirs: paths.map((x) => ({ path: x, sig: `sig:${x}` })) });
  }
  if (p === '/fs/file') return json({ content: '# demo\n\n预览区内容（本页只验证右栏）\n' });
  if (p === '/fs/raw') return new Response('', { status: 200 });
  return json({});
};

const app = createApp({
  render: () => h(FilesView, { wsPath: 'loop-agent-command' }),
});
app.mount('#app');

// 供 CDP 探针等待首屏渲染完成 / 确认场景
declare global {
  interface Window {
    __fsVerifyEntryMount?: boolean;
    __fsVerifyScenario?: Scenario;
  }
}
window.__fsVerifyEntryMount = true;
window.__fsVerifyScenario = scenario;
