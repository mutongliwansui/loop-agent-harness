/**
 * 进程级启动参数覆盖验收（Task-20261021-010-06 恢复项的契约固化）
 *
 * `src/config/cli-overrides.ts` 由 task-03 引入但从未入库、随后丢失，导致 HEAD 无法编译。
 * 本用例把恢复后的契约固化，避免再次静默丢失：
 * - `--port` / `--port=` 等价，且进入最高优先级的 cli 层
 * - `--host` / `--token` / `--web-root` 映射到 api 段
 * - 缺值 / 非法端口 → 忽略（回落下一层配置），不阻断启动
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getCliOverrides } from '../src/config/cli-overrides.js';

const originalArgv = process.argv;

function withArgv(extra: string[]): void {
  process.argv = [...originalArgv.slice(0, 2), ...extra];
}

afterEach(() => {
  process.argv = originalArgv;
});

describe('getCliOverrides', () => {
  it('无启动参数 → 空覆盖片段', () => {
    withArgv([]);
    expect(getCliOverrides()).toEqual({});
  });

  it('--serve --port 3099 与 --port=3099 等价', () => {
    withArgv(['--serve', '--port', '3099']);
    expect(getCliOverrides()).toEqual({ api: { port: 3099 } });

    withArgv(['--serve', '--port=3099']);
    expect(getCliOverrides()).toEqual({ api: { port: 3099 } });
  });

  it('--host / --token / --web-root 映射到 api 段', () => {
    withArgv(['--host', '0.0.0.0', '--token', 'tk-123', '--web-root', 'D:\\webui\\dist']);
    expect(getCliOverrides()).toEqual({
      api: { host: '0.0.0.0', token: 'tk-123', webRoot: 'D:\\webui\\dist' },
    });
  });

  it('非法端口 / 缺值一律忽略', () => {
    withArgv(['--port', 'abc']);
    expect(getCliOverrides()).toEqual({});
    withArgv(['--port', '0']);
    expect(getCliOverrides()).toEqual({});
    withArgv(['--port', '70000']);
    expect(getCliOverrides()).toEqual({});
    // `--port` 后面紧跟另一个参数 → 视为缺值
    withArgv(['--port', '--serve']);
    expect(getCliOverrides()).toEqual({});
  });

  it('无端口时其它字段仍生效', () => {
    withArgv(['--port', 'abc', '--host', '127.0.0.1']);
    expect(getCliOverrides()).toEqual({ api: { host: '127.0.0.1' } });
  });
});
