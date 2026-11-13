// 启动体检检测单测：blocker / missing 判定与探针注入（Task-20261011-001 6.3/6.11）
//
// 需求 20261112-008（D2/D5）：配置与 skill 一律全局，BootstrapPaths 只保留全局两项
// （globalConfigPath / skillsGlobalDir），workspace-config 与 skills-workspace 检查项已删除。
import { describe, it, expect } from 'vitest';
import {
  checkBootstrap,
  type BootstrapPaths,
  type ExistsProbe,
} from '../src/bootstrap/doctor.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';

const paths: BootstrapPaths = {
  globalConfigPath: '/g/config.json',
  skillsGlobalDir: '/g/skills',
};

const allExisting: ExistsProbe = () => true;
const noneExisting: ExistsProbe = () => false;

function makeCfg(modelOverrides: Partial<AgentConfig['model']> = {}): AgentConfig {
  return {
    ...DEFAULT_CONFIG,
    model: { ...DEFAULT_CONFIG.model, apiKey: 'sk-default', ...modelOverrides },
  };
}

describe('checkBootstrap（启动体检检测）', () => {
  it('全部齐备时 ok=true 且无 issue', () => {
    const report = checkBootstrap(makeCfg(), paths, allExisting);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('apiKey 为空 → blocker 级 model-apiKey，ok=false', () => {
    const report = checkBootstrap(makeCfg({ apiKey: '' }), paths, allExisting);
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ id: 'model-apiKey', level: 'blocker' }),
    ]);
  });

  it('apiKey 为空白字符串同样视为未配置', () => {
    const report = checkBootstrap(makeCfg({ apiKey: '   ' }), paths, allExisting);
    expect(report.issues.some((i) => i.id === 'model-apiKey' && i.level === 'blocker')).toBe(true);
  });

  it('模型名为空 → blocker 级 model-name', () => {
    const report = checkBootstrap(makeCfg({ name: '' }), paths, allExisting);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.id === 'model-name' && i.level === 'blocker')).toBe(true);
  });

  it('文件/目录缺失 → missing 级 issue，不影响 ok（只剩全局两项）', () => {
    const report = checkBootstrap(makeCfg(), paths, noneExisting);
    expect(report.ok).toBe(true);
    const ids = report.issues.map((i) => i.id).sort();
    expect(ids).toEqual(['global-config', 'skills-global']);
    const gc = report.issues.find((i) => i.id === 'global-config');
    expect(gc?.path).toBe(paths.globalConfigPath);
  });

  it('blocker 与 missing 混合时两类都报告', () => {
    const report = checkBootstrap(makeCfg({ apiKey: '' }), paths, noneExisting);
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(3);
    expect(report.issues.filter((i) => i.level === 'blocker')).toHaveLength(1);
    expect(report.issues.filter((i) => i.level === 'missing')).toHaveLength(2);
  });

  it('探针按路径判定：存在的路径不报 missing', () => {
    const partial: ExistsProbe = (p) => p === paths.skillsGlobalDir;
    const report = checkBootstrap(makeCfg(), paths, partial);
    expect(report.issues.map((i) => i.id)).toEqual(expect.arrayContaining(['global-config']));
    expect(report.issues.some((i) => i.id === 'skills-global')).toBe(false);
  });

  it('不再产出工作空间相关检查项（008 已删除对应路径字段）', () => {
    expect((paths as unknown as Record<string, unknown>).workspaceConfigPath).toBeUndefined();
    expect((paths as unknown as Record<string, unknown>).skillsWorkspaceDir).toBeUndefined();
  });
});
