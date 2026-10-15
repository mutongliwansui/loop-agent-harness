// /session 命令处理器
// 支持: list, load <id>, save, new, current, delete <id>, delete-all
import { buildSystemPrompt } from '../agent/prompt.js';
import { SessionStore, keychain } from '../session/index.js';
import { COLORS } from '../ui/colors.js';
import { renderMessages } from '../ui/renderer.js';
import type { CommandContext, CommandHandler } from './registry.js';
import { cleanAllUploads, cleanUploads, defaultUploadsRoot } from '../upload/manager.js';

export const sessionCommand: CommandHandler = {
  name: '/session',
  description: '会话管理（list/load/save/new/current/delete/delete-all）',
  subcommands: ['list', 'load', 'save', 'new', 'current', 'delete', 'delete-all'],
  match: (input) => input.toLowerCase().startsWith('/session'),
  async execute(input, ctx) {
    const { out, agent, configLoader, skillLoader, sessionStore, rl } = ctx;

    if (!sessionStore) {
      out.log(`${COLORS.red}会话系统未启用（autoSave 与 autoRestore 均为 false）${COLORS.reset}`);
      out.blank();
      return;
    }
    if (sessionStore.isEncrypted && !keychain.isUnlocked()) {
      out.log(`${COLORS.red}会话系统未解锁${COLORS.reset}`);
      out.blank();
      return;
    }

    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'list';
    const args = parts.slice(2);

    if (sub === 'list') {
      const sessions = await sessionStore.listSessions();
      out.blank();
      out.log(`${COLORS.bold}当前工作空间会话 (${sessions.length} 个):${COLORS.reset}`);
      if (sessions.length === 0) {
        out.log(`  ${COLORS.gray}（暂无会话）${COLORS.reset}`);
      }
      for (const s of sessions) {
        const isCurrent = s.id === agent.currentSessionId;
        const mark = isCurrent ? ` ${COLORS.green}[当前]${COLORS.reset}` : '';
        const date = new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false });
        out.log(`  ${COLORS.bold}${s.id}${COLORS.reset}${mark} ${COLORS.gray}${date}${COLORS.reset} [${s.messageCount}条] ${s.title}`);
      }
      out.blank();
      return;
    }

    if (sub === 'current') {
      const id = agent.currentSessionId;
      if (!id) {
        out.log(`${COLORS.gray}当前无活跃会话${COLORS.reset}`);
        out.blank();
        return;
      }
      const sessions = await sessionStore.listSessions();
      const meta = sessions.find((s) => s.id === id);
      if (meta) {
        out.blank();
        out.log(`${COLORS.bold}当前会话:${COLORS.reset}`);
        out.log(`  ID: ${COLORS.bold}${meta.id}${COLORS.reset}`);
        out.log(`  标题: ${meta.title}`);
        out.log(`  消息数: ${meta.messageCount}`);
        out.log(`  创建时间: ${new Date(meta.createdAt).toLocaleString('zh-CN')}`);
        out.log(`  更新时间: ${new Date(meta.updatedAt).toLocaleString('zh-CN')}`);
        out.blank();
      }
      return;
    }

    if (sub === 'load') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /session load <id>${COLORS.reset}`);
        out.blank();
        return;
      }
      const id = args[0];
      try {
        const data = await sessionStore.loadSession(id);
        const { config: loadCfg } = configLoader.load();
        const skills = loadCfg.skill.enabled ? skillLoader.scan(process.cwd()) : [];
        const systemPrompt = loadCfg.agent.systemPrompt ?? buildSystemPrompt(skills);
        agent.restoreSession(data, systemPrompt);
        const restoreMessages = SessionStore.getRestoreMessages(data);
        renderMessages(restoreMessages);
      } catch (e) {
        out.error(`${COLORS.red}✗ 加载失败: ${e instanceof Error ? e.message : String(e)}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    if (sub === 'save') {
      const msgs = agent.getSessionMessages();
      if (msgs.length === 0) {
        out.log(`${COLORS.yellow}无消息可保存${COLORS.reset}`);
        out.blank();
        return;
      }
      try {
        if (agent.currentSessionId) {
          await sessionStore.updateSession(agent.currentSessionId, msgs, []);
          out.log(`${COLORS.green}✓ 会话已更新: ${agent.currentSessionId}${COLORS.reset}`);
          out.blank();
        } else {
          const userMsg = msgs.find((m) => m.role === 'user')?.content ?? '新会话';
          const meta = await sessionStore.createSession(
            typeof userMsg === 'string' ? userMsg : '新会话',
            msgs,
            [],
          );
          agent.setCurrentSessionId(meta.id);
          out.log(`${COLORS.green}✓ 会话已保存: ${meta.id}${COLORS.reset}`);
          out.blank();
        }
      } catch (e) {
        out.error(`${COLORS.red}✗ 保存失败: ${e instanceof Error ? e.message : String(e)}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    if (sub === 'new') {
      agent.resetSession();
      out.log(`${COLORS.green}✓ 已创建新会话（首个对话或文件上传后落盘）${COLORS.reset}`);
      out.blank();
      return;
    }

    if (sub === 'delete') {
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /session delete <id>${COLORS.reset}`);
        out.blank();
        return;
      }
      const id = args[0];
      try {
        await sessionStore.deleteSession(id);
        if (agent.currentSessionId === id) {
          agent.setCurrentSessionId(null);
        }
        // 连带清理该会话的上传目录（Task-20261012-001 D7）
        const removedUploads = await cleanUploads(defaultUploadsRoot(), id).catch(() => false);
        out.log(`${COLORS.green}✓ 会话已删除: ${id}${COLORS.reset}`);
        if (removedUploads) {
          out.log(`${COLORS.gray}  已同步清理该会话的上传文件${COLORS.reset}`);
        }
        out.blank();
      } catch (e) {
        out.error(`${COLORS.red}✗ 删除失败: ${e instanceof Error ? e.message : String(e)}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    if (sub === 'delete-all') {
      // 统一走 ctx.askConfirm，禁止新建临时 readline（其 close 会 pause 共享 stdin 导致进程退出）
      const q = await ctx.askConfirm(
        `${COLORS.red}确认删除当前工作空间的所有会话？(y/N):${COLORS.reset} `,
      );
      if (!q) {
        out.log(`${COLORS.gray}已取消${COLORS.reset}`);
        out.blank();
        return;
      }
      try {
        await sessionStore.deleteAllSessions();
        // 连带清理全部会话上传目录（Task-20261012-001 D7）
        await cleanAllUploads(defaultUploadsRoot()).catch(() => {});
        agent.resetSession();
        out.log(`${COLORS.green}✓ 所有会话已删除${COLORS.reset}`);
        out.blank();
      } catch (e) {
        out.error(`${COLORS.red}✗ 删除失败: ${e instanceof Error ? e.message : String(e)}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    out.log(`${COLORS.red}未知 /session 子命令: ${sub}。支持 list / load / save / new / current / delete / delete-all${COLORS.reset}`);
    out.blank();
    void rl;
  },
};
