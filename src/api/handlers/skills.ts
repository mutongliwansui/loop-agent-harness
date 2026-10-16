// /skill 命令资源化端点（Task-20261016-002 §3.6）
//
// 直调 skillLoader + installSkillDirs / removeSkills / scanSkillsDir（独立模块，D3 直调），CLI 命令层零改动。
// D5：CLI 同名冲突 askConfirm 由请求体 overwrite: true 显式承接（缺省 false → 409）；
//     remove 的逐项确认由 DELETE 动词承接（无两段式）。
// 装完/删完自动 reload（与 CLI D6 一致），列表立即可见。

import { basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { installSkillDirs, removeSkills, scanSkillsDir } from '../../skill/index.js';
import type { SkillScope } from '../../skill/types.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { queryScope } from './config.js';

const SKILL_SCOPES: ReadonlySet<string> = new Set(['auto', 'workspace', 'global']);

/** 解析 skill 组 scope：auto（workspace 优先 → 全局 fallback）| workspace | global；非法 → 400 */
function parseSkillScope(raw: unknown): 'auto' | SkillScope {
  if (raw === undefined || raw === null || raw === '') return 'auto';
  if (typeof raw === 'string' && SKILL_SCOPES.has(raw)) return raw as 'auto' | SkillScope;
  throw new ApiHttpError('bad_request', `scope 必须为 auto | workspace | global，收到: ${String(raw)}`);
}

/** GET /skills：合并视图（全局先扫、工作空间覆盖，与 SkillLoader.scan 同款） */
async function handleListSkills(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const skills = ctx.skillLoader.list().map((s) => ({
    name: s.name,
    description: s.description,
    scope: s.scope,
    path: s.path,
  }));
  sendJson(res, 200, { skills });
}

/** GET /skills/:name：元数据 + 正文 body（404 未找到） */
async function handleGetSkill(ctx: HandlerContext, res: ServerResponse, name: string): Promise<void> {
  const content = ctx.skillLoader.load(name);
  if (!content) throw new ApiHttpError('not_found', `Skill "${name}" 未找到`);
  sendJson(res, 200, {
    name: content.metadata.name,
    description: content.metadata.description,
    scope: content.metadata.scope,
    path: content.metadata.path,
    body: content.body,
  });
}

/** POST /skills：安装 Skill 目录（校验失败 400；同名未 overwrite 409；成功 201 + 自动 reload） */
async function handleCreateSkill(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req);
  const sourcePath = typeof body.sourcePath === 'string' ? body.sourcePath.trim() : '';
  if (!sourcePath) throw new ApiHttpError('bad_request', '请求体必须包含 sourcePath（Skill 目录路径）');
  const scope: SkillScope = body.scope === 'global' ? 'global' : 'workspace';
  const overwrite = body.overwrite === true;

  const targetRoot = scope === 'global'
    ? ctx.skillLoader.globalDir
    : ctx.skillLoader.getWorkspaceDir(process.cwd());

  // D5：同名冲突确认由 overwrite 参数承接（true 直接覆盖，false 拒绝）
  const result = await installSkillDirs([sourcePath], {
    targetRoot,
    confirmOverwrite: async () => overwrite,
  });

  const failed = result.failed[0];
  if (failed) {
    if (failed.reason.includes('已存在同名目录')) {
      throw new ApiHttpError('conflict', `已存在同名 Skill「${basename(failed.path)}」，可传 overwrite: true 覆盖`);
    }
    throw new ApiHttpError('bad_request', `Skill 安装失败: ${failed.reason}`);
  }

  const installed = result.installed[0];
  if (result.installed.length > 0) ctx.skillLoader.reload(process.cwd());
  ctx.log(`[api] Skill 已安装（${scope}）: ${installed.name} → ${installed.targetDir}`);
  sendJson(res, 201, { name: installed.name, scope, path: installed.targetDir });
}

/** DELETE /skills/:name?scope=：删除已安装 Skill（auto=工作空间优先 → 全局；成功自动 reload） */
async function handleDeleteSkill(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  const scope = parseSkillScope(queryScope(req));
  const globalDir = ctx.skillLoader.globalDir;
  const workspaceDir = ctx.skillLoader.getWorkspaceDir(process.cwd());
  // auto 需同时看到两层（list() 合并视图会遮蔽同名全局项），直接扫两个目录（与 CLI remove 同款）
  const candidates = [...scanSkillsDir(workspaceDir, 'workspace'), ...scanSkillsDir(globalDir, 'global')];

  const result = await removeSkills([name], {
    skills: candidates,
    scope,
    globalDir,
    workspaceDir,
    confirm: async () => true, // D6：DELETE 动词即确认
  });

  const removed = result.removed[0];
  if (removed) {
    ctx.skillLoader.reload(process.cwd());
    ctx.log(`[api] Skill 已删除（${removed.scope}）: ${name}`);
    sendJson(res, 200, { deleted: true, name, scope: removed.scope, dir: removed.dir });
    return;
  }
  const failed = result.failed[0];
  if (failed && failed.reason.includes('未找到已安装的 Skill')) {
    throw new ApiHttpError('not_found', `Skill「${name}」未找到已安装项`);
  }
  throw new ApiHttpError('bad_request', `Skill 删除失败: ${failed?.reason ?? '未知原因'}`);
}

/** POST /skills/reload：重新扫描 Skill 目录 */
async function handleReloadSkills(ctx: HandlerContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  const skills = ctx.skillLoader.reload(process.cwd());
  ctx.log(`[api] Skill 已重新扫描: ${skills.length} 个`);
  sendJson(res, 200, { loaded: skills.length });
}

export function skillRoutes(): Route[] {
  return [
    { method: 'GET', path: '/skills', handler: (ctx, _req, res) => handleListSkills(ctx, _req, res) },
    { method: 'POST', path: '/skills/reload', handler: (ctx, _req, res) => handleReloadSkills(ctx, _req, res) },
    { method: 'GET', path: '/skills/:name', handler: (ctx, _req, res, p) => handleGetSkill(ctx, res, p.name) },
    { method: 'POST', path: '/skills', handler: (ctx, req, res) => handleCreateSkill(ctx, req, res) },
    { method: 'DELETE', path: '/skills/:name', handler: (ctx, req, res, p) => handleDeleteSkill(ctx, req, res, p.name) },
  ];
}
