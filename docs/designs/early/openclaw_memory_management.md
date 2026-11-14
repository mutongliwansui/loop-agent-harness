# OpenClaw 风格记忆管理方案

> 基于 OpenClaw 的 Tier Model（分层信任模型），结合 ReAct Agent 循环，设计一套**文件即真相源、向量库只做索引**的记忆管理方案。

---

## 1. 设计总览

### 1.1 核心思想

OpenClaw 的记忆管理有三条铁律：

1. **文件是真相源（Markdown），SQLite 只是索引** —— 向量库挂了不能丢记忆
2. **写路径和读路径分离** —— 回复时只检索，不抽取；抽取放到后台 Dreaming 阶段
3. **晋升有闸门（Promotion Gate）** —— 不是所有信息都配进长期记忆，来源可信度决定去留

### 1.2 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                  L1 Working Memory                     │
│          (当前 ReAct 循环的 messages 数组)               │
│          TTL: 单次任务运行期                             │
│          超阈值 → pre-compaction flush → L2             │
└──────────────────┬──────────────────────────────────────┘
                   │ flush (确定性触发)
                   ▼
┌─────────────────────────────────────────────────────────┐
│                L2 Episodic Memory                      │
│          (memory/YYYY-MM-DD.md 按天分文件)              │
│          TTL: 长期留存，不自动注入 context               │
│          访问方式: memory_search() 按需召回              │
│          晋升条件: Dreaming 巡检 + Promotion Gate        │
└──────────────────┬──────────────────────────────────────┘
                   │ promote (后台异步)
                   ▼
┌─────────────────────────────────────────────────────────┐
│              L3 Curated Core Memory                    │
│     (MEMORY.md / USER.md / SOUL.md 精炼常驻文件)        │
│     TTL: 永久，会话启动常驻注入 system prompt            │
│     内容: 用户偏好、关键事实、Agent 人格/行为准则         │
└─────────────────────────────────────────────────────────┘
```

### 1.3 职责对照表

| 层级 | 存储形态 | 生命周期 | 是否自动进 context | 写入触发者 |
|---|---|---|---|---|
| L1 Working | RAM 中 messages 数组 | 单次任务 | ✅ 始终在 | ReAct 循环自身 |
| L2 Episodic | `memory/YYYY-MM-DD.md` | 永久存档 | ❌ 按需检索 | Pre-compaction flush / 工具回调 |
| L3 Curated | `MEMORY.md` / `USER.md` / `SOUL.md` | 永久常驻 | ✅ 会话启动注入 | Dreaming 晋升流水线 |

---

## 2. L1 工作记忆（Working Memory）

### 2.1 职责

- 持有当前 ReAct 循环的完整 `Thought → Action → Observation` 轨迹
- 管理 token 预算，超阈值时**先 flush 再压缩**
- 不直接持久化，但为 L2 提供原材料

### 2.2 数据结构

```python
from dataclasses import dataclass, field
from typing import List, Dict, Any

@dataclass
class WorkingMemory:
    """L1: 当前任务的上下文窗口管理"""
    thread_id: str
    messages: List[Dict[str, Any]] = field(default_factory=list)
    max_tokens: int = 8000
    compaction_threshold: float = 0.8  # 80% 时触发压缩
    
    def add(self, role: str, content: str):
        self.messages.append({"role": role, "content": content})
    
    def current_tokens(self) -> int:
        """估算当前 token 用量"""
        return sum(len(m["content"]) // 4 for m in self.messages)
    
    def needs_compaction(self) -> bool:
        return self.current_tokens() >= self.max_tokens * self.compaction_threshold
```

### 2.3 Pre-compaction Flush（关键机制）

OpenClaw 的核心创新：**不是简单截断旧消息，而是先让 LLM 把重要信息"存档"再丢**。

```python
COMPACTION_PROMPT = """你正在压缩对话历史。请将以下对话中的关键信息提取为结构化笔记，
写入今天的记忆文件。保留：
- 用户表达的稳定偏好和约束
- 已确认的事实和决策
- 未完成的任务和目标
- 工具调用的关键结果

忽略：闲聊、重复确认、临时中间结果。
输出格式：纯文本，每条一行，以 "- " 开头。
"""

async def pre_compaction_flush(wm: WorkingMemory, l2_store: "EpisodicMemory"):
    """在截断前，先把重要信息 flush 到 L2"""
    today = date.today().isoformat()
    
    # 让 LLM 提取关键信息
    extract_messages = [
        {"role": "system", "content": COMPACTION_PROMPT},
        *wm.messages  # 当前全部上下文
    ]
    extracted = await llm_chat(extract_messages)
    
    # 写入今天的 daily note
    l2_store.append(today, extracted)
    
    # 压缩：保留 system + 最近 N 轮
    system_msg = wm.messages[0] if wm.messages[0]["role"] == "system" else None
    recent = wm.messages[-6:]  # 最近 3 轮 (user+assistant 各 3)
    wm.messages = ([system_msg] if system_msg else []) + recent
```

### 2.4 与 ReAct 循环的集成

```python
async def react_step(wm: WorkingMemory, tools, l2: "EpisodicMemory"):
    """单次 ReAct 推理步"""
    # 检查是否需要压缩
    if wm.needs_compaction():
        await pre_compaction_flush(wm, l2)
    
    # 标准 ReAct 推理
    response = await llm_chat(wm.messages)
    wm.add("assistant", response)
    
    thought, action, action_input = parse_react(response)
    
    if action == "finish":
        return action_input["response"]
    
    # 执行工具
    observation = await call_tool(action, action_input)
    wm.add("user", f"Observation: {observation}")
    
    return None  # 继续循环
```

---

## 3. L2 短期记忆（Episodic Memory）

### 3.1 设计原则

- **按天分文件**：`memory/2026-08-08.md`，天然时间索引
- **不自动注入 context**：避免 context 被历史噪声污染
- **按需检索**：通过 `memory_search()` 召回相关片段
- **追加写 only**：不修改历史文件，保证不可变性

### 3.2 文件结构

```
workspace/
└── memory/
    ├── 2026-08-06.md
    ├── 2026-08-07.md
    ├── 2026-08-08.md   ← 今天，正在写入
    └── index.sqlite     ← BM25 + 向量索引（非真相源）
```

### 3.3 核心实现

```python
import os
from datetime import date
from pathlib import Path

class EpisodicMemory:
    """L2: 按天分文件的短期记忆"""
    
    def __init__(self, memory_dir: str = "workspace/memory"):
        self.memory_dir = Path(memory_dir)
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.index = MemoryIndex(self.memory_dir / "index.sqlite")
    
    def _today_file(self) -> Path:
        return self.memory_dir / f"{date.today().isoformat()}.md"
    
    def append(self, day: str, content: str):
        """追加写入指定日期的文件"""
        filepath = self.memory_dir / f"{day}.md"
        with open(filepath, "a", encoding="utf-8") as f:
            f.write(f"\n## {datetime.now().isoformat()}\n")
            f.write(content.strip() + "\n")
        
        # 更新索引（异步更好，这里简化）
        self.index.add(day, content)
    
    def append_today(self, content: str):
        """快捷方法：写今天"""
        self.append(date.today().isoformat(), content)
    
    def read_day(self, day: str) -> str:
        """读取某天完整内容"""
        filepath = self.memory_dir / f"{day}.md"
        if not filepath.exists():
            return ""
        return filepath.read_text(encoding="utf-8")
    
    def search(self, query: str, top_k: int = 5) -> List[Dict]:
        """混合检索：BM25 + 向量（RRF 融合）"""
        bm25_results = self.index.bm25_search(query, top_k=top_k * 2)
        vector_results = self.index.vector_search(query, top_k=top_k * 2)
        
        # Reciprocal Rank Fusion
        fused = rrf_fuse(bm25_results, vector_results, k=top_k)
        return fused
```

### 3.4 索引层（SQLite + 可选向量）

```python
import sqlite3
import json

class MemoryIndex:
    """SQLite 索引：BM25 全文搜索 + 向量检索加速"""
    
    def __init__(self, db_path: str):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts 
            USING fts5(day, content, tokenize='unicode61')
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS memory_vec (
                id INTEGER PRIMARY KEY,
                day TEXT,
                content TEXT,
                embedding BLOB  -- 可选，接入 embedding 模型后启用
            )
        """)
    
    def add(self, day: str, content: str):
        self.conn.execute(
            "INSERT INTO memory_fts (day, content) VALUES (?, ?)",
            (day, content)
        )
        self.conn.commit()
    
    def bm25_search(self, query: str, top_k: int = 10) -> List[Dict]:
        rows = self.conn.execute(
            """SELECT day, content, bm25(memory_fts) as score 
               FROM memory_fts 
               WHERE memory_fts MATCH ? 
               ORDER BY score 
               LIMIT ?""",
            (query, top_k)
        ).fetchall()
        return [{"day": r[0], "content": r[1], "score": r[2]} for r in rows]
```

### 3.5 RRF 融合（BM25 + 向量）

```python
def rrf_fuse(results_a: List[Dict], results_b: List[Dict], k: int = 60) -> List[Dict]:
    """Reciprocal Rank Fusion: 合并两种排序"""
    scores = {}
    for result_list in [results_a, results_b]:
        for rank, item in enumerate(result_list):
            key = item["content"]
            scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
    
    fused = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [{"content": c, "score": s} for c, s in fused[:k]]
```

---

## 4. L3 长期记忆（Curated Core）

### 4.1 文件分工

| 文件 | 内容 | 写入权限 |
|---|---|---|
| `SOUL.md` | Agent 人格、核心价值观、行为准则 | 仅系统初始化 / 人工编辑 |
| `USER.md` | 用户画像、稳定偏好、沟通风格 | Promotion Gate 晋升 |
| `MEMORY.md` | 精炼事实、跨会话关键知识 | Promotion Gate 晋升 |
| `AGENTS.md` | 子 Agent 定义、工具使用规范 | 系统脚手架 |

### 4.2 常驻注入策略

```python
CURATED_FILES = [
    "SOUL.md",      # 人格，最高优先级
    "USER.md",      # 用户画像
    "MEMORY.md",    # 事实记忆
    "AGENTS.md",    # 行为规范
]

def build_system_prompt(workspace: str) -> str:
    """会话启动时，拼接 L3 常驻记忆"""
    sections = []
    for fname in CURATED_FILES:
        fpath = Path(workspace) / fname
        if fpath.exists():
            content = fpath.read_text(encoding="utf-8")
            sections.append(f"# {fname.replace('.md', '')}\n{content}")
    
    return "\n\n".join(sections)
```

### 4.3 Promotion Gate（晋升闸门）

这是 OpenClaw 方案最精髓的部分——**不是什么都能进 L3**。

```python
from enum import Enum

class Provenance(Enum):
    """信息来源标记 —— 决定可信度"""
    OWNER_DIRECT    = "owner_direct"     # 用户明确说出（最高可信度）
    OWNER_DERIVED   = "owner_derived"   # 从用户行为推导
    TOOL_OUTPUT     = "tool_output"     # 工具返回（需验证）
    WEB_SEARCH      = "web_search"      # 网页搜索（低可信度）
    AGENT_INFERRED  = "agent_inferred"  # Agent 自己推断（最低）
    SYSTEM_SCAFFOLD = "system"          # 系统脚手架（不可晋升）

class PromotionGate:
    """晋升闸门：决定一条信息能否从 L2 进入 L3"""
    
    # 不同来源的最小确认次数
    REQUIRED_CONFIRMATIONS = {
        Provenance.OWNER_DIRECT:    1,   # 用户说的，一次就够
        Provenance.OWNER_DERIVED:   2,   # 推导的，需要两次交叉验证
        Provenance.TOOL_OUTPUT:     3,   # 工具结果，需要多次一致
        Provenance.WEB_SEARCH:      4,   # 网页信息，要求更高
        Provenance.AGENT_INFERRED:  5,   # 自己猜的，最难晋升
        Provenance.SYSTEM_SCAFFOLD: -1,  # 永不可晋升
    }
    
    def __init__(self):
        self.pending = {}  # fact -> {count, provenance, first_seen}
    
    def evaluate(self, fact: str, provenance: Provenance) -> bool:
        """评估一条事实是否够格晋升"""
        if provenance == Provenance.SYSTEM_SCAFFOLD:
            return False
        
        threshold = self.REQUIRED_CONFIRMATIONS[provenance]
        key = self._normalize(fact)
        
        if key not in self.pending:
            self.pending[key] = {
                "count": 1,
                "provenance": provenance,
                "first_seen": datetime.now()
            }
            return False
        
        self.pending[key]["count"] += 1
        return self.pending[key]["count"] >= threshold
    
    def _normalize(self, fact: str) -> str:
        """归一化事实文本，避免同义重复"""
        return fact.lower().strip().rstrip("。.!！")
```

### 4.4 Dreaming 晋升流水线

```python
DREAMING_PROMPT = """你是记忆管理员。下面是一段近期对话记录，请提取其中值得长期记住的事实。

筛选标准：
1. 用户明确表达的偏好或约束（高优先级）
2. 被多次验证的事实（高优先级）
3. 对未来决策有指导意义的信息（中优先级）
4. 一次性临时信息（丢弃）

对每条候选事实，标注：
- fact: 事实陈述（一句话）
- confidence: 1-10
- category: preference | fact | rule | skill
- target_file: USER.md | MEMORY.md

输出 JSON 数组。
"""

class DreamingPipeline:
    """后台 Dreaming：巡检 L2，提候选事实，过 Gate，写 L3"""
    
    def __init__(self, l2: EpisodicMemory, gate: PromotionGate, workspace: str):
        self.l2 = l2
        self.gate = gate
        self.workspace = Path(workspace)
    
    async def run(self, days_back: int = 3):
        """巡检最近 N 天的 daily notes"""
        candidates = []
        
        for day_offset in range(days_back):
            target_day = (date.today() - timedelta(days=day_offset)).isoformat()
            content = self.l2.read_day(target_day)
            if not content:
                continue
            
            # 让 LLM 提取候选事实
            prompt = f"{DREAMING_PROMPT}\n\n---对话记录---\n{content}"
            result = await llm_chat([{"role": "user", "content": prompt}])
            day_candidates = parse_json_array(result)
            candidates.extend(day_candidates)
        
        # 逐条过 Gate
        for cand in candidates:
            provenance = self._infer_provenance(cand)
            if self.gate.evaluate(cand["fact"], provenance):
                self._write_to_curated(cand)
    
    def _write_to_curated(self, cand: Dict):
        """写入对应的 L3 文件"""
        target = self.workspace / cand["target_file"]
        line = f"- {cand['fact']} (confidence: {cand['confidence']})\n"
        
        with open(target, "a", encoding="utf-8") as f:
            f.write(line)
```

---

## 5. ReAct 循环完整集成

### 5.1 Context Assembly（每次推理前组装）

```python
async def build_context(
    user_msg: str,
    wm: WorkingMemory,
    l2: EpisodicMemory,
    workspace: str
) -> List[Dict]:
    """组装完整 context：L3 常驻 + L2 检索 + L1 当前"""
    
    # 1. L3 常驻：系统提示（含 SOUL/USER/MEMORY）
    system_prompt = build_system_prompt(workspace)
    
    # 2. L2 检索：召回相关历史片段
    retrieved = l2.search(user_msg, top_k=3)
    memory_block = "\n".join([r["content"] for r in retrieved])
    if memory_block:
        system_prompt += f"\n\n# 相关历史记忆\n{memory_block}"
    
    # 3. 组装完整 messages
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(wm.messages)  # L1 当前对话
    messages.append({"role": "user", "content": user_msg})
    
    return messages
```

### 5.2 完整 Agent 循环

```python
class OpenClawAgent:
    """完整的 OpenClaw 风格 ReAct Agent"""
    
    def __init__(self, workspace: str, tools: List, model: str = "gpt-4o"):
        self.workspace = workspace
        self.tools = {t.__name__: t for t in tools}
        self.model = model
        
        # 三层记忆
        self.wm = {}  # thread_id -> WorkingMemory
        self.l2 = EpisodicMemory(f"{workspace}/memory")
        self.gate = PromotionGate()
        self.dreaming = DreamingPipeline(self.l2, self.gate, workspace)
        
        # 工具回调：工具结果自动写入 L2
        self.tool_callback = ToolMemoryCallback(self.l2)
    
    async def run(self, user_msg: str, thread_id: str = "default") -> str:
        # 获取/创建当前线程的 L1
        if thread_id not in self.wm:
            self.wm[thread_id] = WorkingMemory(
                thread_id=thread_id,
                messages=[{"role": "system", "content": build_system_prompt(self.workspace)}]
            )
        wm = self.wm[thread_id]
        
        # ReAct 循环
        wm.add("user", user_msg)
        
        for step in range(10):  # 最大步数限制
            # 检查压缩
            if wm.needs_compaction():
                await pre_compaction_flush(wm, self.l2)
            
            # 推理
            messages = await build_context(user_msg, wm, self.l2, self.workspace)
            response = await llm_chat(messages, model=self.model)
            wm.add("assistant", response)
            
            # 解析 ReAct 输出
            parsed = parse_react_response(response)
            
            if parsed["action"] == "finish":
                final = parsed["response"]
                # 任务结束：记录到 L2
                self.l2.append_today(f"## 任务完成\n用户: {user_msg}\n结果: {final}")
                return final
            
            # 执行工具
            tool_name = parsed["action"]
            tool_input = parsed["action_input"]
            observation = await self._call_tool(tool_name, tool_input)
            
            # 工具结果写入 L2（带来源标记）
            self.tool_callback.log(tool_name, tool_input, observation)
            
            wm.add("user", f"Observation: {observation}")
        
        return "达到最大步数限制"
    
    async def _call_tool(self, name: str, input_data: Dict) -> str:
        """执行工具，带超时和错误隔离"""
        if name not in self.tools:
            return f"错误：工具 {name} 不存在"
        
        try:
            tool_func = self.tools[name]
            if asyncio.iscoroutinefunction(tool_func):
                result = await asyncio.wait_for(tool_func(**input_data), timeout=30)
            else:
                result = tool_func(**input_data)
            return str(result)
        except asyncio.TimeoutError:
            return "工具执行超时"
        except Exception as e:
            return f"工具执行错误: {e}"
```

---

## 6. 工具记忆回调

### 6.1 设计目标

工具产生的结果（如搜索、查询、计算）是重要记忆来源，但**不能直接晋升到 L3**——需要标记来源、等待验证。

```python
class ToolMemoryCallback:
    """工具执行时自动记录到 L2，并标记 provenance"""
    
    def __init__(self, l2: EpisodicMemory):
        self.l2 = l2
    
    def log(self, tool_name: str, input_data: Dict, output: str):
        entry = f"- [tool:{tool_name}] input={json.dumps(input_data)} → {output[:200]}"
        self.l2.append_today(entry)
    
    def log_error(self, tool_name: str, error: str):
        entry = f"- [tool:{tool_name}] ERROR: {error}"
        self.l2.append_today(entry)
```

---

## 7. 记忆操作超时与降级

### 7.1 设计原则

**记忆子系统挂了不能拖垮主回复**——所有 memory 操作必须有 timeout/fallback。

```python
import asyncio

class SafeMemoryLayer:
    """带超时和降级的记忆操作包装"""
    
    def __init__(self, l2: EpisodicMemory, timeout_ms: int = 500):
        self.l2 = l2
        self.timeout = timeout_ms / 1000
    
    async def search_safe(self, query: str, fallback: List = None) -> List:
        """检索带超时，失败返回空"""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(self.l2.search, query),
                timeout=self.timeout
            )
        except (asyncio.TimeoutError, Exception):
            # 降级：返回空结果，不影响主流程
            return fallback or []
    
    async def append_safe(self, content: str):
        """写入带超时，失败静默丢弃"""
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self.l2.append_today, content),
                timeout=self.timeout
            )
        except (asyncio.TimeoutError, Exception):
            pass  # 记不住也不能崩
```

---

## 8. 目录结构建议

```
my_agent/
├── agent.py                  # OpenClawAgent 主类
├── memory/
│   ├── __init__.py
│   ├── working.py            # L1 WorkingMemory
│   ├── episodic.py           # L2 EpisodicMemory + MemoryIndex
│   ├── curated.py            # L3 Curated Core 读写
│   ├── gate.py               # PromotionGate
│   └── dreaming.py           # DreamingPipeline
├── tools/
│   ├── __init__.py
│   └── examples.py           # 示例工具
├── workspace/                # 运行时数据（可 .gitignore）
│   ├── SOUL.md
│   ├── USER.md
│   ├── MEMORY.md
│   ├── AGENTS.md
│   └── memory/
│       ├── 2026-08-08.md
│       └── index.sqlite
├── config.py                 # 全局配置
└── main.py                   # 入口
```

---

## 9. 配置示例

```python
# config.py

AGENT_CONFIG = {
    # 模型
    "model": "gpt-4o",
    "temperature": 0.2,
    
    # L1 工作记忆
    "max_tokens": 8000,
    "compaction_threshold": 0.8,
    "keep_recent_turns": 3,
    
    # L2 短期记忆
    "memory_dir": "workspace/memory",
    "search_top_k": 5,
    "memory_timeout_ms": 500,
    
    # L3 长期记忆
    "workspace_dir": "workspace",
    "curated_files": ["SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md"],
    
    # Dreaming
    "dreaming_enabled": True,
    "dreaming_days_back": 3,
    "dreaming_interval_minutes": 30,
    
    # ReAct 循环
    "max_react_steps": 10,
    "tool_timeout_seconds": 30,
    
    # 向量检索（可选，后期启用）
    "embedding_model": None,  # 设为 "text-embedding-3-small" 启用
    "vector_db_path": "workspace/memory/vectors.db",
}
```

---

## 10. 演进路线图

### Phase 1：最小闭环（纯文本）

- ✅ L1 WorkingMemory + token 裁剪
- ✅ L2 EpisodicMemory（按天 Markdown + BM25）
- ✅ L3 Curated（手写 SOUL.md / USER.md）
- ✅ 基础 ReAct 循环

### Phase 2：智能压缩

- ✅ Pre-compaction flush（LLM 提取关键信息）
- ✅ 压缩质量评估（压缩前后信息保留率）

### Phase 3：晋升流水线

- ✅ Promotion Gate（来源可信度评分）
- ✅ Dreaming 后台巡检
- ✅ 自动写入 USER.md / MEMORY.md

### Phase 4：向量检索

- ✅ 接入 embedding 模型
- ✅ SQLite + 向量混合检索（RRF）
- ✅ 语义相似度排序

### Phase 5：自进化

- ✅ 记忆质量自评估（哪些记忆从来没被召回过 → 降权）
- ✅ 自动清理过期/矛盾记忆
- ✅ 用户反馈闭环（用户纠正 → 立即更新 L3）

---

## 附录 A：关键设计决策记录（ADR）

### ADR-1：文件即真相源，SQLite 只做索引

**决策**：所有记忆的真相源是 Markdown 文件，SQLite 只是加速索引。  
**理由**：
- 文件可读、可 diff、可 git 版本管理
- 向量库挂了/迁移了，记忆不丢
- 人工可以直接编辑修正

### ADR-2：写路径和读路径分离

**决策**：回复时只做检索（read path），不抽取新记忆；抽取放到后台 Dreaming（write path）。  
**理由**：
- 回复路径要求低延迟，不能每次都让 LLM 判断是否值得记住
- 后台巡检可以用更强模型、更充分思考
- 避免"边聊边记"导致 context 污染

### ADR-3：Promotion Gate 必须有来源标记

**决策**：每条候选记忆必须携带 Provenance 枚举，不同来源有不同晋升门槛。  
**理由**：
- 防止工具错误输出污染长期记忆
- 防止网页搜索的不可靠信息直接晋升
- 用户明确说出的话优先级最高

### ADR-4：L2 不自动注入 Context

**决策**：Daily Notes 永远不会被自动拼进 system prompt，只能通过 `memory_search()` 按需召回。  
**理由**：
- 历史记录量大，全量注入会爆 token
- 按需检索保证召回的相关性和新鲜度
- 避免"昨天聊过的废话"污染今天的推理

---

## 附录 B：5 分钟快速开始

```python
# quickstart.py

import asyncio
from agent import OpenClawAgent
from tools.examples import search_market_price, send_email

# 1. 初始化 Agent
agent = OpenClawAgent(
    workspace="workspace",
    tools=[search_market_price, send_email],
    model="gpt-4o"
)

# 2. 写入初始 L3 记忆（只需一次）
import pathlib
pathlib.Path("workspace").mkdir(exist_ok=True)
pathlib.Path("workspace/SOUL.md").write_text(
    "# Agent 人格\n你是采购助理，做事严谨，优先用数据说话。\n"
)
pathlib.Path("workspace/USER.md").write_text(
    "# 用户画像\n- 张总，采购负责人\n- 对价格敏感\n- 偏好邮件沟通\n"
)

# 3. 运行
async def main():
    result = await agent.run(
        "帮我查一下华锐的报价，如果比市场价高5%以上就发邮件提醒我",
        thread_id="thread_001"
    )
    print(result)
    
    # 4. 后台 Dreaming（会话结束后调用）
    await agent.dreaming.run(days_back=1)

asyncio.run(main())
```

---

## 附录 C：与上一版方案的差异对照

| 维度 | 上一版（向量库为主） | 本方案（OpenClaw 风格） |
|---|---|---|
| 真相源 | SQLite / Chroma 向量库 | Markdown 文件 |
| L2 形态 | thread checkpoint（消息列表） | 按天分文件 daily notes |
| 写入时机 | 实时写回 | pre-compaction flush + 后台 Dreaming |
| 晋升机制 | 无（所有事实平权） | Promotion Gate + Provenance 评分 |
| 检索方式 | 纯向量相似度 | BM25 + 向量 RRF 融合 |
| 降级策略 | 未考虑 | 所有 memory 操作带 timeout/fallback |
| L3 人格 | 无 | SOUL.md 独立文件 |
| 工具记忆 | 无 | ToolMemoryCallback 自动记录 |
| 自进化 | 无 | Dreaming 巡检 + 矛盾检测 |
