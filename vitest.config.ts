import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    // 串行执行测试文件，避免并发 LLM 调用导致 API 限速
    fileParallelism: false,
  },
});
