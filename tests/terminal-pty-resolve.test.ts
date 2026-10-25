/**
 * PTY 原生模块解析判据单测（Task-20261027-001 后续修复）
 *
 * 背景是线上真实故障：SEA 单文件 exe 拷到新目录/新工作空间后，终端报
 * 「交互式终端不可用，请执行 npm i @lydell/node-pty」，而报错让人误以为是缺依赖。
 * 真因有两个，这里各锁一条：
 *
 * 1. `process.argv[1]` 在 SEA 下是**用户命令行参数**（如 `--serve`）
 *    纯属误用——它会被 createRequire 当作路径、按 cwd 解析，导致
 *    「PTY 是否可用」随启动目录漂移。必须先用 looksLikeScriptPath 过滤。
 * 2. 提示文案必须说明「已查找哪些目录」并区分开发环境 / 单文件 exe 部署，
 *    否则用户在 exe 目录里对着 npm i 的指引无从下手。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import {
  looksLikeScriptPath,
  describePtySearchPaths,
  ptyUnavailableHint,
} from '../src/terminal/pty-session.js';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
});

describe('looksLikeScriptPath：区分入口脚本与 CLI 参数', () => {
  it('SEA 下的 CLI 标志不算脚本路径（这是本次故障的根因）', () => {
    expect(looksLikeScriptPath('--serve')).toBe(false);
    expect(looksLikeScriptPath('-h')).toBe(false);
    expect(looksLikeScriptPath('--port')).toBe(false);
  });

  it('缺省 / 空值不算脚本路径', () => {
    expect(looksLikeScriptPath(undefined)).toBe(false);
    expect(looksLikeScriptPath('')).toBe(false);
  });

  it('真实入口脚本算（源码 tsx 与 CJS/ESM 产物）', () => {
    expect(looksLikeScriptPath('D:\\app\\src\\index.ts')).toBe(true);
    expect(looksLikeScriptPath('/app/dist-sea/index.cjs')).toBe(true);
    expect(looksLikeScriptPath('C:\\app\\dist\\index.js')).toBe(true);
    expect(looksLikeScriptPath('index.mjs')).toBe(true);
  });

  it('既非脚本后缀也非绝对路径的裸词不算', () => {
    expect(looksLikeScriptPath('terminal')).toBe(false);
    expect(looksLikeScriptPath('config.json')).toBe(false);
  });
});

describe('describePtySearchPaths：给出真实查找目录', () => {
  it('SEA 场景（argv[1] 是 --serve）只看 exe 同目录，不含 CLI 参数污染', () => {
    process.argv = ['D:\\sea-standalone\\loop-agent.exe', '--serve'];
    const desc = describePtySearchPaths();
    // 必须是 exe 所在目录下的 node_modules
    expect(desc).toContain(join(dirname(process.execPath), 'node_modules'));
    // 不能把 --serve 当基准目录带进来
    expect(desc).not.toContain('--serve');
  });

  it('开发场景（argv[1] 为入口脚本）优先给出入口所在 node_modules', () => {
    process.argv = ['node', 'D:\\app\\src\\index.ts'];
    const desc = describePtySearchPaths();
    expect(desc).toContain(join('D:\\app\\src', 'node_modules'));
  });

  it('无参数时不报错且非空', () => {
    process.argv = ['node'];
    expect(describePtySearchPaths().length).toBeGreaterThan(0);
  });
});

describe('ptyUnavailableHint：文案要能指导两种部署形态', () => {
  it('同时覆盖开发环境与单文件 exe 部署，并带出查找路径', () => {
    process.argv = ['D:\\sea-standalone\\loop-agent.exe', '--serve'];
    const hint = ptyUnavailableHint();
    expect(hint).toContain('@lydell/node-pty');
    expect(hint).toContain('npm i'); // 开发环境补救
    expect(hint).toContain('node_modules/@lydell'); // exe 部署补救
    expect(hint).toContain('build:sea'); // 指向自动拷贝方案
    expect(hint).toContain('node_modules'); // 真实查找路径
  });

  // Task-20261027-002 D8：内嵌方案落地后，文案必须先讲「单文件 exe 自带模块」，
  // 再讲旧形态兼容，否则用户仍会对着 exe 目录执行 npm i。
  it('区分「单文件 exe 自带」与「exe + 同级 node_modules」两条路径', () => {
    process.argv = ['D:\\sea-standalone\\loop-agent.exe', '--serve'];
    const hint = ptyUnavailableHint();
    expect(hint).toContain('单文件 exe');
    expect(hint).toContain('同级 node_modules');
  });
});
