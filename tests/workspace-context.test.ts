// 工作空间 ALS 上下文单测（Task-20261021-010-02 §6.3.1/6.3.2）
import { describe, it, expect } from 'vitest';
import {
  currentWorkspaceRoot,
  runWithWorkspace,
} from '../src/runtime/workspace-context.js';

const A = { root: '/tmp/ws-a', id: 'id-a' };
const B = { root: '/tmp/ws-b', id: 'id-b' };

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('workspace-context（ALS）', () => {
  it('ALS 外返回 undefined（CLI / 单测直调语义）', () => {
    expect(currentWorkspaceRoot()).toBeUndefined();
  });

  it('上下文内同步与异步续段都能取到根', async () => {
    await runWithWorkspace(A, async () => {
      expect(currentWorkspaceRoot()).toBe(A.root);
      await tick();
      expect(currentWorkspaceRoot()).toBe(A.root);
    });
    // 退出后不残留
    expect(currentWorkspaceRoot()).toBeUndefined();
  });

  it('并发两个空间互不串根', async () => {
    const [a, b] = await Promise.all([
      runWithWorkspace(A, async () => {
        await tick(20);
        return currentWorkspaceRoot();
      }),
      runWithWorkspace(B, async () => {
        await tick(5);
        return currentWorkspaceRoot();
      }),
    ]);
    expect(a).toBe(A.root);
    expect(b).toBe(B.root);
  });

  it('嵌套不同根以最内层为准（记告警但不抛错）', async () => {
    const got = await runWithWorkspace(A, () =>
      runWithWorkspace(B, async () => currentWorkspaceRoot()),
    );
    expect(got).toBe(B.root);
  });

  it('嵌套同根正常返回', async () => {
    const got = await runWithWorkspace(A, () =>
      runWithWorkspace(A, async () => currentWorkspaceRoot()),
    );
    expect(got).toBe(A.root);
  });
});
