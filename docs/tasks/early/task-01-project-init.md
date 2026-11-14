# Task-01：项目初始化与依赖安装

## 需求目标

搭建 ReAct Agent 项目的工程骨架，确保 TypeScript 项目可编译、可运行、依赖可安装，为后续所有任务提供基础环境。

### 目标清单
1. 初始化 `package.json`（含 name/version/scripts/依赖）
2. 配置 `tsconfig.json`（strict 模式，ESM 输出）
3. 创建 `.gitignore`、`.env.example`、`.env`
4. 安装核心依赖：`openai`、`dotenv`
5. 安装开发依赖：`typescript`、`tsx`、`tsup`、`@types/node`
6. 配置 npm scripts（dev/build/start）
7. 创建 `src/index.ts` 占位入口，验证 `pnpm dev` 可运行

## 实现方案

### 1. package.json

```json
{
  "name": "loop-agent-command",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup src/index.ts --format esm --dts",
    "start": "tsx src/index.ts"
  },
  "dependencies": {
    "openai": "^4.x",
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",
    "tsup": "^8.x",
    "@types/node": "^20.x"
  }
}
```

### 2. tsconfig.json

- `target`: ES2022
- `module`: ESNext / `moduleResolution`: Bundler
- `strict`: true
- `esModuleInterop`: true
- `outDir`: dist
- `types`: ["node"]

### 3. .gitignore

```
node_modules/
dist/
.env
*.log
```

### 4. .env.example

```bash
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-4o-mini
MAX_ITERATIONS=10
```

### 5. src/index.ts 占位

```typescript
console.log('ReAct Agent 启动中...');
```

### 6. 执行步骤

1. `pnpm init` 生成 package.json，按上方内容调整
2. 编写 tsconfig.json
3. 编写 .gitignore / .env.example
4. 复制 .env.example 为 .env（用户填写 key）
5. `pnpm install` 安装依赖
6. 编写 src/index.ts 占位
7. `pnpm dev` 验证输出

## 验收测试清单

- [x] 项1：`package.json` 字段完整（name/type/scripts/dependencies/devDependencies）
- [x] 项2：`tsconfig.json` strict 模式开启，ESM 配置正确
- [x] 项3：`.gitignore` 包含 node_modules/dist/.env
- [x] 项4：`.env.example` 包含 4 个环境变量模板
- [x] 项5：`.env` 已创建（不提交，本地填写）
- [x] 项6：`npm install` 执行成功（91 个包，无报错）【注：环境无 pnpm，改用 npm，scripts 兼容】
- [x] 项7：`npx tsx src/index.ts` 运行后输出 "ReAct Agent 启动中..."（等价于 `pnpm dev` 单次执行）
- [x] 项8：`npm run build` 执行成功，生成 dist/index.js（66 B）与 dist/index.d.ts
- [x] 项9：TypeScript 编译无类型错误（`npm run typecheck` 通过）
- [x] 项10：node_modules 中包含 openai、dotenv、tsx、tsup 包（tsup v8.5.1 构建成功佐证）

## 状态

- 状态：已完成
- 更新时间：2026-08-04
- 负责人：Agent
- 备注：因系统未安装 pnpm 且 corepack 受权限限制，改用 npm 安装；package.json scripts 与 npm 完全兼容，后续任务命令前缀统一改为 `npm run` / `npx`。

> 完成时将"状态"改为"已完成"，并更新 [docs/plan.md](../../designs/early/plan.md) 中的状态汇总表与本文件验收清单勾选项。
