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
