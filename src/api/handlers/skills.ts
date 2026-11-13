// /skill 命令资源化端点（Task-20261016-002 §3.6）
//
// 直调 skillLoader + installSkillDirs / removeSkills / scanSkillsDir（独立模块，D3 直调），CLI 命令层零改动。
// D5：CLI 同名冲突 askConfirm 由请求体 overwrite: true 显式承接（缺省 false → 409）；
//     remove 的逐项确认由 DELETE 动词承接（无两段式）。
// 装完/删完自动 reload（与 CLI D6 一致），列表立即可见。
//
// 需求 20261112-008（D5）：skill 目录收敛为全局唯一一份（~/.loop-agent/skills），
// scope 参数仅用于给出可纠正的 400；响应中的 scope 字段保留恒 'global'。

import { basename, dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { installSkillDirs, removeSkills, scanSkillsDir } from '../../skill/index.js';
import { readZipEntries } from '../../skill/zip.js';
import type { HandlerContext, Route } from '../router.js';
import { ApiHttpError } from '../errors.js';
import { readJsonBody, sendJson } from '../http-utils.js';
import { assertGlobalScope, queryScope } from './config.js';

/** 上传安装：zip 包大小上限（20MB）与请求体上限（base64 约 +33% + JSON 开销） */
const UPLOAD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const UPLOAD_BODY_MAX_BYTES = 28 * 1024 * 1024;

/**
 * 解析 skill 组 scope（需求 20261112-008 / D4/D5）：
 * 缺省 / auto / global → 全局；workspace → 400（附带替代写法）。
 */
function parseSkillScope(raw: unknown): 'global' {
  if (raw === undefined || raw === null || raw === '' || raw === 'auto' || raw === 'global') {
    return 'global';
  }
  assertGlobalScope(raw); // 命中 workspace 或非法值时抛 400
  return 'global';
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
  parseSkillScope(body.scope);
  const overwrite = body.overwrite === true;

  const targetRoot = ctx.skillLoader.globalDir;

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
  if (result.installed.length > 0) ctx.skillLoader.reload();
  ctx.log(`[api] Skill 已安装: ${installed.name} → ${installed.targetDir}`);
  sendJson(res, 201, { name: installed.name, scope: 'global', path: installed.targetDir });
}

/** DELETE /skills/:name?scope=：删除已安装 Skill（全局唯一目录；成功自动 reload） */
async function handleDeleteSkill(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
): Promise<void> {
  parseSkillScope(queryScope(req));
  const globalDir = ctx.skillLoader.globalDir;
  const candidates = scanSkillsDir(globalDir, 'global');

  const result = await removeSkills([name], {
    skills: candidates,
    rootDir: globalDir,
    confirm: async () => true, // D6：DELETE 动词即确认
  });

  const removed = result.removed[0];
  if (removed) {
    ctx.skillLoader.reload();
    ctx.log(`[api] Skill 已删除: ${name}`);
    sendJson(res, 200, { deleted: true, name, scope: 'global', dir: removed.dir });
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
  const skills = ctx.skillLoader.reload();
  ctx.log(`[api] Skill 已重新扫描: ${skills.length} 个`);
  sendJson(res, 200, { loaded: skills.length });
}

/** 校验上传根目录名：单个安全目录段（即安装目录名，前端取 zip 文件名去 .zip） */
function safeRootName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiHttpError('bad_request', '请求体必须包含 rootName（所选目录名）');
  }
  const name = raw.trim();
  if (name.length > 128 || /[\\/]/.test(name) || name === '.' || name === '..' || /[<>:"|?*\0]/.test(name)) {
    throw new ApiHttpError('bad_request', `rootName 非法: "${name.slice(0, 64)}"`);
  }
  return name;
}

/**
 * POST /skills/upload：浏览器 zip 文件选择框上传安装（20261017-003 zip 版）。
 * body: { scope?, overwrite?, rootName(zip 文件名去 .zip), zipBase64 }
 * 流程：base64 解码（≤20MB，超限 413）→ readZipEntries 解析（加密/ZIP64/zip-slip/
 *      条目数/压缩炸弹防护，失败 400）→ 顶层共享前缀剥离 → 写临时目录 → 复用
 *      installSkillDirs（SKILL.md/frontmatter 校验 · 同名 409 · overwrite）→ 删临时目录 → 201。
 */
async function handleUploadSkill(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req, UPLOAD_BODY_MAX_BYTES);
  const rootName = safeRootName(body.rootName);
  parseSkillScope(body.scope);
  const overwrite = body.overwrite === true;

  const zipB64 = typeof body.zipBase64 === 'string' ? body.zipBase64 : '';
  if (!zipB64.trim()) throw new ApiHttpError('bad_request', '请求体必须包含 zipBase64（技能 zip 包的 base64）');
  if (!/^[A-Za-z0-9+/=\s]*$/.test(zipB64)) throw new ApiHttpError('bad_request', 'zipBase64 不是合法 base64');
  const zipBuf = Buffer.from(zipB64, 'base64');
  if (zipBuf.length === 0) throw new ApiHttpError('bad_request', 'zip 包内容为空');
  if (zipBuf.length > UPLOAD_MAX_TOTAL_BYTES) {
    throw new ApiHttpError('payload_too_large', `zip 包超过 ${UPLOAD_MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`);
  }

  let entries;
  try {
    entries = readZipEntries(zipBuf);
  } catch (e) {
    throw new ApiHttpError('bad_request', `zip 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  let files = entries.filter((e) => !e.isDir);
  if (files.length === 0) throw new ApiHttpError('bad_request', 'zip 包内没有文件');
  // 顶层共享前缀剥离：全部文件条目共享第一段目录时剥掉，使安装目录名 = zip 文件名（去 .zip）
  const first = files[0].segs[0];
  if (files.every((e) => e.segs.length >= 2 && e.segs[0] === first)) {
    files = files.map((e) => ({ ...e, segs: e.segs.slice(1) }));
  }

  const targetRoot = ctx.skillLoader.globalDir;

  // 写临时目录后复用安装链（校验/同名/覆盖/护栏全部白得），finally 清理
  const tmp = await mkdtemp(join(tmpdir(), 'skill-upload-'));
  try {
    const skillDir = join(tmp, rootName);
    for (const f of files) {
      const dest = join(skillDir, ...f.segs);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.data);
    }
    const result = await installSkillDirs([skillDir], {
      targetRoot,
      confirmOverwrite: async () => overwrite, // D5：同名冲突确认由 overwrite 参数承接
    });

    const failed = result.failed[0];
    if (failed) {
      if (failed.reason.includes('已存在同名目录')) {
        throw new ApiHttpError('conflict', `已存在同名 Skill「${basename(failed.path)}」，可传 overwrite: true 覆盖`);
      }
      throw new ApiHttpError('bad_request', `Skill 安装失败: ${failed.reason}`);
    }

    const installed = result.installed[0];
    ctx.skillLoader.reload();
    ctx.log(`[api] Skill 已上传安装: ${installed.name} → ${installed.targetDir}`);
    sendJson(res, 201, { name: installed.name, scope: 'global', path: installed.targetDir });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function skillRoutes(): Route[] {
  return [
    { method: 'GET', path: '/skills', handler: (ctx, _req, res) => handleListSkills(ctx, _req, res) },
    { method: 'POST', path: '/skills/reload', handler: (ctx, _req, res) => handleReloadSkills(ctx, _req, res) },
    { method: 'POST', path: '/skills/upload', handler: (ctx, req, res) => handleUploadSkill(ctx, req, res) },
    { method: 'GET', path: '/skills/:name', handler: (ctx, _req, res, p) => handleGetSkill(ctx, res, p.name) },
    { method: 'POST', path: '/skills', handler: (ctx, req, res) => handleCreateSkill(ctx, req, res) },
    { method: 'DELETE', path: '/skills/:name', handler: (ctx, req, res, p) => handleDeleteSkill(ctx, req, res, p.name) },
  ];
}
