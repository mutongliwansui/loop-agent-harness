// 附件文件类型图标单测（需求 20261113-006 P2）
// 覆盖 D3：图标族判定、扩展名提取、图片角标文案、SVG 合规性（16 视口 / stroke 1.6 / currentColor）
import { describe, expect, it } from 'vitest';
import {
  extLabelOf,
  extOfName,
  fileIconKey,
  fileIconSvg,
  iconPathOf,
  imgTagOf,
  isImageName,
  type FileIconKey,
} from '../webui/src/file-icon.js';

describe('extOfName：扩展名提取', () => {
  it('取最后一段扩展名并转小写', () => {
    expect(extOfName('a.png')).toBe('png');
    expect(extOfName('a.PNG')).toBe('png');
    expect(extOfName('a.tar.gz')).toBe('gz');
    expect(extOfName('报表.2026.XLSX')).toBe('xlsx');
  });

  it('带路径时只看文件名部分', () => {
    expect(extOfName('C:\\work\\dir.v2\\a.png')).toBe('png');
    expect(extOfName('/home/u/doc.md')).toBe('md');
  });

  it('无扩展名与隐藏文件返回空串（按文档族渲染，不猜成代码）', () => {
    expect(extOfName('README')).toBe('');
    expect(extOfName('.gitignore')).toBe('');
    expect(extOfName('a.')).toBe('');
    expect(extOfName('')).toBe('');
    expect(extOfName(undefined as unknown as string)).toBe('');
  });
});

describe('extLabelOf：字标文案', () => {
  it('大写原扩展名，无扩展名返回空串（调用方据此不渲染字标）', () => {
    expect(extLabelOf('a.xlsx')).toBe('XLSX');
    expect(extLabelOf('a.JpG')).toBe('JPG');
    expect(extLabelOf('README')).toBe('');
  });
});

describe('fileIconKey：图标族判定（D3）', () => {
  const cases: [string, FileIconKey][] = [
    ['a.png', 'img'],
    ['a.JPG', 'img'],
    ['a.webp', 'img'],
    ['a.svg', 'img'],
    ['a.pdf', 'pdf'],
    ['a.xls', 'xls'],
    ['a.xlsx', 'xls'],
    ['a.csv', 'xls'],
    ['a.ppt', 'ppt'],
    ['a.pptx', 'ppt'],
    ['a.zip', 'zip'],
    ['a.tar', 'zip'],
    ['a.7z', 'zip'],
    ['a.ts', 'code'],
    ['a.vue', 'code'],
    ['a.py', 'code'],
    ['a.json', 'code'],
    ['a.md', 'md'],
    ['a.txt', 'md'],
    ['a.log', 'md'],
  ];

  it.each(cases)('%s → %s', (name, key) => {
    expect(fileIconKey(name)).toBe(key);
  });

  it('未知扩展名与无扩展名统一落到 doc 族（不做第 9 种兜底图标）', () => {
    expect(fileIconKey('a.doc')).toBe('doc');
    expect(fileIconKey('a.docx')).toBe('doc');
    expect(fileIconKey('a.unknown')).toBe('doc');
    expect(fileIconKey('README')).toBe('doc');
    expect(fileIconKey('.gitignore')).toBe('doc');
  });

  it('大小写不敏感', () => {
    expect(fileIconKey('A.PDF')).toBe('pdf');
    expect(fileIconKey('A.TS')).toBe('code');
  });
});

describe('isImageName：是否为图片（决定是否取缩略图/用图片砖）', () => {
  it('图片扩展名命中', () => {
    for (const n of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico', 'a.avif', 'a.svg']) {
      expect(isImageName(n)).toBe(true);
    }
  });

  it('非图片不命中', () => {
    for (const n of ['a.pdf', 'a.txt', 'a.ts', 'a.zip', 'README', '']) {
      expect(isImageName(n)).toBe(false);
    }
  });
});

describe('imgTagOf：图片角标文案', () => {
  it('常见格式给具体格式，其余给 IMG', () => {
    expect(imgTagOf('a.png')).toBe('PNG');
    expect(imgTagOf('a.jpg')).toBe('JPG');
    expect(imgTagOf('a.jpeg')).toBe('JPG');
    expect(imgTagOf('a.gif')).toBe('GIF');
    expect(imgTagOf('a.webp')).toBe('WEBP');
    expect(imgTagOf('a.svg')).toBe('SVG');
    expect(imgTagOf('a.bmp')).toBe('IMG');
    expect(imgTagOf('a.avif')).toBe('IMG');
  });
});

describe('fileIconSvg：内联 SVG 符合项目图标规范', () => {
  it('16 视口 + currentColor + stroke-width 1.6 + 圆头圆角 + 无颜色写死', () => {
    const svg = fileIconSvg('a.pdf');
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.6"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('aria-hidden="true"');
    // 不写死任何具体色值（着色交给外层 color）
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(svg).not.toMatch(/rgba?\(/);
  });

  it('尺寸可指定（待发送区 24px、气泡内 16px、图片占位 28px）', () => {
    expect(fileIconSvg('a.pdf', 24)).toContain('width="24" height="24"');
    expect(fileIconSvg('a.pdf')).toContain('width="16" height="16"');
  });

  it('同族用同一组路径，不同族路径不同', () => {
    const pdf = fileIconSvg('a.pdf');
    const stillPdf = fileIconSvg('b.PDF');
    expect(pdf).toBe(stillPdf);
    expect(fileIconSvg('a.ts')).not.toBe(pdf);
    expect(fileIconSvg('a.png')).not.toBe(pdf);
  });

  it('每个族都有非空路径（防止漏配导致空图标）', () => {
    const keys: FileIconKey[] = ['img', 'doc', 'pdf', 'xls', 'ppt', 'code', 'md', 'zip'];
    for (const k of keys) {
      expect(iconPathOf(k).length).toBeGreaterThan(10);
    }
  });
});
