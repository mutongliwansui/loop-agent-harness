// /upload 命令处理器（Task-20261012-001）
// 支持: <路径...>（拖拽/手输，跨平台归一）、无参弹系统文件选择框、list、clean
// 上传 = 复制到 ~/.loop-agent/uploads/{sessionId}/ 并注入会话上下文（Agent 下一轮感知）
import type { CommandContext, CommandHandler } from './registry.js';
import { COLORS } from '../ui/colors.js';
import {
  buildContextNote,
  cleanUploads,
  copyToUploads,
  defaultUploadsRoot,
  formatBytes,
  listUploads,
  parseUploadArgs,
  pickFilesViaDialog,
} from '../upload/manager.js';

/** 取命令名之后的参数原文（保留引号，交给 parseUploadArgs 归一） */
function argText(input: string): string {
  const m = input.trim().match(/^\/upload\b(.*)$/i);
  return (m?.[1] ?? '').trim();
}

/** 确保活动会话存在：无会话时按需创建（D10）
 *  覆盖 /reset、/session new、delete 当前、delete-all、首次安装五条置空路径；
 *  判定以 agent.currentSessionId 为准（SessionStore.currentSessionId 在 reset 后是陈旧值）；
 *  会话功能不可用（sessionStore=null）返回 null */
async function ensureSessionKey(ctx: CommandContext): Promise<string | null> {
  if (ctx.agent.currentSessionId) return ctx.agent.currentSessionId;
  if (!ctx.sessionStore) return null;
  const meta = await ctx.sessionStore.createSession('[文件上传]', [], []);
  ctx.agent.setCurrentSessionId(meta.id);
  return meta.id;
}

/** 会话功能不可用时的统一提示 */
function warnNoSession(ctx: CommandContext): void {
  ctx.out.log(`${COLORS.red}✗ 会话功能未启用（sessionStore 不可用），无法执行文件上传${COLORS.reset}`);
  ctx.out.blank();
}

/** 共用上传链路：复制 → 清单渲染 → 注入上下文 */
async function doUpload(ctx: CommandContext, paths: string[]): Promise<void> {
  const { out, agent } = ctx;
  const sessionKey = await ensureSessionKey(ctx);
  if (!sessionKey) {
    warnNoSession(ctx);
    return;
  }
  const result = await copyToUploads(paths, { sessionKey });
  out.blank();
  for (const e of result.succeeded) {
    out.log(`${COLORS.green}✓ ${e.originalPath}${COLORS.reset}`);
    out.log(`  ${COLORS.gray}→ ${e.targetPath}（${formatBytes(e.bytes)}）${COLORS.reset}`);
  }
  for (const f of result.failed) {
    out.log(`${COLORS.red}✗ ${f.path}：${f.reason}${COLORS.reset}`);
  }
  if (result.succeeded.length > 0) {
    for (const e of result.succeeded) agent.appendContextNote(buildContextNote(e));
    out.log(`${COLORS.gray}已注入会话上下文，可直接提问，Agent 将使用上述文件${COLORS.reset}`);
  }
  out.blank();
}

/** /upload list：列出当前会话上传文件（文件名剥时间戳前缀显示原名） */
async function runList(ctx: CommandContext): Promise<void> {
  const { out } = ctx;
  const sessionKey = await ensureSessionKey(ctx);
  if (!sessionKey) {
    warnNoSession(ctx);
    return;
  }
  const entries = await listUploads(defaultUploadsRoot(), sessionKey);
  out.blank();
  if (entries.length === 0) {
    out.log(`${COLORS.gray}当前会话暂无上传文件（拖拽文件到终端或 /upload <路径>）${COLORS.reset}`);
    out.blank();
    return;
  }
  out.log(`${COLORS.bold}当前会话上传文件（${entries.length}）:${COLORS.reset}`);
  for (const e of entries) {
    const original = e.fileName.replace(/^\d{8}-\d{6}(?:-\d{1,3}(?:-\d+)?)?-/, '');
    const time = e.uploadedAt.replace('T', ' ').slice(0, 19);
    out.log(
      `  ${COLORS.white}${original}${COLORS.reset}${COLORS.gray}  ${formatBytes(e.bytes)}  ${time}${COLORS.reset}`,
    );
    out.log(`    ${COLORS.gray}${e.targetPath}${COLORS.reset}`);
  }
  out.blank();
}

/** /upload clean：y/n 确认后清理当前会话上传目录 */
async function runClean(ctx: CommandContext): Promise<void> {
  const { out, rl } = ctx;
  const sessionKey = await ensureSessionKey(ctx);
  if (!sessionKey) {
    warnNoSession(ctx);
    return;
  }
  // 统一走 ctx.askConfirm，禁止新建临时 readline（其 close 会 pause 共享 stdin 导致进程退出）
  const q = await ctx.askConfirm(
    `${COLORS.yellow}确认清理当前会话的全部上传文件？(y/N):${COLORS.reset} `,
  );
  if (!q) {
    out.log(`${COLORS.gray}已取消${COLORS.reset}`);
    out.blank();
    return;
  }
  const removed = await cleanUploads(defaultUploadsRoot(), sessionKey);
  out.blank();
  out.log(
    removed
      ? `${COLORS.green}✓ 已清理当前会话的上传文件${COLORS.reset}`
      : `${COLORS.gray}当前会话无上传文件${COLORS.reset}`,
  );
  out.blank();
  void rl;
}

export const uploadCommand: CommandHandler = {
  name: '/upload',
  description: '文件上传（复制到会话隔离上传目录并注入上下文）',
  subcommands: ['list', 'clean'],
  match: (input) => /^\/upload(?:\s|$)/i.test(input.trim()),
  async execute(input, ctx) {
    const { out } = ctx;
    const rest = argText(input);

    if (rest === '' ) {
      // 无参：弹出系统文件选择框（跨平台探测链，模态等待）
      out.blank();
      out.log(`${COLORS.gray}正在打开文件选择框…（关闭对话框后继续）${COLORS.reset}`);
      const picked = await pickFilesViaDialog();
      if (picked.paths.length === 0) {
        out.blank();
        if (picked.reason === 'unavailable') {
          out.log(`${COLORS.yellow}⚠ 当前环境无可用文件选择框，可拖拽文件到终端或使用 /upload <路径>${COLORS.reset}`);
        } else {
          out.log(`${COLORS.gray}已取消${COLORS.reset}`);
        }
        out.blank();
        return;
      }
      await doUpload(ctx, picked.paths);
      return;
    }

    const first = rest.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (first === 'list') {
      await runList(ctx);
      return;
    }
    if (first === 'clean') {
      await runClean(ctx);
      return;
    }

    // 带路径参数：跨平台归一后上传
    const paths = parseUploadArgs(rest);
    if (paths.length === 0) {
      out.blank();
      out.log(`${COLORS.yellow}用法: /upload <路径...>（可拖拽文件进终端）| /upload list | /upload clean${COLORS.reset}`);
      out.blank();
      return;
    }
    await doUpload(ctx, paths);
  },
};
