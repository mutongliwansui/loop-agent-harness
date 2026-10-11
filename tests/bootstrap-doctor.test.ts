// 启动体检检测单测：blocker / missing 判定与探针注入（Task-20261011-001 6.3/6.11）
import { describe, it, expect } from 'vitest';
import {
  checkBootstrap,
  type BootstrapPaths,
  type ExistsProbe,
} from '../src/bootstrap/doctor.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../src/config/schema.js';

const paths: BootstrapPaths = {
  globalConfigPath: '/g/config.json',
  workspaceConfigPath: '/w/.loop-agent/.agent-config.json',
  skillsGlobalDir: '/g/skills',
  skillsWorkspaceDir: '/w/.loop-agent/skills',
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

  it('文件/目录缺失 → missing 级 issue，不影响 ok', () => {
    const report = checkBootstrap(makeCfg(), paths, noneExisting);
    expect(report.ok).toBe(true);
    const ids = report.issues.map((i) => i.id).sort();
    expect(ids).toEqual([
      'global-config',
      'skills-global',
      'skills-workspace',
      'workspace-config',
    ]);
    const wc = report.issues.find((i) => i.id === 'workspace-config');
    expect(wc?.path).toBe(paths.workspaceConfigPath);
  });

  it('blocker 与 missing 混合时两类都报告', () => {
    const report = checkBootstrap(makeCfg({ apiKey: '' }), paths, noneExisting);
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(5);
    expect(report.issues.filter((i) => i.level === 'blocker')).toHaveLength(1);
    expect(report.issues.filter((i) => i.level === 'missing')).toHaveLength(4);
  });

  it('探针按路径判定：存在的路径不报 missing', () => {
    const partial: ExistsProbe = (p) => p === paths.skillsGlobalDir;
    const report = checkBootstrap(makeCfg(), paths, partial);
    expect(report.issues.map((i) => i.id)).toEqual(
      expect.arrayContaining(['global-config', 'workspace-config', 'skills-workspace']),
    );
    expect(report.issues.some((i) => i.id === 'skills-global')).toBe(false);
  });
});
