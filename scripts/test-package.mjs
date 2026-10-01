// Release gate: install the actual tarball with consumer scripts disabled, then
// exercise npm exec, the self-contained CLI and the Desktop entry point by stdio.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeApi } from '../tests/fake-api.ts';
import { MODERN_META, StdioClient } from '../tests/stdio-client.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installed = mkdtempSync(join(tmpdir(), 'swimlane-installed-'));
const isolated = mkdtempSync(join(tmpdir(), 'swimlane-bundle-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check with npm run test:package.');
const runNpm = (args) => execFileSync(process.execPath, [npm, ...args], { cwd: root, encoding: 'utf8' });
let api;

async function check(target, protocol) {
  const client = new StdioClient(
    target.args,
    {
      KANBANFLOW_API_KEYS: 'token-a,token-b',
      KANBANFLOW_USER: 'ada@example.com',
      KANBANFLOW_BASE_URL: api.url,
    },
    target.cwd
  );
  const modern = protocol === '2026-07-28';
  const params = (data = {}) => (modern ? { ...data, _meta: MODERN_META } : data);
  try {
    if (modern) {
      client.send('subscriptions/listen', params({ notifications: { toolsListChanged: true } }));
    } else {
      const init = await client.request('initialize', {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: 'package-smoke-test', version: '1.0.0' },
      });
      assert.equal(init.result?.serverInfo?.name, 'swimlane-mcp');
      assert.equal(init.result?.protocolVersion, protocol);
      client.notify('notifications/initialized');
    }
    const listing = await client.request('tools/list', params());
    assert.deepEqual(listing.result?.tools.map((tool) => tool.name).sort(), [
      'get_task',
      'list_boards',
      'list_comments',
      'list_tasks',
      'list_time_entries',
      'search_tasks',
    ]);
    assert.ok(listing.result.tools.every((tool) => tool.annotations?.readOnlyHint));
    if (modern) await client.waitFor((message) => message.method === 'notifications/subscriptions/acknowledged');
    const response = await client.request('tools/call', params({ name: 'list_tasks', arguments: {} }));
    assert.equal(response.result?.isError, undefined);
    assert.deepEqual(
      response.result?.structuredContent?.tasks.map((task) => task.id),
      ['t1', 'b-1']
    );
    if (modern) {
      client.notify('notifications/cancelled', { requestId: 1 });
      assert.ok((await client.request('tools/list', params())).result?.tools);
    }
    client.child.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP process did not exit after stdin EOF.')), 5_000);
      client.exited.then((code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`MCP process exited with code ${code}.`));
      });
    });
    console.error(`PASS: ${target.name} / MCP ${protocol}`);
  } finally {
    client.kill();
  }
}

try {
  const manifest = JSON.parse(readFileSync(join(root, 'dist-extension', 'stage', 'manifest.json'), 'utf8'));
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.ok(manifest.compatibility.platforms.includes(platform), `Built extension must support ${platform}.`);
  }
  assert.ok(manifest.compatibility.platforms.includes(process.platform), 'Built extension excludes the CI platform.');
  console.error(`PASS: built extension manifest supports ${process.platform} and all advertised platforms.`);
  const [{ filename }] = JSON.parse(runNpm(['pack', '--json', '--pack-destination', installed]));
  runNpm([
    'install',
    '--prefix',
    installed,
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    join(installed, filename),
  ]);
  const pkg = join(installed, 'node_modules', '@opositatest', 'swimlane-mcp');
  cpSync(join(pkg, 'build'), join(isolated, 'build'), { recursive: true });
  cpSync(join(pkg, 'package.json'), join(isolated, 'package.json'));
  api = await startFakeApi();
  const targets = [
    { name: 'installed npm executable', args: [npm, 'exec', '--', 'swimlane-mcp'], cwd: installed },
    { name: 'npm bundle without node_modules', args: [join(isolated, 'build', 'main.js')], cwd: isolated },
    { name: 'Claude Desktop bundle', args: [join(root, 'dist-extension', 'stage', 'server', 'main.js')], cwd: root },
  ];
  for (const target of targets) {
    for (const protocol of ['2025-06-18', '2025-11-25', '2026-07-28']) await check(target, protocol);
  }
} finally {
  await api?.close();
  rmSync(installed, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
}
