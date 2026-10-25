import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const { build } = require('tsup');
const { inject } = require('postject');

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'dist-sea');

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(outDir, { recursive: true, force: true });

console.log('[build:sea] 1/5 tsup 打包 CJS 单文件...');
await build({
  entry: { index: resolve(root, 'src/index.ts') },
  format: ['cjs'],
  outDir,
  clean: true,
  platform: 'node',
  target: 'node20',
  splitting: false,
  sourcemap: false,
  noExternal: [/^(?!node:)/],
  // 依赖链 openai→node-fetch→whatwg-url→tr46 在模块加载时 require 内置 punycode，
  // Node 22+ 会打印 DEP0040 弃用警告，且该警告发生在内置模块编译期，process.on('warning')
  // 无法拦截；esbuild 的 alias 也会被 platform=node 的内置模块解析短路。这里用 plugin
  // 把 punycode 重定向到用户态 punycode npm 包（内置版镜像，devDependencies），bundle
  // 不再加载内置模块，警告源头消失。待 openai 升级移除 node-fetch 后可删除本配置。
  esbuildPlugins: [
    {
      name: 'punycode-userland',
      setup(build) {
        // 注意：require.resolve('punycode') 会命中 Node 内置模块名而返回裸字符串 'punycode'，
        // 不能用；必须显式指向 npm 包文件（punycode@2 的 main 为 punycode.js）。
        build.onResolve({ filter: /^punycode$/ }, () => ({
          path: resolve(root, 'node_modules/punycode/punycode.js'),
        }));
      },
    },
  ],
});

const seaConfigPath = resolve(root, 'sea-config.json');

// 递归枚举 webui/dist 内嵌为 SEA assets（单文件分发：exe 自带 WebUI；dist 未构建则纯后端）
function walkFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

const webuiDist = resolve(root, 'webui/dist');
const assets = {};
if (existsSync(webuiDist)) {
  for (const f of walkFiles(webuiDist)) {
    const key = relative(webuiDist, f).split(sep).join('/');
    assets[key] = relative(root, f).split(sep).join('/');
  }
  console.log(`[build:sea] 内嵌 WebUI 资源: ${Object.keys(assets).length} 个文件`);
} else {
  console.log('[build:sea] webui/dist 不存在，跳过前端内嵌（纯后端 exe）');
}

// ── 内嵌原生模块（PTY）───────────────────────────────────────────────
// SEA 的 blob 不能 dlopen 内存里的 .node（process.dlopen 要求真实文件系统路径），
// 官方推荐做法是「作为 asset 内嵌 → 运行时写临时文件 → 再加载」，见
// src/terminal/pty-embed.ts。这里负责把整棵 @lydell 目录树灌进 assets。
//
// 必须整树：平台包的 lib/*.js 用相对路径 require prebuilds/<plat-arch>/conpty.node，
// windowsPtyAgent.js 还用 __dirname fork 子进程，conpty.dll/OpenConsole.exe 在子目录。
// 只内嵌 .node 会在运行时炸。
//
// 剔除 .pdb / .map：.pdb 是调试符号，实测把 1.59MB 撑到 11.71MB，运行时毫无用处。
const NATIVE_PKGS = ['@lydell/node-pty', `@lydell/node-pty-${process.platform}-${process.arch}`];
const NATIVE_SKIP = /\.(pdb|map)$/i;

/** 递归收集原生包文件，返回相对仓库根、POSIX 分隔的路径列表 */
function collectNativeFiles() {
  const files = [];
  for (const pkg of NATIVE_PKGS) {
    const base = resolve(root, 'node_modules', pkg);
    if (!existsSync(base)) {
      console.warn(
        `[build:sea] 警告: ${pkg} 未安装，exe 将缺少 PTY 能力（终端降级为「不可用」）。` +
          '先执行 npm i 再打包可修复。',
      );
      continue;
    }
    for (const f of walkFiles(base)) {
      if (NATIVE_SKIP.test(f)) continue;
      files.push(relative(root, f).split(sep).join('/'));
    }
  }
  return files;
}

const nativeFiles = collectNativeFiles();
let nativeBytes = 0;
for (const rel of nativeFiles) {
  // assets key 直接沿用仓库内相对路径（node_modules/@lydell/...），
  // 这样运行时按 key 释放到目录后，目录结构天然就是 require 期望的形状，
  // 不需要再做任何路径映射。
  assets[rel] = rel;
  nativeBytes += statSync(resolve(root, rel)).size;
}

if (nativeFiles.length > 0) {
  // 清单必须内嵌：sea.getAssetKeys() 自 Node v24.8.0 才有，而本项目 engines >= 20.10。
  // id 是内容指纹，运行时用它做释放目录名（多版本并存 + 幂等）。
  const hash = createHash('sha256');
  for (const rel of nativeFiles.sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(String(statSync(resolve(root, rel)).size));
    hash.update('\0');
    hash.update(readFileSync(resolve(root, rel)));
    hash.update('\0');
  }
  const id = hash.digest('hex').slice(0, 12);
  // sizes 与 files 一一对应：运行时用它识别「文件在但被写了一半」的截断态。
  const manifest = {
    id,
    files: nativeFiles,
    sizes: nativeFiles.map((rel) => statSync(resolve(root, rel)).size),
  };
  const manifestPath = resolve(outDir, 'pty-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assets['pty-manifest.json'] = relative(root, manifestPath).split(sep).join('/');
  console.log(
    `[build:sea] 内嵌原生模块: ${nativeFiles.length} 个文件, ` +
      `${(nativeBytes / 1024 / 1024).toFixed(2)} MB, id=${id}`,
  );
} else {
  console.warn('[build:sea] 未内嵌原生模块，产物将不含 PTY 能力');
}

writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: 'dist-sea/index.cjs',
      output: 'dist-sea/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      assets,
    },
    null,
    2,
  ),
);

console.log('[build:sea] 2/5 生成 SEA blob...');
runNode(['--experimental-sea-config', seaConfigPath], root);
rmSync(seaConfigPath, { force: true });

const exeName = process.platform === 'win32' ? 'loop-agent.exe' : 'loop-agent';
const target = resolve(outDir, exeName);
console.log(`[build:sea] 3/5 复制 Node 运行时为产物骨架: ${exeName}`);
cpSync(process.execPath, target);

console.log('[build:sea] 4/5 注入 SEA blob...');
await inject(
  target,
  'NODE_SEA_BLOB',
  readFileSync(resolve(outDir, 'sea-prep.blob')),
  { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' },
);

// 保留「exe + 同级 node_modules」形态：解析链第 2/3 级走磁盘（零开销），
// 内嵌释放是第 4 级兜底。两者并存意味着：本地调试、老部署形态继续零成本，
// 单文件分发也能用（Task-20261027-002 D6）。
console.log('[build:sea] 5/5 拷贝原生依赖（保留兼容形态：exe + 同级 node_modules）...');
const nativePkgs = ['@lydell/node-pty', `@lydell/node-pty-${process.platform}-${process.arch}`];
let nativeCopied = 0;
for (const pkg of nativePkgs) {
  const from = resolve(root, 'node_modules', pkg);
  if (!existsSync(from)) {
    console.warn(`[build:sea] 警告: ${pkg} 未安装，跳过拷贝（exe 内嵌部分同样缺失）`);
    continue;
  }
  cpSync(from, resolve(outDir, 'node_modules', pkg), { recursive: true });
  nativeCopied += 1;
}
console.log(`[build:sea] 原生依赖已拷贝: ${nativeCopied}/${nativePkgs.length} 个包`);

console.log(`\n[build:sea] 完成: ${target}`);
console.log(
  `[build:sea] 可直接分发单文件 ${exeName}（终端能力已内嵌，约 +${(nativeBytes / 1024 / 1024).toFixed(1)}MB）`,
);
console.log('[build:sea] 也可连同 dist-sea/node_modules/ 一起分发（磁盘优先，零释放开销）');
