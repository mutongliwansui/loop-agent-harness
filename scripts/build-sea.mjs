import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

console.log('[build:sea] 1/4 tsup 打包 CJS 单文件...');
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
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: 'dist-sea/index.cjs',
      output: 'dist-sea/sea-prep.blob',
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
);

console.log('[build:sea] 2/4 生成 SEA blob...');
runNode(['--experimental-sea-config', seaConfigPath], root);
rmSync(seaConfigPath, { force: true });

const exeName = process.platform === 'win32' ? 'loop-agent.exe' : 'loop-agent';
const target = resolve(outDir, exeName);
console.log(`[build:sea] 3/4 复制 Node 运行时为产物骨架: ${exeName}`);
cpSync(process.execPath, target);

console.log('[build:sea] 4/4 注入 SEA blob...');
await inject(
  target,
  'NODE_SEA_BLOB',
  readFileSync(resolve(outDir, 'sea-prep.blob')),
  { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' },
);

console.log(`\n[build:sea] 完成: ${target}`);
