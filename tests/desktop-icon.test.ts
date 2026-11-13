// 应用图标单测（任务 20261112-007-03 / D3-6）
//
// 图标是二进制资产，最容易出的问题是「换了但没生效」或「格式不合规导致
// 打包工具报错」。这里只校验 PNG 结构与基本视觉约束，不做像素级比对：
// - PNG 签名与 IHDR 合法（bit depth 8 / color type 6 = RGBA）
// - 尺寸为 1024×1024（D3-6：唯一源，.ico 由任务 04 生成）
// - 不是纯色/全透明（防止误提交占位图或空白图）
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ICON = join(process.cwd(), 'desktop', 'assets', 'icon.png');

/** 解析 PNG 块列表 */
function readChunks(buf: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}

/** 解出 RGBA 像素（仅支持本图标使用的 filter=0 情形） */
function decodeRgba(buf: Buffer): { size: number; px: (x: number, y: number) => number[] } {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR')!;
  const size = ihdr.data.readUInt32BE(0);
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = inflateSync(idat);
  const stride = size * 4 + 1;
  return {
    size,
    px: (x, y) => {
      const i = y * stride + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

describe('desktop/assets/icon.png', () => {
  it('文件存在', () => {
    expect(existsSync(ICON)).toBe(true);
  });

  it('是合法 PNG 且 IHDR 为 8bit RGBA', () => {
    const buf = readFileSync(ICON);
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const chunks = readChunks(buf);
    const ihdr = chunks.find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    expect(ihdr!.data[8]).toBe(8); // bit depth
    expect(ihdr!.data[9]).toBe(6); // color type RGBA
    expect(chunks.some((c) => c.type === 'IEND')).toBe(true);
  });

  it('尺寸为 1024×1024（D3-6 唯一源）', () => {
    const { size } = decodeRgba(readFileSync(ICON));
    expect(size).toBe(1024);
  });

  it('不是单色图（确认真的画了图形，而不是误提交占位图）', () => {
    const { size, px } = decodeRgba(readFileSync(ICON));
    const seen = new Set<string>();
    for (let y = 0; y < size; y += 16) {
      for (let x = 0; x < size; x += 16) seen.add(px(x, y).join(','));
    }
    // 底色 + 品牌色 + 中心衬底 + 抗锯齿过渡，至少应有 3 种取值
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('四角透明、中心不透明（圆角图标造型）', () => {
    const { size, px } = decodeRgba(readFileSync(ICON));
    expect(px(0, 0)[3]).toBe(0);
    expect(px(size - 1, 0)[3]).toBe(0);
    expect(px(0, size - 1)[3]).toBe(0);
    expect(px(size - 1, size - 1)[3]).toBe(0);
    expect(px(size / 2, size / 2)[3]).toBe(255);
  });

  it('中心存在品牌绿像素（#34d399 附近的色相）', () => {
    const { size, px } = decodeRgba(readFileSync(ICON));
    // 取环带上的采样点：半径约 0.25*size 的一圈
    let foundBrand = false;
    for (let deg = 0; deg < 360; deg += 5) {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(size / 2 + Math.cos(rad) * size * 0.25);
      const y = Math.round(size / 2 + Math.sin(rad) * size * 0.25);
      const [r, g, b] = px(x, y);
      // 品牌绿：G 明显高于 R 与 B
      if (g > 180 && g > r + 60 && g > b + 20) {
        foundBrand = true;
        break;
      }
    }
    expect(foundBrand).toBe(true);
  });
});
