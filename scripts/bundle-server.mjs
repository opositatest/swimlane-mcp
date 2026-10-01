// Compile the reusable modules, then bundle the CLI with the reviewed stdio fix.
// The npm package and Desktop extension never depend on consumer install scripts.
import { execFileSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { stdioCompatPlugin } from './stdio-compat.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'build'), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});
await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(root, 'build', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'external',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  plugins: [stdioCompatPlugin],
  logLevel: 'warning',
});
chmodSync(join(root, 'build', 'main.js'), 0o755);
