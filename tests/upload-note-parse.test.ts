// 上传 note 解析 / 剥离 / 重建单测（需求 20261113-003 D1/D4/D5）
//
// 覆盖：buildContextNote 与 parse/rebuild 的往返一致性、误剥防护（用户手打同名字样）、
// 多附件、部分字段缺失、parse 的逆运算（formatBytes）。
import { describe, it, expect } from 'vitest';
import {
  buildContextNote,
  formatBytes,
  parseUploadNotes,
  rebuildContextNote,
  stripUploadNotes,
  type UploadEntry,
} from '../src/upload/manager.js';

/** 构造一个上传记录（图片） */
function imgEntry(name = '20261113-094256-paste.png'): UploadEntry {
  return {
    originalPath: `C:\\Users\\muton\\Pictures\\${name}`,
    targetPath: `C:\\Users\\muton\\.loop-agent\\uploads\\sess_522b6010_20261113_094254\\${name}`,
    fileName: name,
    bytes: 73011,
    uploadedAt: '2026-11-13T09:42:56.000Z',
  };
}

/** 构造一个上传记录（非图片：无 MIME 行） */
function txtEntry(name = '20261113-095000-notes.txt'): UploadEntry {
  return {
    originalPath: `D:\\work\\${name}`,
    targetPath: `C:\\Users\\muton\\.loop-agent\\uploads\\sess_x\\${name}`,
    fileName: name,
    bytes: 1536,
    uploadedAt: '2026-11-13T09:50:00.000Z',
  };
}

describe('parseUploadNotes / rebuildContextNote 往返一致（D5/D4）', () => {
  it('图片 note：解析出 fileName/bytes/path/mime 全部字段', () => {
    const note = buildContextNote(imgEntry());
    const [a] = parseUploadNotes(note);
    expect(a).toEqual({
      fileName: '20261113-094256-paste.png',
      bytes: 73011,
      path: 'C:\\Users\\muton\\.loop-agent\\uploads\\sess_522b6010_20261113_094254\\20261113-094256-paste.png',
      mime: 'image/png',
    });
  });

  it('rebuildContextNote 输出与 buildContextNote 逐字节一致（重试等价性）', () => {
    const entry = imgEntry();
    const note = buildContextNote(entry);
    const [parsed] = parseUploadNotes(note);
    expect(rebuildContextNote(parsed)).toBe(note);
  });

  it('非图片 note 无 MIME 行，往返同样一致', () => {
    const entry = txtEntry();
    const note = buildContextNote(entry);
    const [parsed] = parseUploadNotes(note);
    expect(parsed.mime).toBeUndefined();
    expect(parsed.bytes).toBe(1536);
    expect(rebuildContextNote(parsed)).toBe(note);
  });

  it('bytes 往返精确：各档位经 formatBytes 再解析不丢值', () => {
    // 注意：formatBytes 保留 1 位小数，故只有能精确表示的数值才可无损往返
    for (const bytes of [0, 512, 1024, 10 * 1024, 1024 * 1024, 5 * 1024 * 1024]) {
      const entry = { ...txtEntry(), bytes };
      const note = buildContextNote(entry);
      const [parsed] = parseUploadNotes(note);
      expect(parsed.bytes).toBe(bytes);
      expect(rebuildContextNote(parsed)).toBe(note);
    }
  });
});

describe('stripUploadNotes 剥离正文（D1）', () => {
  it('单附件：note 与正文之间空行一并剥离，正文原样保留', () => {
    const note = buildContextNote(imgEntry());
    const content = `${note}\n\n这张图里有什么？`;
    expect(stripUploadNotes(content)).toBe('这张图里有什么？');
  });

  it('多附件：全部 note 剥离，正文保留', () => {
    const c1 = buildContextNote(imgEntry('a.png'));
    const c2 = buildContextNote(imgEntry('b.png'));
    const content = `${c1}\n\n${c2}\n\n对比这两张图`;
    expect(stripUploadNotes(content)).toBe('对比这两张图');
  });

  it('无 note 的普通消息逐字节不变（D2 零膨胀前提）', () => {
    const plain = '你好，今天天气怎么样？';
    expect(stripUploadNotes(plain)).toBe(plain);
  });

  it('只有附件没有正文：剥离后为空串', () => {
    const content = `${buildContextNote(imgEntry())}\n\n`;
    expect(stripUploadNotes(content)).toBe('');
  });

  it('剥离幂等：对已剥离文本再剥一次不变', () => {
    const content = `${buildContextNote(imgEntry())}\n\n问题正文`;
    const once = stripUploadNotes(content);
    expect(stripUploadNotes(once)).toBe(once);
  });
});

describe('误剥防护（D5 边界）', () => {
  it('用户手打「[文件上传] xxx」但无「上传路径」行 → 不剥离、不解析', () => {
    const content = '[文件上传] 这不是真的附件\n\n我的正文';
    expect(stripUploadNotes(content)).toBe(content);
    expect(parseUploadNotes(content)).toEqual([]);
  });

  it('正文中间出现 note 字样但结构不完整 → 原样保留', () => {
    const content = '讨论一下 [文件上传] 这个标记的含义';
    expect(stripUploadNotes(content)).toBe(content);
  });

  it('note 后紧跟正文（无空行）也能正确剥离', () => {
    const content = `${buildContextNote(imgEntry())}\n紧邻的正文`;
    expect(stripUploadNotes(content)).toBe('紧邻的正文');
  });
});

describe('部分字段缺失的容错', () => {
  it('缺「大小」行：仍解析出附件，bytes 记 0', () => {
    const content = '[文件上传] x.png\n  上传路径: /tmp/x.png\n\n正文';
    const [a] = parseUploadNotes(content);
    expect(a).toEqual({ fileName: 'x.png', bytes: 0, path: '/tmp/x.png' });
    expect(stripUploadNotes(content)).toBe('正文');
  });

  it('缺「类型」行（非图片）：mime 缺省', () => {
    const content = '[文件上传] x.bin\n  上传路径: /tmp/x.bin\n  大小: 2.0KB';
    const [a] = parseUploadNotes(content);
    expect(a.mime).toBeUndefined();
    expect(a.bytes).toBe(2048);
  });

  it('文件名或路径为空 → 不算 note', () => {
    const content = '[文件上传] \n  上传路径: /tmp/x.png\n\n正文';
    expect(parseUploadNotes(content)).toEqual([]);
    expect(stripUploadNotes(content)).toBe(content);
  });

  it('非法大小串 → bytes 记 0，不抛错', () => {
    const content = '[文件上传] x.png\n  上传路径: /tmp/x.png\n  大小: 未知';
    const [a] = parseUploadNotes(content);
    expect(a.bytes).toBe(0);
  });
});

describe('跨平台路径（D5 不用路径正则）', () => {
  it('POSIX 路径正常解析', () => {
    const content = '[文件上传] p.png\n  上传路径: /home/u/.loop-agent/uploads/s/p.png\n  大小: 1.0KB';
    const [a] = parseUploadNotes(content);
    expect(a.path).toBe('/home/u/.loop-agent/uploads/s/p.png');
  });

  it('UNC 路径（反斜杠开头）正常解析', () => {
    const content = '[文件上传] u.png\n  上传路径: \\\\server\\share\\u.png\n  大小: 1.0KB';
    const [a] = parseUploadNotes(content);
    expect(a.path).toBe('\\\\server\\share\\u.png');
  });

  it('Windows 盘符路径正常解析', () => {
    const content = '[文件上传] w.png\n  上传路径: C:\\Users\\a\\w.png\n  大小: 1.0KB';
    const [a] = parseUploadNotes(content);
    expect(a.path).toBe('C:\\Users\\a\\w.png');
  });
});

describe('formatBytes 与 parseSizeText 逆运算', () => {
  it('各档位格式化后可被解析回原值', () => {
    expect(parseUploadNotes(`[文件上传] a\n  上传路径: /p\n  大小: ${formatBytes(999)}`)[0].bytes).toBe(999);
    expect(parseUploadNotes(`[文件上传] a\n  上传路径: /p\n  大小: ${formatBytes(2048)}`)[0].bytes).toBe(2048);
  });
});
