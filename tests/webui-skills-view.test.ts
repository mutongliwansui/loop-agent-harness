/**
 * 技能页纯逻辑测试（原型-20261109-001 · 方案 B）
 *
 * 需求 20261112-008 后：skill 目录只剩全局一份，来源（workspace/global）分段、
 * 来源文案与按来源排序随资源层删除。本文件相应改写。
 *
 * 覆盖 webui/src/skills-ui.ts：
 * - filterSkills：名称/描述/路径三字段搜索
 * - sortSkills：按名称 A→Z，且不改入参数组
 * - highlightSegments：不区分大小写、保留原文大小写、空查询单段
 * - validateZipFile：仅 .zip、目录名合法、20MB 上限
 * - skillInitials / fmtSize / fmtAgo
 * - 已移除的 scope 相关导出（断言不存在，防止回归）
 *
 * 卡片 DOM 渲染与抽屉交互无 jsdom，改由真实浏览器渲染断言。
 */
import { describe, it, expect } from 'vitest';
import * as skillsUi from '../webui/src/skills-ui.js';
import {
  SKILLS_INSTALL_DIR,
  UPLOAD_MAX_TOTAL_BYTES,
  filterSkills,
  fmtAgo,
  fmtSize,
  highlightSegments,
  skillInitials,
  sortSkills,
  validateZipFile,
  type SkillRow,
} from '../webui/src/skills-ui.js';

const rows: SkillRow[] = [
  { name: 'py-pptx', description: '创建 PowerPoint 演示文稿', scope: 'global', path: '/home/.loop-agent/skills/py-pptx/SKILL.md' },
  { name: 'slide-theme', description: '演示文稿主题规范', scope: 'global', path: '/home/.loop-agent/skills/slide-theme/SKILL.md' },
  { name: 'pdfkit', description: '合并与拆分 PDF', scope: 'global', path: '/home/.loop-agent/skills/pdfkit/SKILL.md' },
  { name: 'mermaid-chart', description: '绘制流程图与时间线', scope: 'global', path: '/home/.loop-agent/skills/mermaid-chart/SKILL.md' },
];

describe('filterSkills', () => {
  it('空查询返回全部（保持入参顺序）', () => {
    expect(filterSkills(rows, '').map((r) => r.name)).toEqual(['py-pptx', 'slide-theme', 'pdfkit', 'mermaid-chart']);
  });

  it('搜索命中名称（不区分大小写）', () => {
    expect(filterSkills(rows, 'PPTX').map((r) => r.name)).toEqual(['py-pptx']);
  });

  it('搜索命中描述与路径', () => {
    expect(filterSkills(rows, '流程图').map((r) => r.name)).toEqual(['mermaid-chart']);
    // 008 后全部 skill 都在全局目录下，路径搜索命中全部
    expect(filterSkills(rows, 'home/.loop-agent').map((r) => r.name)).toEqual([
      'py-pptx',
      'slide-theme',
      'pdfkit',
      'mermaid-chart',
    ]);
  });

  it('无匹配返回空数组', () => {
    expect(filterSkills(rows, 'zzz')).toEqual([]);
  });

  it('首尾空白不参与匹配', () => {
    expect(filterSkills(rows, '  pdfkit  ').map((r) => r.name)).toEqual(['pdfkit']);
  });
});

describe('sortSkills', () => {
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

describe('008 收敛：来源相关导出已移除', () => {
  it('scopeCounts / scopeLabel / scopeHint 均不存在', () => {
    const mod = skillsUi as unknown as Record<string, unknown>;
    expect(mod.scopeCounts).toBeUndefined();
    expect(mod.scopeLabel).toBeUndefined();
    expect(mod.scopeHint).toBeUndefined();
  });

  it('唯一安装位置指向全局目录', () => {
    expect(SKILLS_INSTALL_DIR).toBe('~/.loop-agent/skills/');
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
