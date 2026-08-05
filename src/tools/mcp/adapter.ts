// MCP 工具适配器：把 MCP tool 包装成项目 Tool 接口
import type { Tool } from '../../types.js';
import type { MCPClient } from './client.js';

/**
 * 生成带前缀的工具名，避免不同 server 间工具名冲突
 * 规则：{serverName}__{toolName}
 */
export function buildToolName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}

/**
 * 把 MCP server 返回的单个工具适配成项目 Tool 接口
 * execute 内部走 MCP RPC 调用 tools/call
 */
export function adaptMCPTool(
  serverName: string,
  mcpTool: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  },
  client: MCPClient,
): Tool {
  const adaptedName = buildToolName(serverName, mcpTool.name);
  return {
    name: adaptedName,
    description:
      mcpTool.description ?? `(MCP tool ${mcpTool.name} from server ${serverName})`,
    parameters: mcpTool.inputSchema,
    async execute(args) {
      try {
        const result = await client.callTool(mcpTool.name, args);
        return extractTextFromCallResult(result as never);
      } catch (e) {
        throw new Error(
          `MCP 工具 ${adaptedName} 调用失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}

/**
 * 从 MCP callTool 返回结果中提取文本
 * MCP 返回的 content 是数组，可能含 text/image/audio/resource
 * 我们只提取 text 类型，拼接成字符串
 */
function extractTextFromCallResult(result: unknown): string {
  // callTool 返回联合类型，统一用 unknown 收窄
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r.isError) {
    const text = extractTextArray(r).join('\n');
    return `MCP 工具返回错误: ${text || '(无错误信息)'}`;
  }

  const texts = extractTextArray(r);
  return texts.join('\n') || '(MCP 工具无文本输出)';
}

function extractTextArray(result: {
  content?: Array<{ type: string; text?: string }>;
}): string[] {
  if (!result.content) return [];
  return result.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text as string);
}
