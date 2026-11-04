// MCP 工具展示元信息拉取层（需求 20261104-001，D10）
//
// 职责边界：
// - 纯注册表（mcp-tool-meta.ts）负责数据与纯函数，本文件负责「拉取 + 响应式通知」；
// - `metaRev` 变化时 ChatView 的渲染依赖会重算，从而让已渲染的 MCP 工具卡片补上中文名；
// - 失败静默：元信息非关键路径，拉不到就退化为英文名 + 美化名，不弹 toast、不阻塞挂载。
import { shallowRef } from 'vue';
import { api } from './api/client.js';
import { setMcpToolMeta, type McpToolMeta } from './mcp-tool-meta.js';

/** 元信息版本号：加载完成后 bump，供渲染层建立依赖 */
export const metaRev = shallowRef(0);

/** 翻译进度汇总（MCP 页展示「已翻译 N/M」用，D14） */
export interface McpMetaSummary {
  total: number;
  titled: number;
  cjk: number;
  translated: number;
  named: number;
  pending: number;
  failed: number;
}

/** 最近一次拉取的汇总；未拉取过为 null */
export const metaSummary = shallowRef<McpMetaSummary | null>(null);

/** 最近一次拉取的元信息原文（MCP 页展示失败原因用） */
export const metaTools = shallowRef<McpToolMeta[]>([]);

let loading: Promise<void> | null = null;

/** 空表重试：冷启动时页面可能比 MCP 连接更快打开，此时元信息为空且不会自行恢复 */
const EMPTY_RETRY_MAX = 5;
const EMPTY_RETRY_DELAY_MS = 3000;
let emptyRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 拉取 MCP 展示元信息并写入注册表。
 * 并发调用共享同一请求（避免首屏多次触发重复请求）；`force=true` 时强制重新拉取。
 *
 * 空表自动重试：MCP 连接是后台异步的（连接完成后才有工具），首拉拿到 `tools: []`
 * 时按 3s 间隔最多重试 5 次；一旦拿到非空表即停止，不轮询、不影响首屏。
 */
export function loadMcpToolMeta(force = false): Promise<void> {
  if (loading) return loading;
  if (force) {
    // 主动刷新：清空单飞标记与重试计数，保证拿到最新状态
    loading = null;
    emptyRetries = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }
  loading = (async () => {
    try {
      const data = await api<{ tools: McpToolMeta[]; summary: McpMetaSummary }>('/mcp/tool-meta');
      const tools = data?.tools ?? [];
      setMcpToolMeta(tools);
      metaTools.value = tools;
      metaSummary.value = data?.summary ?? null;
      metaRev.value += 1;
      // MCP 尚未连接：稍后重试（后台连接完成后元信息才有内容）
      if (tools.length === 0 && emptyRetries < EMPTY_RETRY_MAX && !retryTimer) {
        emptyRetries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadMcpToolMeta(true);
        }, EMPTY_RETRY_DELAY_MS);
        // 测试/CLI 环境无长驻进程：不阻止退出
        retryTimer.unref?.();
      }
    } catch (e) {
      // 静默降级：MCP 工具回落到英文名/美化名/紧凑 JSON
      console.debug('[mcp-meta] 拉取失败，降级为英文名展示', e);
    } finally {
      loading = null;
    }
  })();
  return loading;
}
