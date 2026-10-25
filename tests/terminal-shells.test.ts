/**
 * 终端 shell 探测单测（Task-20261027-001 / D3）
 *
 * 重点验证「不硬编码假设」这条设计决策：
 * - 本机实测无 pwsh.exe，若把 PowerShell 7 写死为主选项会首屏即失败
 * - 探测结果必须只包含真实存在的可执行文件
 * - $SHELL 指向的 shell 在 POSIX 下应被提前
 */
import { describe, it, expect } from 'vitest';
import { detectShells, pickShell } from '../src/terminal/shells.js';

/** 构造一个只「存在」指定文件的 exists 桩 */
const only = (...files: string[]) => (f: string): boolean => files.includes(f);

describe('detectShells · Windows', () => {
  it('三者齐全时按 pwsh > powershell > cmd 顺序返回', () => {
    const list = detectShells('win32', only('pwsh.exe', 'powershell.exe', 'cmd.exe'), undefined);
    expect(list.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd']);
  });

  it('无 pwsh 时只剩 powershell 与 cmd（复现本机实况）', () => {
    const list = detectShells('win32', only('powershell.exe', 'cmd.exe'), undefined);
    expect(list.map((s) => s.id)).toEqual(['powershell', 'cmd']);
    expect(list.some((s) => s.id === 'pwsh')).toBe(false);
  });

  it('只有 cmd 时仍可用', () => {
    const list = detectShells('win32', only('cmd.exe'), undefined);
    expect(list.map((s) => s.id)).toEqual(['cmd']);
  });

  it('一个都没有时返回空数组（上层据此报 no_shell）', () => {
    expect(detectShells('win32', only(), undefined)).toEqual([]);
  });

  it('label 与 args 一并带出，供前端下拉直接展示', () => {
    const [cmd] = detectShells('win32', only('cmd.exe'), undefined);
    expect(cmd.label).toBeTruthy();
    expect(Array.isArray(cmd.args)).toBe(true);
  });
});

describe('detectShells · POSIX', () => {
  it('按 zsh > bash > sh 排序', () => {
    const list = detectShells('linux', only('/bin/zsh', '/bin/bash', '/bin/sh'), undefined);
    expect(list.map((s) => s.id)).toEqual(['zsh', 'bash', 'sh']);
  });

  it('$SHELL 指向的 shell 被提前到首位', () => {
    const list = detectShells('linux', only('/bin/zsh', '/bin/bash'), '/bin/bash');
    expect(list[0].id).toBe('bash');
    expect(list.map((s) => s.id)).toEqual(['bash', 'zsh']);
  });

  it('$SHELL 指向不存在的 shell 时不影响排序', () => {
    const list = detectShells('linux', only('/bin/bash'), '/bin/zsh');
    expect(list.map((s) => s.id)).toEqual(['bash']);
  });

  it('macOS 走同一套 POSIX 分支', () => {
    const list = detectShells('darwin', only('/bin/zsh', '/bin/sh'), undefined);
    expect(list.map((s) => s.id)).toEqual(['zsh', 'sh']);
  });
});

describe('pickShell', () => {
  const win = detectShells('win32', only('powershell.exe', 'cmd.exe'), undefined);

  it('指定 id 时返回对应 shell', () => {
    expect(pickShell(win, 'cmd')?.id).toBe('cmd');
  });

  it('id 未命中时回落首个可用项（而非返回 null）', () => {
    expect(pickShell(win, 'pwsh')?.id).toBe('powershell');
  });

  it('不指定 id 时返回首个', () => {
    expect(pickShell(win)?.id).toBe('powershell');
  });

  it('空列表返回 null', () => {
    expect(pickShell([], 'cmd')).toBeNull();
  });
});
