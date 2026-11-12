// 本地 OCR 模块出口（需求 20261112-002）
//
// 对外只暴露三类东西：
//   - 结果与错误类型（OcrResult / OcrError）
//   - 编排入口（runOcr / runOcrOnSource / buildOcrResultText / pickOcrEngine）
//   - 引擎探测（probeWinrt / describeOcrStatus），供工具注册前的可用性判断
// 引擎实现细节（PowerShell 脚本、HTTP 契约）不外泄，方便将来替换实现（演进项）。

export * from './types.js';
export { postProcessOcrText, mergeCjkSpaces, normalizeOcrLines, collapseInnerSpaces } from './postprocess.js';
export { OcrResultCache, ocrCache, OCR_CACHE_VERSION } from './cache.js';
export {
  probeWinrt,
  resetWinrtProbeCache,
  winrtOcrLikelyAvailable,
  powershellPath,
  WINRT_SCRIPT,
  resolveWinrtScriptPath,
} from './engine-winrt.js';
export { httpOcrEngine, parseHttpOcrResponse, pickOcrTextField } from './engine-http.js';
export {
  runOcr,
  runOcrOnSource,
  pickOcrEngine,
  resolveEngineOrder,
  resolveOcrConfig,
  truncateOcrText,
  buildOcrResultText,
  describeOcrStatus,
  clearOcrCache,
  normalizeLayout,
  normalizeScale,
  normalizeCrop,
  OCR_LAYOUTS,
  type RunOcrOptions,
} from './run-ocr.js';
export {
  buildVisualLines,
  renderLayout,
  clusterColumns,
  medianWordHeight,
  describeImageSize,
  type VisualLine,
  type LayoutRenderResult,
} from './layout.js';
