/**
 * tools 包占用的服务 key。
 *
 * 为什么是「一个目录服务 + 每个提供者一个 key」，而不是所有提供者共用一个
 * key 存 Map：
 *
 * `core/src/service.ts` 的 `provide()` 遇重复 key **抛 `ServiceConflictError`，
 * 不做覆盖**。若所有提供者挤在 `tools:provider` 一个 key 下，第二个提供者
 * 挂载即冲突。改成单 key 存 Map 虽能绕过冲突，但会丢掉 core 的归属追踪——
 * `diagnose()` 无法按提供者报 `ownerFiberId`，某个提供者卸载时也无法靠
 * Fiber 自动撤销单条，等于把 core 刚解决的「可成组撤销」重新破坏一次。
 *
 * 额外收益：`ctx.get('tools:provider:mcp-fs')` 可在**不碰目录服务**的情况下
 * 直取，插件之间可做精确软依赖（`inject: { optional: [...] }`）。
 */
export const TOOLS_SERVICE_KEYS = {
  /** 目录服务：唯一实例，由 installTools() 提供 */
  registry: 'tools:registry',
  /** 提供者服务 key 前缀；实际 key 为 `${providerPrefix}${id}` */
  providerPrefix: 'tools:provider:',
} as const;

/** 拼出某个提供者的服务 key */
export function providerServiceKey(id: string): string {
  return `${TOOLS_SERVICE_KEYS.providerPrefix}${id}`;
}
