// Builds the Claude Desktop extension (.mcpb): the server bundled into one file with
// esbuild (no node_modules to ship) plus extension/manifest.json with the version
// taken from package.json.
// Usage: npm run bundle:extension  →  dist-extension/swimlane-mcp-<version>.mcpb
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { stdioCompatPlugin } from './stdio-compat.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-extension');
const stage = join(out, 'stage');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(stage, 'server', 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${manifest.compatibility.runtimes.node.match(/\d+/)[0]}`,
  minify: true,
  sourcemap: false,
  legalComments: 'external',
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [stdioCompatPlugin],
  logLevel: 'warning',
});

cpSync(join(root, 'extension', 'icon.png'), join(stage, 'icon.png'));
cpSync(join(root, 'extension', 'mcpb-resources'), join(stage, 'mcpb-resources'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
// The server reads its version from ../package.json.
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2)}\n`
);

const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
const file = join(out, `swimlane-mcp-${pkg.version}.mcpb`);
const run = (args) => execFileSync(mcpb, args, { stdio: 'inherit', shell: process.platform === 'win32' });
run(['validate', join(stage, 'manifest.json')]);
run(['pack', stage, file]);
console.error(`\nExtension ready: ${file}`);
