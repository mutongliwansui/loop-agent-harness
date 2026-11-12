// ocrImage 工具（需求 20261112-002 / 任务 02）
//
// 定位：主模型在**没有视觉大模型**（或视觉调用失败）时，仍能从图片/扫描件里取字。
// 与 analyzeImage 的边界：
//   - analyzeImage：把图给视觉大模型看图说话（需要 vision.enabled 与外网/多模态模型）
//   - ocrImage：只做文字提取，走本机 OCR（Windows 原生，离线、不走网络、不花 token）
// 结果首行固定标注 `[OCR 引擎: ... | 语言: ... | 耗时: ...]`（D6），避免与视觉描述混淆。

import { buildOcrResultText, resolveOcrConfig, runOcrOnSource, OcrError } from '../ocr/index.js';
import type { Tool } from '../types.js';

/** 本地 OCR 进程启动 + 识别，20s 配置上限之外再留进程开销 */
const OCR_TOOL_TIMEOUT_MS = 60000;

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

export const ocrImage: Tool = {
  name: 'ocrImage',
  description:
    '用本机 OCR 从图片里提取文字（离线、不调用视觉大模型）。适合截图、扫描件、表格图片取字；给出 image 即可，可指定 lang 与 maxChars。',
  parameters: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: '图片路径（工作空间内或绝对路径）、file:// 或 dataURI；不支持 http(s) 地址',
      },
      lang: {
        type: 'string',
        description: '识别语言标签，如 zh-Hans-CN / en-US；省略用配置值（默认 auto：Windows 上优先中文）',
      },
      maxChars: {
        type: 'number',
        description: '本次结果字符上限（覆盖配置 ocr.maxChars）',
      },
    },
    required: ['image'],
  },
  timeoutMs: OCR_TOOL_TIMEOUT_MS,
  async execute(rawArgs) {
    const image = optStr(rawArgs, 'image');
    if (!image) {
      throw new Error('缺少必需参数: image');
    }
    const cfg = resolveOcrConfig();
    const maxCharsArg = rawArgs.maxChars;
    const maxChars =
      typeof maxCharsArg === 'number' && Number.isFinite(maxCharsArg) && maxCharsArg > 0
        ? Math.min(maxCharsArg, cfg.maxChars > 0 ? cfg.maxChars : maxCharsArg)
        : cfg.maxChars;

    try {
      const result = await runOcrOnSource(image, { lang: optStr(rawArgs, 'lang') });
      // 工具级 maxChars 可能小于结果：再截一次（runOcr 用的是全局上限）
      let text = result.text;
      const warnings = [...result.warnings];
      if (maxChars > 0 && text.length > maxChars) {
        text = text.slice(0, maxChars);
        warnings.push(`结果已截断至 ${maxChars} 字符（可用 maxChars 调整）`);
      }
      return buildOcrResultText({ ...result, text, warnings });
    } catch (err) {
      if (err instanceof OcrError) {
        // 引擎不可用/格式不支持等属「可纠正」错误，把中文说明直接给主模型
        throw new Error(`OCR 失败（${err.code}）：${err.message}`);
      }
      throw err;
    }
  },
};

/** OCR 工具名（注册、门控与 Tab 补全复用） */
export const OCR_TOOL_NAMES = ['ocrImage'] as const;

/** OCR 工具集（ocr.enabled 且本机有可用引擎时注册；未启用时 tools 列表保持不变以保护前缀缓存） */
export const ocrTools: Tool[] = [ocrImage];
