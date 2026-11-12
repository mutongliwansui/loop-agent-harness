// 路径参数分类与 chip 判定单测（20261028-006 P0 验收 6.1）
// 映射层纯函数无 DOM 依赖，可在 Node vitest 下直测（同 webui-tool-meta.test.ts 口径）。
import { describe, expect, it } from 'vitest';
import {
  isPathArgClickable,
  isUploadsPath,
  pathArgDisabledReason,
  PATH_ARGS,
  toolParamRows,
} from '../webui/src/tool-meta.js';

describe('PATH_ARGS：路径型参数映射', () => {
  it('覆盖需求登记的六组参数', () => {
    expect(PATH_ARGS.fileRead).toEqual({ path: 'file' });
    expect(PATH_ARGS.fileWrite).toEqual({ path: 'file' });
    expect(PATH_ARGS.editFile).toEqual({ path: 'file' });
    expect(PATH_ARGS.grep).toEqual({ path: 'dir' });
    expect(PATH_ARGS.commandRun).toEqual({ cwd: 'dir' });
    expect(PATH_ARGS.analyzeImage).toEqual({ image: 'file' });
  });
});

describe('toolParamRows 路径注记', () => {
  it('fileRead.path 注记 path+kind', () => {
    const rows = toolParamRows('fileRead', JSON.stringify({ path: 'src/a.ts' }));
    expect(rows[0].path).toBe('src/a.ts');
    expect(rows[0].kind).toBe('file');
  });

  it('grep.path / commandRun.cwd 归为 dir', () => {
    const g = toolParamRows('grep', JSON.stringify({ pattern: 'x', path: 'src' }));
    expect(g.find((r) => r.key === 'path')?.kind).toBe('dir');
    const c = toolParamRows('commandRun', JSON.stringify({ command: 'dir', cwd: 'webui' }));
    expect(c.find((r) => r.key === 'cwd')?.kind).toBe('dir');
  });

  it('图片分析 image 注记为 file', () => {
    const rows = toolParamRows('analyzeImage', JSON.stringify({ image: 'C:\\u\\1.png', question: 'q' }));
    const img = rows.find((r) => r.key === 'image');
    expect(img?.path).toBe('C:\\u\\1.png');
    expect(img?.kind).toBe('file');
  });

  it('缺失/非字符串路径参数不注记（无 chip）', () => {
    const rows = toolParamRows('fileRead', JSON.stringify({ startLine: 1 }));
    expect(rows.every((r) => r.path === undefined && r.kind === undefined)).toBe(true);
    const bad = toolParamRows('fileRead', JSON.stringify({ path: 123 }));
    expect(bad[0].path).toBeUndefined();
  });

  it('非路径参数（command/content 等）永不注记', () => {
    const rows = toolParamRows(
      'fileWrite',
      JSON.stringify({ path: 'a.ts', content: 'x', mode: 'overwrite' }),
    );
    expect(rows.find((r) => r.key === 'content')?.path).toBeUndefined();
    expect(rows.find((r) => r.key === 'mode')?.path).toBeUndefined();
  });
});

describe('isUploadsPath：uploads 嗅探（分隔符归一）', () => {
  it('正反斜杠与 ~ 字面量均命中', () => {
    expect(isUploadsPath('C:\\Users\\m\\.loop-agent\\uploads\\s1\\a.png')).toBe(true);
    expect(isUploadsPath('C:/Users/m/.loop-agent/uploads/s1/a.png')).toBe(true);
    expect(isUploadsPath('~/.loop-agent/uploads/s1/a.png')).toBe(true);
    expect(isUploadsPath('src/a.ts')).toBe(false);
    expect(isUploadsPath('C:/x/uploads/a.png')).toBe(false);
  });
});

describe('isPathArgClickable：chip 可点判定', () => {
  const WS = 'D:\\trae_workspace\\loop-agent-command';

  it('相对路径恒可点（工具语义即相对工作空间根）', () => {
    expect(isPathArgClickable('src/a.ts')).toBe(true);
    expect(isPathArgClickable('.\\temp\\x.log')).toBe(true);
  });

  it('uploads 路径可点（~ 字面量或绝对形式）', () => {
    expect(isPathArgClickable('~/.loop-agent/uploads/s1/a.png', WS)).toBe(true);
    expect(isPathArgClickable('C:\\Users\\muton\\.loop-agent\\uploads\\s1\\a.png', WS)).toBe(true);
  });

  it('ws 内绝对路径可点；ws 外绝对路径不可点', () => {
    expect(isPathArgClickable('D:\\trae_workspace\\loop-agent-command\\README.md', WS)).toBe(true);
    expect(isPathArgClickable('D:/TRAE_WORKSPACE/LOOP-AGENT-COMMAND/README.MD', WS)).toBe(true); // 大小写不敏感
    expect(isPathArgClickable('C:\\Windows\\notepad.exe', WS)).toBe(false);
    expect(isPathArgClickable('D:\\other\\proj\\a.ts', WS)).toBe(false);
  });

  it('无 wsRoot 时不猜测（放行由后端兜底）', () => {
    expect(isPathArgClickable('C:\\Windows\\notepad.exe')).toBe(true);
  });

  it('~ 开头但非自有目录不可点（外部应用目录，20261028-007 仍拒绝）', () => {
    expect(isPathArgClickable('~/.claude/skills/x/SKILL.md', WS)).toBe(false);
  });

  it('自有数据目录路径可点（20261028-007：~ 字面量与绝对形式，uploads 之外）', () => {
    // 记忆 L2（fileWrite 写记忆场景）
    expect(isPathArgClickable('C:\\Users\\muton\\.loop-agent\\memory\\a43aa30f2ceec764\\2026-10-29.md', WS)).toBe(true);
    // runs 日志（fileRead 后台任务日志场景）
    expect(isPathArgClickable('~\\.loop-agent\\runs\\t1.log', WS)).toBe(true);
    // 全局技能（activateSkill 引导读取场景）
    expect(isPathArgClickable('~/.loop-agent/skills/task-driven-development/SKILL.md', WS)).toBe(true);
  });

  it('http(s) 与 data URI 不可点（D7 外部资源无文件预览语义）', () => {
    expect(isPathArgClickable('https://example.com/a.md')).toBe(false);
    expect(isPathArgClickable('http://example.com/a.md')).toBe(false);
    expect(isPathArgClickable('data:image/png;base64,iVBORw0K')).toBe(false);
    // 大小写变体同样命中
    expect(isPathArgClickable('HTTPS://EXAMPLE.COM/A.MD')).toBe(false);
  });
});

describe('pathArgDisabledReason：不可点原因（D7 title 提示）', () => {
  const WS = 'D:\\trae_workspace\\loop-agent-command';

  it('相对路径与 uploads 可点 → 空串', () => {
    expect(pathArgDisabledReason('src/a.ts')).toBe('');
    expect(pathArgDisabledReason('C:\\Users\\muton\\.loop-agent\\uploads\\s1\\a.png', WS)).toBe('');
  });

  it('自有数据目录路径可点 → 空串（20261028-007）', () => {
    expect(pathArgDisabledReason('C:\\Users\\muton\\.loop-agent\\memory\\x\\y.md', WS)).toBe('');
    expect(pathArgDisabledReason('~/.loop-agent/skills/s/SKILL.md', WS)).toBe('');
    expect(pathArgDisabledReason('~/.claude/skills/s/SKILL.md', WS)).toBe('文件在工作空间之外');
  });

  it('ws 外绝对路径 → 「文件在工作空间之外」', () => {
    expect(pathArgDisabledReason('C:\\Windows\\notepad.exe', WS)).toBe('文件在工作空间之外');
  });

  it('~ 开头但非自有目录 → 「文件在工作空间之外」（20261028-007 起外部目录仍拒绝）', () => {
    expect(pathArgDisabledReason('~/.claude/skills/x/SKILL.md', WS)).toBe('文件在工作空间之外');
  });

  it('http(s)/data URI 注明不可预览原因（D7）', () => {
    expect(pathArgDisabledReason('https://example.com/a.md')).toBe('外部链接不支持预览');
    expect(pathArgDisabledReason('data:image/png;base64,xxx')).toBe('内联数据不支持预览');
  });
});
