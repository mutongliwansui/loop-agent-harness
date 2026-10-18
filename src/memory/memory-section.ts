// L2 记忆注入前缀的拼接/剥离（单一出处，供 ContextAssembler 与 SessionStore 共用，避免循环依赖）
//
// ContextAssembler.assemble 会把检索到的历史记忆拼接到首条 user 消息 content 前面，
// 前缀以 "---" 哨兵结尾——memoryBlock 内可能含空行，不能按首个空行切分。

/** 记忆前缀的固定头部（不含 memoryBlock） */
const MEMORY_SECTION_HEAD = '## 相关历史记忆\n以下是你在之前会话中积累的相关信息，请参考：\n';

/** 记忆前缀的固定尾部（哨兵分隔线） */
const MEMORY_SECTION_TAIL = '\n\n---\n\n';

/** 拼接记忆前缀：`memorySection(memoryBlock) + 原始 content` */
export function withMemorySection(memoryBlock: string, content: string): string {
  return `${MEMORY_SECTION_HEAD}${memoryBlock}${MEMORY_SECTION_TAIL}${content}`;
}

/**
 * 剥离 L2 记忆注入前缀，还原用户原始输入。
 * 用于会话标题生成、前端展示清洗等需要「纯净首问」的场景；未命中前缀时原样返回。
 * 循环剥离：存量数据存在嵌套前缀（旧版被污染的 user 消息进入了记忆库，
 * 检索后又带着完整前缀拼回新消息），单层剥离剥不干净。
 */
export function stripMemorySection(content: string): string {
  let cur = content;
  while (cur.startsWith(MEMORY_SECTION_HEAD)) {
    const tailIdx = cur.indexOf(MEMORY_SECTION_TAIL, MEMORY_SECTION_HEAD.length);
    if (tailIdx < 0) break;
    cur = cur.slice(tailIdx + MEMORY_SECTION_TAIL.length);
  }
  return cur;
}
