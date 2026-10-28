// 粘贴附件纯逻辑单测（task-20261028-005 P2）
// 覆盖 D4（默认名重命名 / 原名保留）、D6（图片判据）、D8（视觉警告）、D9（单次上限）
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASTE_NAMES,
  PASTE_MAX_FILES,
  VISION_IMAGE_EXTS,
  capPasteFiles,
  collectPasteFiles,
  isDefaultPasteName,
  renamePastedFile,
  visionSkipReason,
  type PastedFile,
  type VisionGate,
} from '../webui/src/paste-files.js';
import { MIME_BY_EXT } from '../src/tools/vision/image.js';

/** 最小 DataTransfer 桩：collectPasteFiles 只读 files（下标 + length） */
function dtOf(...files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

function f(name: string, type: string, content = 'x'): File {
  return new File([content], name, { type });
}

const GATE_OK: VisionGate = { available: true, maxImageBytes: 10 * 1024 * 1024 };

describe('isDefaultPasteName：区分浏览器默认名与用户文件名（D4）', () => {
  it('截图默认名（不区分大小写）与空名命中', () => {
    expect(isDefaultPasteName('image.png')).toBe(true);
    expect(isDefaultPasteName('IMAGE.PNG')).toBe(true);
    expect(isDefaultPasteName('image.jpeg')).toBe(true);
    expect(isDefaultPasteName('')).toBe(true);
    expect(isDefaultPasteName('  ')).toBe(true);
  });

  it('用户自己的文件名不命中（否则会被改名，认不出贴的是哪个文件）', () => {
    expect(isDefaultPasteName('sample-a.txt')).toBe(false);
    expect(isDefaultPasteName('截图 2026-10-28.png')).toBe(false);
    expect(isDefaultPasteName('image-1.png')).toBe(false);
    // 默认名单本身只含 image.* 六种，加新名字需同步该常量
    expect(DEFAULT_PASTE_NAMES).toHaveLength(7);
  });
});

describe('renamePastedFile：paste[-序号].扩展名（D4）', () => {
  it('首张无序号，多张从 2 递增', () => {
    expect(renamePastedFile('image.png', 'image/png', 1)).toBe('paste.png');
    expect(renamePastedFile('image.png', 'image/png', 2)).toBe('paste-2.png');
    expect(renamePastedFile('image.png', 'image/png', 3)).toBe('paste-3.png');
  });

  it('不再自带时间戳（服务端 writeUpload 已加 YYYYMMDD-HHmmss- 前缀，避免双时间戳）', () => {
    expect(renamePastedFile('image.png', 'image/png', 1)).not.toMatch(/\d{8}-\d{6}/);
  });

  it('扩展名优先沿用原标题，标题无后缀时按 MIME 反推', () => {
    expect(renamePastedFile('image.webp', 'image/webp', 1)).toBe('paste.webp');
    expect(renamePastedFile('', 'image/jpeg', 1)).toBe('paste.jpg');
    expect(renamePastedFile('', 'image/gif', 1)).toBe('paste.gif');
    // 来源是位图但 MIME 也拿不到：兜底 png（有后缀比无后缀可用）
    expect(renamePastedFile('', '', 1)).toBe('paste.png');
  });
});

describe('collectPasteFiles：从剪贴板取文件（D1/D2/D6）', () => {
  it('无剪贴板 / 无文件 → 空数组（调用方据此放行文本粘贴）', () => {
    expect(collectPasteFiles(null)).toEqual([]);
    expect(collectPasteFiles(dtOf())).toEqual([]);
  });

  it('普通文件保留原始文件名与 MIME', () => {
    const out = collectPasteFiles(dtOf(f('sample-a.txt', 'text/plain')));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('sample-a.txt');
    expect(out[0].isImage).toBe(false);
    expect(out[0].file.name).toBe('sample-a.txt');
  });

  it('多张截图同名 → 按批内序号区分，不互相覆盖', () => {
    const out = collectPasteFiles(
      dtOf(f('image.png', 'image/png'), f('image.png', 'image/png'), f('image.png', 'image/png')),
    );
    expect(out.map((p) => p.name)).toEqual(['paste.png', 'paste-2.png', 'paste-3.png']);
    expect(out.every((p) => p.isImage)).toBe(true);
  });

  it('图片判据：MIME 优先；MIME 缺失/仅 octet-stream 时按扩展名兜底（D6）', () => {
    const [png] = collectPasteFiles(dtOf(f('blob.png', 'image/png')));
    expect(png.isImage).toBe(true);
    // 资源管理器个别场景 type 为空
    const [noMime] = collectPasteFiles(dtOf(f('shot.png', '')));
    expect(noMime.isImage).toBe(true);
    const [octet] = collectPasteFiles(dtOf(f('shot.webp', 'application/octet-stream')));
    expect(octet.isImage).toBe(true);
    // MIME 明确为非图片时尊重 MIME，即使扩展名像图片
    const [txt] = collectPasteFiles(dtOf(f('fake.png', 'text/plain')));
    expect(txt.isImage).toBe(false);
  });

  it('svg：出缩略图（isImage=true），但视觉不可读由 visionSkipReason 单独判（D6 双判据）', () => {
    const [svg] = collectPasteFiles(dtOf(f('icon.svg', 'image/svg+xml')));
    expect(svg.isImage).toBe(true);
    expect(visionSkipReason('icon.svg', 'image/svg+xml', 1024, GATE_OK)).toContain('不在视觉支持范围');
  });
});

describe('capPasteFiles：单次上限（D9）', () => {
  const list: PastedFile[] = Array.from({ length: 9 }, (_, i) => ({
    file: f(`f${i}.txt`, 'text/plain'),
    name: `f${i}.txt`,
    isImage: false,
  }));

  it('未超限全保留、零丢弃', () => {
    const r = capPasteFiles(list.slice(0, 3));
    expect(r.accepted).toHaveLength(3);
    expect(r.dropped).toBe(0);
  });

  it(`超过 ${PASTE_MAX_FILES} 个按顺序截断并给出丢弃数`, () => {
    const r = capPasteFiles(list);
    expect(r.accepted).toHaveLength(PASTE_MAX_FILES);
    expect(r.accepted.map((p) => p.name)).toEqual(list.slice(0, PASTE_MAX_FILES).map((p) => p.name));
    expect(r.dropped).toBe(9 - PASTE_MAX_FILES);
  });

  it('max<=0 时全部丢弃（边界不产生 NaN/负值）', () => {
    expect(capPasteFiles(list, 0)).toEqual({ accepted: [], dropped: 9 });
  });
});

describe('visionSkipReason：视觉可用性警告（D8）', () => {
  it('非图片文件不警告（文本类 Agent 用 fileRead 就能读）', () => {
    expect(visionSkipReason('a.txt', 'text/plain', 100, GATE_OK)).toBeNull();
    expect(visionSkipReason('a.zip', 'application/zip', 100, GATE_OK)).toBeNull();
  });

  it('正常图片（可用且未超限）不警告', () => {
    expect(visionSkipReason('paste.png', 'image/png', 2048, GATE_OK)).toBeNull();
    expect(visionSkipReason('a.jpg', 'image/jpeg', 2048, GATE_OK)).toBeNull();
  });

  it('视觉链路不可用 → 带上服务端 reason 原文', () => {
    const gate: VisionGate = {
      available: false,
      unavailableReason: 'vision.enabled=false，视觉工具未注册',
      maxImageBytes: 10 * 1024 * 1024,
    };
    const msg = visionSkipReason('paste.png', 'image/png', 2048, gate);
    expect(msg).toContain('视觉链路不可用');
    expect(msg).toContain('vision.enabled=false');
    // 无 reason 时也要给出可读文案而不是空串
    expect(visionSkipReason('paste.png', 'image/png', 2048, { available: false, maxImageBytes: 1e7 })).toBe(
      '视觉链路不可用，Agent 无法查看此图',
    );
  });

  it('超过 maxImageBytes → 报出上限数值', () => {
    const gate: VisionGate = { available: true, maxImageBytes: 10 * 1024 * 1024 };
    expect(visionSkipReason('big.png', 'image/png', 11 * 1024 * 1024, gate)).toBe(
      '超过视觉上限 10 MB，Agent 无法查看此图',
    );
    // 恰好等于上限不算超
    expect(visionSkipReason('edge.png', 'image/png', 10 * 1024 * 1024, gate)).toBeNull();
  });

  it('扩展名不在视觉白名单 → 格式不支持（MIME 说是图片也拦）', () => {
    const msg = visionSkipReason('a.tiff', 'image/tiff', 100, GATE_OK);
    expect(msg).toContain('.tiff');
    expect(msg).toContain(VISION_IMAGE_EXTS.join('/'));
  });

  it('优先级：不可用 > 超限 > 格式不支持（只说第一条原因）', () => {
    const gate: VisionGate = { available: false, maxImageBytes: 10 };
    expect(visionSkipReason('a.tiff', 'image/tiff', 999, gate)).toContain('视觉链路不可用');
  });
});

describe('镜像关系：前端视觉白名单必须与后端一致', () => {
  it('VISION_IMAGE_EXTS 与 src/tools/vision/image.ts 的 MIME_BY_EXT 扩展名集合完全相同', () => {
    const backend = Object.keys(MIME_BY_EXT)
      .map((e) => e.slice(1).toLowerCase())
      .sort();
    expect([...VISION_IMAGE_EXTS].sort()).toEqual(backend);
  });
});
