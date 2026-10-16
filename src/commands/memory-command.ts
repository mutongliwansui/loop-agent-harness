// /memory 命令处理器
// 支持: status, curated (list/read/append/dedupe), episodic (list/read), search, dream, gate, init
import type { CuratedFileKey } from '../memory/index.js';
import { COLORS } from '../ui/colors.js';
import type { CommandContext, CommandHandler } from './registry.js';

export const memoryCommand: CommandHandler = {
  name: '/memory',
  description: '记忆管理（status/curated/episodic/search/dream/gate/init）',
  subcommands: ['status', 'curated', 'episodic', 'search', 'dream', 'gate', 'init', 'help'],
  subcommandHelp: {
    status: '查看记忆系统状态（L1/L2/L3 统计）',
    curated: 'L3 核心记忆：list / read <soul|user|memory> / append <key> <内容>',
    episodic: 'L2 情景记忆：list / read <YYYY-MM-DD>',
    search: '跨层检索记忆（/memory search <关键词>）',
    dream: '触发记忆整理（/memory dream [天数]）',
    gate: '查看记忆晋升门控状态（待确认 / 已达阈值）',
    init: '初始化记忆目录结构',
  },
  match: (input) => input.toLowerCase().startsWith('/memory'),
  async execute(input, ctx) {
    const { out, agent, configLoader } = ctx;
    const parts = input.split(/\s+/);
    const sub = parts[1] ?? 'status';
    const args = parts.slice(2);

    const epiMemory = agent.episodicMemory;
    const curMemory = agent.curatedMemory;

    // status 命令 - 不需要 memory 启用
    if (sub === 'status') {
      const enabled = agent.memoryEnabled;
      out.blank();
      out.log(`${COLORS.bold}记忆系统状态:${COLORS.reset}`);
      out.log(`  ${COLORS.cyan}启用状态:${COLORS.reset} ${enabled ? `${COLORS.green}✓ 已启用${COLORS.reset}` : `${COLORS.gray}✗ 未启用${COLORS.reset}`}`);

      if (enabled) {
        if (epiMemory) {
          const dir = epiMemory.getMemoryDir();
          const days = await epiMemory.listDays();
          out.log(`  ${COLORS.cyan}L2 情景记忆:${COLORS.reset} ${days.length} 天 (路径: ${dir})`);
        }
        if (curMemory) {
          const paths = curMemory.getFilePaths();
          out.log(`  ${COLORS.cyan}L3 核心记忆:${COLORS.reset} ${Object.values(paths).length} 个文件`);
          for (const [key, path] of Object.entries(paths)) {
            out.log(`    - ${COLORS.bold}${key}${COLORS.reset}: ${path}`);
          }
        }
        const { config: cfg } = configLoader.load();
        out.log(`  ${COLORS.cyan}工作记忆 L1:${COLORS.reset} maxTokens=${cfg.memory.working.maxTokens}, threshold=${cfg.memory.working.compactionThreshold}`);
      }
      out.blank();
      return;
    }

    if (!agent.memoryEnabled) {
      out.log(`${COLORS.yellow}⚠ 记忆系统未启用，请在配置中设置 memory.enabled=true${COLORS.reset}`);
      out.blank();
      return;
    }

    // curated 子命令
    if (sub === 'curated') {
      if (!curMemory) {
        out.log(`${COLORS.red}L3 Curated Memory 未初始化${COLORS.reset}`);
        out.blank();
        return;
      }
      const curSub = args[0] ?? 'list';
      const curArgs = args.slice(1);

      if (curSub === 'list') {
        out.blank();
        out.log(`${COLORS.bold}L3 Curated 核心记忆文件:${COLORS.reset}`);
        const paths = curMemory.getFilePaths();
        for (const [key, path] of Object.entries(paths)) {
          const content = await curMemory.read(key as CuratedFileKey);
          const lineCount = content.split('\n').length;
          const charCount = content.length;
          out.log(`  ${COLORS.bold}${key}${COLORS.reset} — ${path} (${lineCount} 行, ${charCount} 字符)`);
        }
        out.blank();
        return;
      }

      if (curSub === 'read') {
        if (curArgs.length === 0) {
          out.log(`${COLORS.red}用法: /memory curated read <soul|user|memory>${COLORS.reset}`);
          out.blank();
          return;
        }
        const fileKey = curArgs[0] as CuratedFileKey;
        const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
        if (!validKeys.includes(fileKey)) {
          out.log(`${COLORS.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${COLORS.reset}`);
          out.blank();
          return;
        }
        const content = await curMemory.read(fileKey);
        out.blank();
        out.log(`${COLORS.bold}📖 ${fileKey.toUpperCase()}.md${COLORS.reset}`);
        out.log('─'.repeat(50));
        out.log(content || `${COLORS.gray}(空)${COLORS.reset}`);
        out.log('─'.repeat(50));
        out.blank();
        return;
      }

      if (curSub === 'append') {
        if (curArgs.length < 2) {
          out.log(`${COLORS.red}用法: /memory curated append <soul|user|memory> <内容>${COLORS.reset}`);
          out.blank();
          return;
        }
        const fileKey = curArgs[0] as CuratedFileKey;
        const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
        if (!validKeys.includes(fileKey)) {
          out.log(`${COLORS.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${COLORS.reset}`);
          out.blank();
          return;
        }
        const fact = curArgs.slice(1).join(' ');
        await curMemory.append(fileKey, fact);
        out.log(`${COLORS.green}✓ 已追加到 ${fileKey.toUpperCase()}.md: ${fact}${COLORS.reset}`);
        out.blank();
        return;
      }

      if (curSub === 'dedupe') {
        const fileKey = (curArgs[0] ?? 'memory') as CuratedFileKey;
        const validKeys: CuratedFileKey[] = ['soul', 'user', 'memory'];
        if (!validKeys.includes(fileKey)) {
          out.log(`${COLORS.red}无效的文件键: ${fileKey}，可选: ${validKeys.join(', ')}${COLORS.reset}`);
          out.blank();
          return;
        }
        out.log(`${COLORS.gray}正在使用 LLM 去重整理 ${fileKey.toUpperCase()}.md ...${COLORS.reset}`);
        const result = await agent.dedupeCuratedMemory(fileKey);
        if (!result) {
          const paths = curMemory.getFilePaths();
          out.log(`${COLORS.yellow}✗ 去重失败或 LLM 输出异常，文件保持原样${COLORS.reset}`);
          out.log(`${COLORS.gray}  （备份文件可能存在: ${paths[fileKey]}.dedupe.bak）${COLORS.reset}`);
          out.blank();
          return;
        }
        out.log(`${COLORS.green}✓ 去重完成: ${result.before} 行 → ${result.after} 行${COLORS.reset}`);
        out.log(`${COLORS.gray}  原文件备份: ${result.backup}${COLORS.reset}`);
        out.blank();
        return;
      }

      out.log(`${COLORS.red}未知 curated 子命令: ${curSub}。支持 list / read / append / dedupe${COLORS.reset}`);
      out.blank();
      return;
    }

    // episodic 子命令
    if (sub === 'episodic') {
      if (!epiMemory) {
        out.log(`${COLORS.red}L2 Episodic Memory 未初始化${COLORS.reset}`);
        out.blank();
        return;
      }
      const epiSub = args[0] ?? 'list';
      const epiArgs = args.slice(1);

      if (epiSub === 'list') {
        const summaries = await epiMemory.listDaySummaries();
        out.blank();
        out.log(`${COLORS.bold}L2 情景记忆日志 (${summaries.length} 天):${COLORS.reset}`);
        if (summaries.length === 0) {
          out.log(`  ${COLORS.gray}（暂无记录）${COLORS.reset}`);
        }
        for (const s of summaries) {
          out.log(`  ${COLORS.bold}${s.day}${COLORS.reset} — ${s.entryCount} 条记录, ${s.size} 字符`);
        }
        out.blank();
        return;
      }

      if (epiSub === 'read') {
        if (epiArgs.length === 0) {
          out.log(`${COLORS.red}用法: /memory episodic read <YYYY-MM-DD>${COLORS.reset}`);
          out.blank();
          return;
        }
        const day = epiArgs[0];
        const content = await epiMemory.readDay(day);
        if (!content) {
          out.log(`${COLORS.gray}日期 ${day} 无记录${COLORS.reset}`);
          out.blank();
          return;
        }
        out.blank();
        out.log(`${COLORS.bold}📅 ${day} 日志${COLORS.reset}`);
        out.log('─'.repeat(50));
        out.log(content);
        out.log('─'.repeat(50));
        out.blank();
        return;
      }

      out.log(`${COLORS.red}未知 episodic 子命令: ${epiSub}。支持 list / read${COLORS.reset}`);
      out.blank();
      return;
    }

    // search 命令
    if (sub === 'search') {
      if (!epiMemory) {
        out.log(`${COLORS.red}L2 Episodic Memory 未初始化，无法搜索${COLORS.reset}`);
        out.blank();
        return;
      }
      if (args.length === 0) {
        out.log(`${COLORS.red}用法: /memory search <关键词>${COLORS.reset}`);
        out.blank();
        return;
      }
      const query = args.join(' ');
      const results = await epiMemory.search(query, 5);
      out.blank();
      out.log(`${COLORS.bold}搜索结果 "${query}" (${results.length} 条):${COLORS.reset}`);
      if (results.length === 0) {
        out.log(`  ${COLORS.gray}（未找到相关记忆）${COLORS.reset}`);
      }
      for (const r of results) {
        out.log(`  ${COLORS.cyan}📅 ${r.day}${COLORS.reset} (score: ${r.score})`);
        out.log(`  ${COLORS.gray}${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    // init 命令
    if (sub === 'init') {
      if (!curMemory) {
        out.log(`${COLORS.red}L3 Curated Memory 未初始化${COLORS.reset}`);
        out.blank();
        return;
      }
      await curMemory.init();
      const paths = curMemory.getFilePaths();
      out.log(`${COLORS.green}✓ L3 Curated 文件已就绪:${COLORS.reset}`);
      for (const [key, path] of Object.entries(paths)) {
        out.log(`  - ${COLORS.bold}${key}${COLORS.reset}: ${path}`);
      }
      out.blank();
      return;
    }

    // dream 命令
    if (sub === 'dream') {
      const daysBack = args.length > 0 ? parseInt(args[0], 10) : undefined;
      if (daysBack !== undefined && (Number.isNaN(daysBack) || daysBack <= 0)) {
        out.log(`${COLORS.red}用法: /memory dream [天数]（默认读取配置）${COLORS.reset}`);
        out.blank();
        return;
      }
      const { config: cfg } = configLoader.load();
      if (!cfg.memory.dreaming.enabled) {
        out.log(`${COLORS.yellow}⚠ Dreaming 未启用，请在配置中设置 memory.dreaming.enabled=true${COLORS.reset}`);
        out.blank();
        return;
      }
      out.log(`${COLORS.cyan}⏳ Dreaming 巡检开始（最近 ${daysBack ?? cfg.memory.dreaming.daysBack} 天）...${COLORS.reset}`);
      try {
        const result = await agent.runDreaming(daysBack, (msg) => {
          out.log(`  ${COLORS.gray}↳ ${msg}${COLORS.reset}`);
        });
        if (!result) {
          out.log(`${COLORS.red}Dreaming 未初始化（请检查记忆系统状态）${COLORS.reset}`);
          out.blank();
          return;
        }
        out.blank();
        out.log(`${COLORS.bold}Dreaming 巡检结果:${COLORS.reset}`);
        out.log(`  ${COLORS.green}✓ 晋升 ${result.promoted.length} 条${COLORS.reset}`);
        for (const p of result.promoted) {
          out.log(`    - [${p.provenance}] ${p.fact} → ${p.targetFile}`);
        }
        if (result.skipped.length > 0) {
          out.log(`  ${COLORS.gray}⏸ 待确认 ${result.skipped.length} 条${COLORS.reset}`);
          const gate = agent.promotionGate;
          for (const s of result.skipped) {
            const count = gate?.getCount(s.fact) ?? 0;
            out.log(`    - [${s.provenance}] ${s.fact} (确认 ${count} 次)`);
          }
        }
        if (result.errors.length > 0) {
          out.log(`  ${COLORS.yellow}⚠ 错误 ${result.errors.length} 条${COLORS.reset}`);
          for (const e of result.errors) {
            out.log(`    - ${e}`);
          }
        }
        if (result.promoted.length === 0 && result.skipped.length === 0) {
          out.log(`  ${COLORS.gray}（近期无值得晋升的记忆）${COLORS.reset}`);
        }
        out.blank();
      } catch (e) {
        out.error(`${COLORS.red}Dreaming 执行异常: ${e instanceof Error ? e.message : String(e)}${COLORS.reset}`);
        out.blank();
      }
      return;
    }

    // gate 命令
    if (sub === 'gate') {
      const gate = agent.promotionGate;
      if (!gate) {
        out.log(`${COLORS.red}Promotion Gate 未初始化${COLORS.reset}`);
        out.blank();
        return;
      }
      const pending = gate.listPending();
      const approved = gate.listApproved();
      out.blank();
      out.log(`${COLORS.bold}Promotion Gate 状态:${COLORS.reset}`);
      out.log(`  ${COLORS.cyan}待确认事实:${COLORS.reset} ${pending.length} 条`);
      for (const p of pending) {
        out.log(`    - [${p.provenance}] ×${p.count} ${p.fact} → ${p.targetFile} (首次: ${p.firstSeen.slice(0, 10)})`);
      }
      out.log(`  ${COLORS.green}已达阈值待晋升:${COLORS.reset} ${approved.length} 条`);
      for (const a of approved) {
        out.log(`    - [${a.provenance}] ×${a.count} ${a.fact} → ${a.targetFile}`);
      }
      out.log(`  ${COLORS.gray}提示: 已达阈值的事实会在下次 /memory dream 时写入 L3${COLORS.reset}`);
      out.blank();
      return;
    }

    out.log(`${COLORS.red}未知 /memory 子命令: ${sub}。支持 status / curated / episodic / search / dream / gate / init${COLORS.reset}`);
    out.blank();
  },
};
