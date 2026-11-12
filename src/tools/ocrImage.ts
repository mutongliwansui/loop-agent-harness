// ocrImage 工具（需求 20261112-002 / 任务 02，20261112-003 增版面与预处理）
//
// 定位：主模型在**没有视觉大模型**（或视觉调用失败）时，仍能从图片/扫描件里取字。
// 与 analyzeImage 的边界：
//   - analyzeImage：把图给视觉大模型看图说话（需要 vision.enabled 与外网/多模态模型）
//   - ocrImage：只做文字提取，走本机 OCR（Windows 原生，离线、不走网络、不花 token）
// 结果首行固定标注 `[OCR 引擎: ... | 语言: ... | 布局: ... | 行数: ... | 耗时: ...]`（D6），
// 避免与视觉描述混淆。
//
// 参数描述刻意极简（D11）：预算测试 `tests/tool-description-budget.test.ts` 约束总量，
// 使用手册与示例统一放 `docs/readme/{zh,en}/built-in-tools.md`。

import {
  buildOcrResultText,
  runOcrOnSource,
  OcrError,
  OCR_LAYOUTS,
  type OcrLayout,
} from '../ocr/index.js';
import type { Tool } from '../types.js';

/** 本地 OCR 进程启动 + 识别，20s 配置上限之外再留进程开销 */
const OCR_TOOL_TIMEOUT_MS = 60000;

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** layout 只接受三档已知值；非法值交给 runOcr 用配置默认（不在这里报错） */
function optLayout(args: Record<string, unknown>): OcrLayout | undefined {
  const v = optStr(args, 'layout')?.toLowerCase();
  if (!v) return undefined;
  return (OCR_LAYOUTS as readonly string[]).includes(v) ? (v as OcrLayout) : undefined;
}

function optCrop(args: Record<string, unknown>): [number, number, number, number] | undefined {
  const v = args.crop;
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const nums = v.map((item) => (typeof item === 'number' ? item : Number(item)));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;
  return nums as [number, number, number, number];
}

export const ocrImage: Tool = {
  name: 'ocrImage',
  description: '用本机 OCR 从图片取字（离线、不调用视觉大模型），适合截图、扫描件与表格图片。',
  parameters: {
    type: 'object',
    properties: {
      image: {
        type: 'string',
        description: '图片路径（工作空间内或绝对路径）、file:// 或 dataURI；不支持 http(s) 地址',
      },
      lang: {
        type: 'string',
        description: '识别语言标签，如 zh-Hans-CN / en-US；省略用配置值（默认 auto：优先中文）',
      },
      layout: {
        type: 'string',
        enum: ['text', 'table', 'words'],
        description: '版面：text 默认分行；table 出表格；words 出词坐标',
      },
      scale: {
        type: 'integer',
        minimum: 1,
        maximum: 4,
        description: '整数放大倍数 1–4（默认 1），小字误识时试 2',
      },
      crop: {
        type: 'array',
        items: { type: 'number' },
        description: '裁剪区域 [x,y,w,h]（原图像素），默认整图',
      },
      maxChars: {
        type: 'number',
        description: '字符上限，默认 ocr.maxChars（硬上限 200000）',
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
    const requestedMaxChars = optNum(rawArgs, 'maxChars');
    const layout = optLayout(rawArgs);
    const scale = optNum(rawArgs, 'scale');
    const crop = optCrop(rawArgs);

    try {
      const result = await runOcrOnSource(image, {
        lang: optStr(rawArgs, 'lang'),
        // 非法 layout/scale/crop 交给 runOcr 统一归一化（回落配置默认/整图）
        ...(layout ? { layout } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(crop ? { crop } : {}),
        // D7：配置值是默认值，工具入参可上调（runOcr 内部再按硬上限钳制）
        ...(requestedMaxChars !== undefined && requestedMaxChars > 0
          ? { maxChars: requestedMaxChars }
          : {}),
      });
      return buildOcrResultText(result);
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
