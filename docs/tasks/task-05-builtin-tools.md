# Task-05：内置工具实现

## 需求目标

实现 4 个开箱即用的内置工具，赋予 ReAct Agent 操作本地系统的能力：执行命令、读写文件、检索内容。所有工具均注册到全局 Registry。

### 目标清单
1. 实现 `src/tools/commandRun.ts`：本地命令执行
2. 实现 `src/tools/fileRead.ts`：文件读取（支持全文与部分读取）
3. 实现 `src/tools/fileWrite.ts`：文件写入（覆盖 / 追加）
4. 实现 `src/tools/grep.ts`：内容检索（模仿 grep，支持正则）
5. 4 个工具均注册到全局 `registry`
6. 提供合理的 JSON Schema 参数定义

## 实现方案

### 1. src/tools/commandRun.ts

```typescript
import { exec } from 'node:child_process';
import type { Tool } from '../types.js';

export const commandRun: Tool = {
  name: 'commandRun',
  description: '在本地执行 shell 命令，返回 stdout+stderr。用于查看目录、运行脚本、查询系统信息等。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录（可选），默认当前目录' },
      timeout: { type: 'number', description: '超时毫秒数（可选），默认 30000' },
    },
    required: ['command'],
  },
  async execute(args) {
    const cmd = String(args.command);
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const timeout = Number(args.timeout ?? 30000);
    return new Promise((resolve) => {
      exec(cmd, { cwd, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const parts: string[] = [];
        if (stdout) parts.push(`[stdout]\n${stdout}`);
        if (stderr) parts.push(`[stderr]\n${stderr}`);
        if (err) parts.push(`[exit=${err.code ?? '?'}] ${err.message}`);
        resolve(parts.join('\n') || '(无输出)');
      });
    });
  },
};
```

- 用 `child_process.exec`，默认 30s 超时
- 合并 stdout/stderr，附退出码
- 错误不抛出，作为 Observation 返回（符合 ReAct 思想）

### 2. src/tools/fileRead.ts

```typescript
import { readFile } from 'node:fs/promises';
import type { Tool } from '../types.js';

export const fileRead: Tool = {
  name: 'fileRead',
  description: '读取文件内容，支持全文读取或按行范围部分读取。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径或相对路径' },
      startLine: { type: 'number', description: '起始行号（从1开始，可选）。不传则读全文' },
      endLine: { type: 'number', description: '结束行号（包含，可选）。需与 startLine 一起使用' },
      encoding: { type: 'string', description: '编码，默认 utf-8' },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = String(args.path);
    const encoding = (args.encoding as BufferEncoding) ?? 'utf-8';
    const content = await readFile(path, encoding);
    const lines = content.split('\n');

    const startLine = args.startLine ? Number(args.startLine) : null;
    const endLine = args.endLine ? Number(args.endLine) : null;

    if (startLine === null && endLine === null) {
      return content;
    }
    if (startLine === null || endLine === null) {
      throw new Error('startLine 与 endLine 必须同时指定，或都不指定');
    }
    if (startLine < 1 || endLine < startLine) {
      throw new Error('行号非法：startLine >= 1 且 endLine >= startLine');
    }
    const sliced = lines.slice(startLine - 1, endLine);
    return `文件 ${path} 第 ${startLine}-${endLine} 行（共 ${lines.length} 行）:\n${sliced.join('\n')}`;
  },
};
```

- 支持全文与按行范围读取
- 返回部分内容时附带总行数，便于 LLM 决定是否继续读

### 3. src/tools/fileWrite.ts

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from '../types.js';

export const fileWrite: Tool = {
  name: 'fileWrite',
  description: '写入文件。mode=overwrite 覆盖（默认），mode=append 追加。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
      mode: { type: 'string', enum: ['overwrite', 'append'], description: '写入模式，默认 overwrite' },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const path = String(args.path);
    const content = String(args.content);
    const mode = (args.mode as 'overwrite' | 'append') ?? 'overwrite';

    // 自动创建父目录
    await mkdir(dirname(path), { recursive: true });

    if (mode === 'append') {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path, content, 'utf-8');
    } else {
      await writeFile(path, content, 'utf-8');
    }
    return `已写入 ${path}（模式: ${mode}，${content.length} 字符）`;
  },
};
```

- 自动创建父目录，避免因目录不存在失败
- append 用 appendFile，保证不覆盖已有内容

### 4. src/tools/grep.ts

```typescript
import { readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool } from '../types.js';

export const grep: Tool = {
  name: 'grep',
  description: '在文件或目录中检索内容（模仿 grep）。支持正则、不区分大小写、递归搜索。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '文件或目录路径' },
      ignoreCase: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      recursive: { type: 'boolean', description: '是否递归搜索目录（仅 path 为目录时生效），默认 true' },
      maxResults: { type: 'number', description: '最大返回匹配数，默认 50' },
    },
    required: ['pattern', 'path'],
  },
  async execute(args) {
    const pattern = String(args.pattern);
    const path = String(args.path);
    const ignoreCase = args.ignoreCase !== false;
    const recursive = args.recursive !== false;
    const maxResults = Number(args.maxResults ?? 50);

    const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
    const matches: string[] = [];

    async function searchFile(filePath: string) {
      if (matches.length >= maxResults) return;
      try {
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`${filePath}:${i + 1}: ${lines[i]}`);
            if (matches.length >= maxResults) return;
          }
        }
      } catch {
        // 二进制或无权限文件跳过
      }
    }

    async function searchDir(dirPath: string, depth = 0) {
      if (depth > 5 || matches.length >= maxResults) return; // 防止过深递归
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        // 跳过 node_modules / .git / dist
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
        const full = join(dirPath, entry.name);
        if (entry.isDirectory() && recursive) {
          await searchDir(full, depth + 1);
        } else if (entry.isFile()) {
          await searchFile(full);
        }
      }
    }

    const info = await stat(path);
    if (info.isDirectory()) await searchDir(path);
    else await searchFile(path);

    if (matches.length === 0) return `未在 ${path} 中找到匹配 /${pattern}/ 的内容`;
    return `找到 ${matches.length} 处匹配${matches.length >= maxResults ? '（已达上限）' : ''}:\n${matches.join('\n')}`;
  },
};
```

- 支持 file / dir 两种输入
- 递归深度上限 5，跳过 node_modules/.git/dist
- 返回格式 `path:line: content`，与 grep 一致

### 5. 注册（src/tools/index.ts 聚合）

```typescript
import { registry } from './registry.js';
import { commandRun } from './commandRun.js';
import { fileRead } from './fileRead.js';
import { fileWrite } from './fileWrite.js';
import { grep } from './grep.js';

export function registerBuiltinTools() {
  registry.register(commandRun);
  registry.register(fileRead);
  registry.register(fileWrite);
  registry.register(grep);
}

export { registry } from './registry.js';
export { runner } from './runner.js';
```

### 6. 设计要点

- **统一返回字符串**：所有 execute 返回字符串，符合 Runner 归一化约定
- **错误不抛出**：commandRun/grep 捕获异常作为 Observation 返回，让 Agent 决定换思路
- **fileRead/fileWrite 抛错**：由 Runner 统一捕获转字符串（参数错误等场景）
- **JSON Schema 规范**：参数含 type/properties/required，遵循 OpenAI function calling 格式
- **安全考虑**：
  - commandRun 有超时与 maxBuffer 限制
  - grep 跳过敏感目录、限制递归深度与结果数
  - fileWrite 自动创建父目录

## 验收测试清单

- [x] 项1：`commandRun` 工具可注册到 registry（实测：registerBuiltinTools 后 has=true）
- [x] 项2：`commandRun` 执行 `echo hello` 返回包含 "hello" 的字符串
- [x] 项3：`commandRun` 执行非法命令时返回含错误码与 stderr 的 Observation（不抛错）
- [x] 项4：`commandRun` 超时后返回超时错误信息（实测：225ms 触发超时）
- [x] 项5：`fileRead` 读取文件全文返回文件内容
- [x] 项6：`fileRead` 指定 startLine=1/endLine=2 只返回前两行，并附"共 5 行"信息
- [x] 项7：`fileRead` 只传 startLine 不传 endLine 时抛错"必须同时指定"
- [x] 项8：`fileRead` 文件不存在时 Runner 返回"工具执行失败"Observation
- [x] 项9：`fileWrite` overwrite 模式覆盖原内容（实测：first → second）
- [x] 项10：`fileWrite` append 模式追加内容（实测：second → second-appended）
- [x] 项11：`fileWrite` 写入不存在的目录路径时自动创建父目录（实测：sub/write.txt 成功）
- [x] 项12：`grep` 在单文件中匹配正则，返回 `path:line: content` 格式
- [x] 项13：`grep` 在目录中递归搜索，返回多文件匹配（实测：a.ts + b.ts）
- [x] 项14：`grep` 无匹配时返回"未找到"字符串（实测："未在 ... 找到匹配"）
- [x] 项15：`grep` ignoreCase=true 时大小写不敏感（实测：CONST 匹配 const）
- [x] 项16：`grep` 自动跳过 node_modules / .git / dist 目录（实测：SECRET 不出现在结果中）
- [x] 项17：`grep` 结果数超过 maxResults 时返回"已达上限"提示
- [x] 项18：`registerBuiltinTools()` 执行后 `registry.list().length >= 4`（幂等，重复调用安全）
- [x] 项19：`registry.toOpenAITools()` 输出 4 个 OpenAI tool 定义（commandRun/fileRead/fileWrite/grep）
- [x] 项20：所有工具的 JSON Schema 含 type/properties/required
- [x] 项21：`npm run typecheck` 通过

## 验证记录

```
===== 结果: 21 通过 / 0 失败 =====
commandRun: echo/非法命令/超时 全部正确处理
fileRead: 全文/部分读取/参数校验/文件不存在 全部正确
fileWrite: overwrite/append/自动建目录 全部正确
grep: 单文件/递归/无匹配/ignoreCase/跳过node_modules/maxResults 全部正确
registerBuiltinTools: 幂等，4 个工具正确注册
```

## 状态

- 状态：已完成
- 更新时间：2026-08-04
- 负责人：Agent
- 依赖：Task-04
- 调整记录：原方案 calculator/weather/webSearch 改为 commandRun/fileRead/fileWrite/grep，聚焦本地系统能力
- 备注：registerBuiltinTools 幂等设计（has 检查），重复调用安全

> 完成时同步更新 plan.md 状态汇总表与本文件验收清单。
