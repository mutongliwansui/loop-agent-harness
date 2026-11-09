/**
 * 技能页纯逻辑测试（原型-20261109-001 · 方案 B）
 *
 * 覆盖 webui/src/skills-ui.ts：
 * - filterSkills / scopeCounts：来源分段 + 名称/描述/路径三字段搜索
 * - sortSkills：来源优先（工作空间在前）与名称 A→Z
 * - highlightSegments：不区分大小写、保留原文大小写、空查询单段
 * - validateZipFile：仅 .zip、目录名合法、20MB 上限
 * - scopeLabel / scopeHint / skillInitials / fmtSize / fmtAgo
 *
 * 卡片 DOM 渲染与抽屉交互无 jsdom，改由真实浏览器渲染断言。
 */
import { describe, it, expect } from 'vitest';
import {
  UPLOAD_MAX_TOTAL_BYTES,
  filterSkills,
  fmtAgo,
  fmtSize,
  highlightSegments,
  scopeCounts,
  scopeHint,
  scopeLabel,
  skillInitials,
  sortSkills,
  validateZipFile,
  type SkillRow,
} from '../webui/src/skills-ui.js';

const rows: SkillRow[] = [
  { name: 'py-pptx', description: '创建 PowerPoint 演示文稿', scope: 'workspace', path: '/ws/.loop-agent/skills/py-pptx/SKILL.md' },
  { name: 'slide-theme', description: '演示文稿主题规范', scope: 'workspace', path: '/ws/.loop-agent/skills/slide-theme/SKILL.md' },
  { name: 'pdfkit', description: '合并与拆分 PDF', scope: 'global', path: '/home/.loop-agent/skills/pdfkit/SKILL.md' },
  { name: 'mermaid-chart', description: '绘制流程图与时间线', scope: 'global', path: '/home/.loop-agent/skills/mermaid-chart/SKILL.md' },
];

describe('filterSkills', () => {
  it('空查询 + all 返回全部（保持入参顺序）', () => {
    expect(filterSkills(rows, '', 'all').map((r) => r.name)).toEqual(['py-pptx', 'slide-theme', 'pdfkit', 'mermaid-chart']);
  });

  it('来源分段只保留对应 scope', () => {
    expect(filterSkills(rows, '', 'workspace').map((r) => r.name)).toEqual(['py-pptx', 'slide-theme']);
    expect(filterSkills(rows, '', 'global').map((r) => r.name)).toEqual(['pdfkit', 'mermaid-chart']);
  });

  it('搜索命中名称（不区分大小写）', () => {
    expect(filterSkills(rows, 'PPTX', 'all').map((r) => r.name)).toEqual(['py-pptx']);
  });

  it('搜索命中描述与路径', () => {
    expect(filterSkills(rows, '流程图', 'all').map((r) => r.name)).toEqual(['mermaid-chart']);
    expect(filterSkills(rows, 'home/.loop-agent', 'all').map((r) => r.name)).toEqual(['pdfkit', 'mermaid-chart']);
  });

  it('来源与关键字同时生效；无匹配返回空数组', () => {
    expect(filterSkills(rows, 'PPTX', 'global')).toEqual([]);
  });

  it('首尾空白不参与匹配', () => {
    expect(filterSkills(rows, '  pdfkit  ', 'all').map((r) => r.name)).toEqual(['pdfkit']);
  });
});

describe('scopeCounts', () => {
  it('按来源统计总数（全量口径，不随搜索变化）', () => {
    expect(scopeCounts(rows)).toEqual({ all: 4, workspace: 2, global: 2 });
    expect(scopeCounts([])).toEqual({ all: 0, workspace: 0, global: 0 });
  });
});

describe('sortSkills', () => {
  it('scope：工作空间优先，组内按名称', () => {
    expect(sortSkills(rows, 'scope').map((r) => r.name)).toEqual([
      'py-pptx',
      'slide-theme',
      'mermaid-chart',
      'pdfkit',
    ]);
  });

  it('name：全局按名称 A→Z', () => {
    expect(sortSkills(rows, 'name').map((r) => r.name)).toEqual([
      'mermaid-chart',
      'pdfkit',
      'py-pptx',
      'slide-theme',
    ]);
  });

  it('不修改入参数组的顺序', () => {
    const input = [...rows];
    sortSkills(input, 'name');
    expect(input.map((r) => r.name)).toEqual(rows.map((r) => r.name));
  });
});

describe('highlightSegments', () => {
  it('空查询返回单段且未命中', () => {
    expect(highlightSegments('py-pptx', '')).toEqual([{ text: 'py-pptx', hit: false }]);
  });

  it('命中保留原文大小写，命中段独立', () => {
    expect(highlightSegments('py-pptx', 'pp')).toEqual([
      { text: 'py-', hit: false },
      { text: 'pp', hit: true },
      { text: 'tx', hit: false },
    ]);
  });

  it('多次命中分别切段', () => {
    expect(highlightSegments('aXbXc', 'x')).toEqual([
      { text: 'a', hit: false },
      { text: 'X', hit: true },
      { text: 'b', hit: false },
      { text: 'X', hit: true },
      { text: 'c', hit: false },
    ]);
  });

  it('未命中返回整段', () => {
    expect(highlightSegments('pdfkit', 'zzz')).toEqual([{ text: 'pdfkit', hit: false }]);
  });
});

describe('validateZipFile', () => {
  it('合法 zip 返回去扩展名的安装目录名', () => {
    expect(validateZipFile('slide-theme.zip', 1024)).toEqual({ ok: true, rootName: 'slide-theme' });
    expect(validateZipFile('Slide.ZIP', 1024)).toEqual({ ok: true, rootName: 'Slide' });
  });

  it('非 zip 拒绝', () => {
    const r = validateZipFile('skill.tar.gz', 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('仅支持 .zip');
  });

  it('文件名不可作目录名拒绝', () => {
    const r = validateZipFile('.zip', 1024);
    expect(r.ok).toBe(false);
  });

  it('超过 20MB 拒绝并给出体积', () => {
    const r = validateZipFile('big.zip', UPLOAD_MAX_TOTAL_BYTES + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('20MB');
  });

  it('恰好 20MB 放行（边界包含）', () => {
    expect(validateZipFile('edge.zip', UPLOAD_MAX_TOTAL_BYTES).ok).toBe(true);
  });
});

describe('展示文案', () => {
  it('scopeLabel / scopeHint', () => {
    expect(scopeLabel('workspace')).toBe('工作空间');
    expect(scopeLabel('global')).toBe('全局');
    expect(scopeHint('workspace')).toBe('当前项目可用');
    expect(scopeHint('global')).toBe('所有项目可用');
  });

  it('skillInitials：双词取首字母、单词取前两位、空名兜底', () => {
    expect(skillInitials('py-pptx')).toBe('PP');
    expect(skillInitials('pdfkit')).toBe('PD');
    expect(skillInitials('技能')).toBe('技能');
    expect(skillInitials('  ')).toBe('?');
  });

  it('fmtSize：B / KB / MB', () => {
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(5 * 1024 * 1024)).toBe('5.00 MB');
  });

  it('fmtAgo：刚刚 / 分钟 / 小时', () => {
    const now = 1_700_000_000_000;
    expect(fmtAgo(now - 10_000, now)).toBe('刚刚');
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe('3 小时前');
  });
});
