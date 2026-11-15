/**
 * llm 包占用的服务 key。
 *
 * 为什么是「一个目录服务 + 每个 provider 一个 key」，而不是所有 provider
 * 共用一个 key 存 Map：
 *
 * `core/src/service.ts` 的 `provide()` 遇重复 key **抛 `ServiceConflictError`，
 * 不做覆盖**。若所有 provider 挤在 `llm:provider` 一个 key 下，第二个 provider
 * 挂载即冲突。改成单 key 存 Map 虽能绕过冲突，但会丢掉 core 的归属追踪——
 * `diagnose()` 无法按 provider 报 `ownerFiberId`，某个 provider 卸载时也无法
 * 靠 Fiber 自动撤销单条，等于把 core 刚解决的「可成组撤销」重新破坏一次。
 */
export const LLM_SERVICE_KEYS = {
  /** 目录服务：唯一实例，由 installLlm() 提供 */
  registry: 'llm:registry',
  /** provider 服务 key 前缀；实际 key 为 `${providerPrefix}${id}` */
  providerPrefix: 'llm:provider:',
} as const;

/** 拼出某个 provider 的服务 key */
export function providerServiceKey(id: string): string {
  return `${LLM_SERVICE_KEYS.providerPrefix}${id}`;
}
