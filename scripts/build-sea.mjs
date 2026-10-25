import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

// SEA 的 blob 只能内嵌 JS 与静态 assets，**原生模块（.node）无法内嵌**，
// 必须在运行时从磁盘 require。而 src/terminal/pty-session.ts 的解析基准是
// exe 所在目录（argv[1] 在 SEA 下是 CLI 参数，已排除），所以 node_modules/@lydell
// 必须与 exe 同目录分发；否则 exe 一离开本仓库（换工作空间、单独拷走）就找不到它，
// 前端报「交互式终端不可用 / 请执行 npm i @lydell/node-pty」。
// 注意 @lydell/node-pty 只是 JS 包装，真正的 .node 在平台子包里，两个都要拷。
console.log('[build:sea] 5/5 拷贝原生依赖（随 exe 分发）...');
const nativePkgs = ['@lydell/node-pty', `@lydell/node-pty-${process.platform}-${process.arch}`];
let nativeCopied = 0;
for (const pkg of nativePkgs) {
  const from = resolve(root, 'node_modules', pkg);
  if (!existsSync(from)) {
    console.warn(
      `[build:sea] 警告: ${pkg} 未安装，exe 将缺少 PTY 能力（终端降级为「不可用」）。` +
        '先执行 npm i 再打包可修复。',
    );
    continue;
  }
  cpSync(from, resolve(outDir, 'node_modules', pkg), { recursive: true });
  nativeCopied += 1;
}
console.log(`[build:sea] 原生依赖已随 exe 分发: ${nativeCopied}/${nativePkgs.length} 个包`);

console.log(`\n[build:sea] 完成: ${target}`);
console.log(
  `[build:sea] 分发时请把 ${exeName} 与同目录的 node_modules/ 一起拷走（缺 node_modules 则终端不可用）`,
);
