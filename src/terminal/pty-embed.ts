// SEA 内嵌原生模块（PTY）的运行时释放（Task-20261027-002）
//
// 背景：SEA 的 blob 只能内嵌 JS 与静态 asset；`.node` 无法直接从内存 dlopen
// （`process.dlopen()` 要求真实文件系统路径，Node 官方文档明确说明）。官方推荐做法
// 就是「作为 asset 内嵌 → 运行时写临时文件 → 再加载」，本模块即该做法的工程化：
//
// - **整树释放**：`@lydell/node-pty-win32-x64` 的 `lib/*.js` 用相对路径 require
//   `prebuilds/<platform-arch>/conpty.node`，`windowsPtyAgent.js` 用 `__dirname` fork
//   子进程，`conpty.dll`/`OpenConsole.exe` 在子目录——只嵌 `.node` 必炸，故整树内嵌。
// - **指纹目录**（D3）：目录名带内容哈希，天然幂等 + 多版本并存，升级 exe 不会删掉
//   正在运行的旧实例的模块。
// - **原子发布**（D4）：先写 `*.tmp-<pid>-<rand>` 再 rename，避免「边写边读」读到半个
//   文件。Windows 上 rename 到已存在目录会抛 EPERM/ENOTEMPTY，需判目标可用后复用。
// - **损坏自愈**（D5）：`%TEMP%` 可能被清理工具删掉一半，故以 `.ready` 标记 + 关键
//   二进制完好性双重校验，不满足就重建，绝不允许「目录在但文件缺」的僵尸态被复用。
//   实测补充：目录被**其他活实例**占着时，`rmSync`/`renameSync` 在 Windows 上必然
//   EPERM（.node 被映射进进程地址空间，既删不掉也覆盖不了）。此时若只走
//   「rm + rename」就会永久失败——重启也修不好，终端永久不可用。故补齐两条路径：
//   **原地补缺**（只写缺失/截断的文件）与**备用目录**（`-b1`/`-b2`）。
//
// 全部失败都收敛为 null（不抛），调用方按 `pty_missing` 降级——不能因为原生模块
// 的问题让整个服务起不来（20261027-001 的既定约束）。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSeaRuntime, readSeaAsset, readSeaAssetText } from '../sea-assets.js';

/** 内嵌清单的 asset key（构建期由 build-sea.mjs 生成） */
export const PTY_MANIFEST_KEY = 'pty-manifest.json';

/** 释放目录前缀（带内容指纹，见 D3） */
const DIR_PREFIX = 'loop-agent-pty-';

/** 完成标记：只有它存在且关键二进制齐全，目录才可被复用（D5） */
const READY_MARKER = '.ready';

/** staging 残留清理年龄阈值（1 小时；只清自己产生的 .tmp-*，见 D9） */
const STALE_TMP_MS = 60 * 60 * 1000;

/** 备用目录后缀（规范目录被活进程占用时依次尝试，见文件头「损坏自愈」） */
const ALT_SUFFIXES = ['', '-b1', '-b2'];

/** 内嵌清单结构 */
export interface PtyManifest {
  /** 内容指纹（目录名后缀） */
  id: string;
  /** 相对释放根的文件路径列表（POSIX 分隔符） */
  files: string[];
  /**
   * 与 `files` 一一对应的字节数（可选）。
   * 有它才能发现「文件在但被写了一半」的截断态；旧产物没有该字段时退化为仅校验存在性。
   */
  sizes?: number[];
}

/** 释放结果 */
export interface EmbeddedPtyInfo {
  /** 释放根目录（内含 node_modules/） */
  root: string;
  /** 供 createRequire 使用的基准文件路径（不必真实存在） */
  anchor: string;
}

let cached: EmbeddedPtyInfo | null | undefined;
let lastError: string | null = null;

/** 上一次释放失败的原因（供提示文案展示）；成功或未尝试时为 null。 */
export function lastEmbeddedPtyError(): string | null {
  return lastError;
}

/**
 * 解析内嵌清单。非 SEA 或未内嵌（构建时没装原生包）返回 null。
 * 注意：不能用 `sea.getAssetKeys()`——它自 Node **v24.8.0** 才有，
 * 而本项目 `engines.node >= 20.10`，在 Node 20/22 上调用即崩（D2）。
 */
export function readPtyManifest(): PtyManifest | null {
  const text = readSeaAssetText(PTY_MANIFEST_KEY);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<PtyManifest>;
    if (typeof parsed.id !== 'string' || !/^[0-9a-f]{6,32}$/.test(parsed.id)) return null;
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) return null;
    const files = parsed.files.filter((f) => typeof f === 'string');
    if (files.length !== parsed.files.length) return null;
    // sizes 可选；给了就必须与 files 等长且全为有限非负数，否则整份清单作废
    // （宁可当没内嵌，也不要按错误的尺寸判据把损坏目录当完好）
    let sizes: number[] | undefined;
    if (parsed.sizes !== undefined) {
      if (!Array.isArray(parsed.sizes) || parsed.sizes.length !== files.length) return null;
      if (!parsed.sizes.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
      sizes = parsed.sizes as number[];
    }
    return { id: parsed.id, files, sizes };
  } catch {
    return null;
  }
}


/** 是否有可用的内嵌 PTY（只判断清单可读，不触发释放）。非 SEA 直接 false，零副作用。 */
export function hasEmbeddedPty(): boolean {
  return readPtyManifest() !== null;
}

/** 释放根目录（按指纹）。 */
export function embeddedPtyRoot(id: string): string {
  return join(tmpdir(), DIR_PREFIX + id);
}

/**
 * 候选释放目录（规范目录优先，其后是备用目录）。
 * 备用目录只在「规范目录被活进程占用、既删不掉也补不齐」时才会被用到，
 * 正常情况下永远只碰第一个。
 */
export function embeddedPtyRoots(id: string): string[] {
  const base = embeddedPtyRoot(id);
  return ALT_SUFFIXES.map((s) => base + s);
}

/**
 * 单文件是否完好：有尺寸信息时校验字节数（可发现截断），否则只校验存在。
 * `.ready` 只说明「曾经写完」，清理工具或崩溃都能让它在文件已缺时残留，故必须逐个复查。
 */
function isIntact(root: string, rel: string, manifest: PtyManifest, index: number): boolean {
  const expect = manifest.sizes?.[index];
  try {
    const st = statSync(join(root, rel));
    if (!st.isFile()) return false;
    return typeof expect === 'number' ? st.size === expect : true;
  } catch {
    return false;
  }
}

/**
 * 判断释放目录是否真的可用（D5）：
 * `.ready` 存在 **且** 清单里所有原生二进制都完好。
 *
 * 为什么以「所有 .node 完好」为判据：`%TEMP%` 被清理工具删掉一半时，会留下
 * 「目录在、`.ready` 在、但 `.node` 没了」的僵尸态；若只看目录存在就复用，
 * 会永久性坏掉（每次启动都坏）。stat 24 个文件的成本可忽略，远低于重新解析 1.59MB。
 */
export function isExtractedUsable(root: string, manifest: PtyManifest): boolean {
  if (!existsSync(join(root, READY_MARKER))) return false;
  const natives = manifest.files
    .map((rel, i) => ({ rel, i }))
    .filter(({ rel }) => rel.endsWith('.node'));
  // 清单里没有原生文件时退化为「只看 .ready」，避免异常清单导致永久不可用
  if (natives.length === 0) return true;
  return natives.every(({ rel, i }) => isIntact(root, rel, manifest, i));
}

/**
 * 逐文件解包到目标目录（保留相对结构，见文件头「整树释放」说明）。
 *
 * `repair=true` 用于原地补缺：已完好（尺寸相符）的文件跳过，只写缺失或被截断的，
 * 最后才写 `.ready`——中途失败绝不会留下「标记在、文件缺」的假可用目录。
 */
function extractTo(target: string, manifest: PtyManifest, repair = false): void {
  manifest.files.forEach((rel, i) => {
    const dst = join(target, rel);
    if (repair && isIntact(target, rel, manifest, i)) return;
    const buf = readSeaAsset(rel);
    if (!buf) throw new Error(`内嵌资源缺失: ${rel}`);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
  });
  writeFileSync(join(target, READY_MARKER), manifest.id);
}

/** 清理上次进程崩溃留下的 staging 残留（只碰同前缀 + 超龄的 .tmp-*，失败忽略） */
function sweepStaleStaging(): void {
  try {
    const base = tmpdir();
    const now = Date.now();
    for (const name of readdirSync(base)) {
      if (!name.startsWith(DIR_PREFIX) || !name.includes('.tmp-')) continue;
      const full = join(base, name);
      try {
        if (now - statSync(full).mtimeMs < STALE_TMP_MS) continue;
        rmSync(full, { recursive: true, force: true });
      } catch {
        // 可能正被其他实例使用，忽略
      }
    }
  } catch {
    // 临时目录不可读也不能影响主链路
  }
}

/**
 * 把某个候选目录建成可用状态：成功返回 null，失败返回原因（供提示文案展示）。
 *
 * 两条路径，按「能不能删干净」分流：
 * ① **删得掉** → staging 写满再原子 rename（正常路径，读到半个文件的窗口为零，D4）。
 * ② **删不掉**（Windows 上目录里有活进程映射的 `.node` 时必然 EPERM）→ **原地补缺**。
 *    这条不是兜底掩盖：指纹目录里的内容按定义是同一份字节，缺什么补什么即可，
 *    因此不需要新建目录；真正补不齐（缺的正好是被锁的那个文件）才交给下一个候选目录。
 */
function tryBuild(root: string, manifest: PtyManifest): string | null {
  let removed = false;
  try {
    rmSync(root, { recursive: true, force: true });
    removed = !existsSync(root);
  } catch {
    removed = false;
  }

  if (removed) {
    const staging = `${root}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      extractTo(staging, manifest);
      try {
        renameSync(staging, root);
      } catch (e) {
        // D4：Windows 上 rename 到已存在目录会抛 EPERM/ENOTEMPTY/EEXIST。
        // 若此时目标已可用，说明另一实例刚发布完成，直接复用即可。
        if (!isExtractedUsable(root, manifest)) throw e;
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return isExtractedUsable(root, manifest) ? null : `staging 发布后校验失败: ${root}`;
  }

  // ② 原地补缺：先摘掉 .ready，修好之前任何实例都不许把它当可用
  try {
    rmSync(join(root, READY_MARKER), { force: true });
  } catch {
    // .ready 也可能被锁；后续 extractTo 会覆盖写，不是致命问题
  }
  try {
    mkdirSync(root, { recursive: true });
    extractTo(root, manifest, true);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return isExtractedUsable(root, manifest) ? null : `原地补缺后校验失败: ${root}`;
}

/**
 * 幂等释放内嵌 PTY 并返回可加载目录；任何失败返回 null（不抛）。
 * 进程内只做一次（结果含失败结果一并缓存，避免每次 spawn 重复 1.59MB 校验）。
 */
export function ensureEmbeddedPty(): EmbeddedPtyInfo | null {
  if (cached !== undefined) return cached;

  try {
    if (!isSeaRuntime()) {
      cached = null;
      return null;
    }
    const manifest = readPtyManifest();
    if (!manifest) {
      lastError = `未内嵌 ${PTY_MANIFEST_KEY}（打包时可能未安装原生依赖）`;
      cached = null;
      return null;
    }

    const reasons: string[] = [];
    let built = false;
    for (const root of embeddedPtyRoots(manifest.id)) {
      // 已可用（正常路径 / 另一实例刚发完）：零写入直接复用
      if (!isExtractedUsable(root, manifest)) {
        built = true;
        const reason = tryBuild(root, manifest);
        if (reason) {
          reasons.push(`${root}：${reason}`);
          continue;
        }
      }
      lastError = null;
      if (built) sweepStaleStaging();
      cached = { root, anchor: join(root, '__pty_resolve__.js') };
      return cached;
    }

    lastError = `内嵌模块释放失败（候选目录均不可用）${reasons.join('；')}`;
    sweepStaleStaging();
    cached = null;
    return null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    cached = null;
    return null;
  }
}


/** 复位缓存（仅单测用）。 */
export function resetEmbeddedPtyCache(): void {
  cached = undefined;
  lastError = null;
}
