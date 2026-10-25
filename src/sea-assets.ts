// SEA（Single Executable Application）内嵌资源读取（Task-20261027-002 D2）
//
// 为什么用 `process.getBuiltinModule('node:sea')` 而不是 `import 'node:sea'`：
// esbuild 打 CJS 时会剥掉 `node:` 前缀，`require("sea")` 并不存在；而 SEA 运行时
// 的 embedder require 对未知模块直接抛 ERR_UNKNOWN_BUILTIN_MODULE。
// getBuiltinModule 走的是内置模块表，绕开了这条打包陷阱（踩过的真实坑，勿改）。
//
// 该模块被两处消费：
// - `src/api/static.ts`：内嵌 WebUI 静态资源
// - `src/terminal/pty-embed.ts`：内嵌的原生模块（PTY）整树

/** node:sea 的最小结构面（只声明用到的成员，避免依赖其类型声明） */
interface SeaApi {
  isSea(): boolean;
  getAsset(key: string, encoding?: string): ArrayBuffer | string;
}

function getSea(): SeaApi | undefined {
  try {
    return process.getBuiltinModule('node:sea') as SeaApi | undefined;
  } catch {
    // 极旧 Node 无 getBuiltinModule：视为非 SEA 运行
    return undefined;
  }
}

/** 当前是否运行在 SEA 产物中（非 SEA 返回 false，无副作用）。 */
export function isSeaRuntime(): boolean {
  try {
    return getSea()?.isSea() === true;
  } catch {
    return false;
  }
}

/**
 * 读取 SEA 内嵌资源（构建期由 `build-sea.mjs` 以 assets 注入 exe）。
 * 非 SEA 运行时、或该 key 不存在时返回 null（不抛）。
 */
export function readSeaAsset(key: string): Buffer | null {
  const sea = getSea();
  if (!sea) return null;
  try {
    if (!sea.isSea()) return null;
    return Buffer.from(sea.getAsset(key) as ArrayBuffer);
  } catch {
    // key 不存在时 getAsset 抛错；调用方按「没有该资源」处理
    return null;
  }
}

/** 读取内嵌的 UTF-8 文本资源；不存在或非 SEA 返回 null。 */
export function readSeaAssetText(key: string): string | null {
  const buf = readSeaAsset(key);
  return buf ? buf.toString('utf8') : null;
}
