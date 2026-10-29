// 中止收尾工具（兼容出口）：Task-20261029-001 起 sealPendingToolCalls 已下移到
// src/agent/abort-utils.ts（CLI 与 API 共用，避免 CLI 反向依赖 api 层）。
// 本文件保留同名 re-export，handlers/messages.ts 与既有测试的引用路径无需改动。

export { sealPendingToolCalls } from '../agent/abort-utils.js';
