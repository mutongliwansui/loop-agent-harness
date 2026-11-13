import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 后端可执行文件在安装产物中的统一名字（任务 04 由 extraResources 拷贝并改名） */
export const BACKEND_EXE_NAME = 'loop-agent-core.exe';

/** 后端目标：要么是现成的 exe，要么是开发期回落 tsx */
export type BackendTarget =
  | { kind: 'exe'; exePath: string }
  | { kind: 'tsx'; entryPath: string; repoRoot: string };

/** 找不到后端程序时抛出，携带已查找路径以便错误窗原样展示 */
export class BackendNotFoundError extends Error {
  readonly searched: string[];

  constructor(searched: string[]) {
    super('未找到后端程序');
    this.name = 'BackendNotFoundError';
    this.searched = searched;
  }
}

export interface ResolveBackendOpts {
  /** app.isPackaged */
  isPackaged: boolean;
  /** process.resourcesPath（安装后为 <安装目录>/resources） */
  resourcesPath: string;
  /** 壳 exe 所在目录（便携版后端与之同级） */
  exeDir: string;
  /** 仓库根目录（开发期定位 dist-sea 与 src/index.ts） */
  repoRoot: string;
  /** 平台分隔符，单测注入用，默认 win32 语义由 path.join 决定 */
  join?: (...parts: string[]) => string;
}

/**
 * 按 D1-5 的顺序定位后端程序：
 *
 *   1) 打包后：   <resourcesPath>/loop-agent-core.exe
 *   2) 便携模式： <exeDir>/loop-agent-core.exe（打包后但未走安装器时的布局）
 *   3) 开发期：   <repoRoot>/dist-sea/loop-agent.exe
 *   4) 开发期回落：<repoRoot>/src/index.ts（交 tsx 启动，免 rebuild）
 *   5) 都没有 → BackendNotFoundError（附全部查找路径）
 *
 * 注意 1) 与 2) 都对 isPackaged 成立：electron-builder 的 extraResources 落 resources/，
 * 而便携版可能把 exe 与壳放在同一层，故两者都要试，顺序上优先 resources/。
 */
export function resolveBackend(opts: ResolveBackendOpts): BackendTarget {
  const j = opts.join ?? join;
  const searched: string[] = [];

  const candidates: string[] = [];
  if (opts.isPackaged) {
    candidates.push(j(opts.resourcesPath, BACKEND_EXE_NAME));
  }
  candidates.push(j(opts.exeDir, BACKEND_EXE_NAME));
  candidates.push(j(opts.repoRoot, 'dist-sea', 'loop-agent.exe'));

  for (const candidate of candidates) {
    searched.push(candidate);
    if (existsSync(candidate)) return { kind: 'exe', exePath: candidate };
  }

  // 开发期回落 tsx：不假定构建机已跑过 build:sea
  const tsxEntry = j(opts.repoRoot, 'src', 'index.ts');
  searched.push(tsxEntry);
  if (!opts.isPackaged && existsSync(tsxEntry)) {
    return { kind: 'tsx', entryPath: tsxEntry, repoRoot: opts.repoRoot };
  }

  throw new BackendNotFoundError(searched);
}
