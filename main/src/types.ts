/**
 * 宿主层清单与诊断类型。
 *
 * 与 core 的分工（D19）：core 的 `DiagnosticReport` 回答「Fiber / 服务为什么没生效」，
 * 本模块的 `RegistryDiagnostic` 再回答「清单里登记了什么、哪个加载失败、落盘有没有问题」。
 * 两者并列而非互相替换，故这里**包住** core 报告而不展开合并（展开会字段名冲突）。
 */
import type { DiagnosticReport, FiberState } from '@loop-agent/core';

/** 清单结构版本；不识别时降级为空清单并备份坏档（D9） */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** 单条插件清单条目 */
export interface PluginManifestEntry {
  /** 稳定标识（用户可读），同时作为清单主键；重复即冲突 */
  id: string;
  /** 模块说明符：相对路径 / 绝对路径 / 包名（只收 ESM，D10） */
  specifier: string;
  /** 是否启用；false 表示「已登记但未挂载」（D7） */
  enabled: boolean;
  /** 传给插件工厂的选项；仅 JSON 可序列化值 */
  options?: Record<string, unknown>;
}

/**
 * 清单文件（落盘结构）。
 *
 * 注意**没有** `order` 字段：顺序完全由 `entries` 数组下标表达（D17）。
 * 冗余的 order 字段会与数组顺序不一致，是经典的双写不一致来源。
 */
export interface PluginManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  /** 数组顺序 == 挂载顺序（D17） */
  entries: PluginManifestEntry[];
  /** 最后写入时间（ISO），仅供诊断 */
  updatedAt: string;
}

/** 注册中心诊断（D19） */
export interface RegistryDiagnostic {
  /** core 原始诊断 */
  core: DiagnosticReport;
  entries: Array<{
    id: string;
    specifier: string;
    enabled: boolean;
    /** 运行期状态；未挂载为 undefined */
    state?: FiberState;
    /** 加载失败原因（D10） */
    loadError?: { code: string; message: string };
  }>;
  /** 清单文件绝对路径 */
  file: string;
  /** 最近一次落盘失败（D4） */
  persistError?: { message: string };
}

/** 空清单工厂（首次启动 / 坏档降级共用） */
export function emptyManifest(): PluginManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entries: [],
    updatedAt: new Date().toISOString(),
  };
}
