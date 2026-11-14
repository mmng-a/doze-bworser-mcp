import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8'));
const key = process.platform + '-' + process.arch;
const artifacts = join(root, 'dist/npm', key);
if (!process.env.npm_execpath) throw new Error('Run with npm run test:npm');
const temporary = await mkdtemp(join(tmpdir(), 'doze npm 日本語 '));
const directory = join(temporary, 'install space');
const home = join(temporary, 'home');
const unrelated = join(temporary, 'working folder');
await Promise.all([mkdir(directory), mkdir(home), mkdir(unrelated)]);
const env = { ...process.env, HOME: home, USERPROFILE: home };
const npm = args => {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: directory, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
};
let child;
let config;
try {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true }));
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    join(artifacts, 'doze-bworser-mcp-' + metadata.version + '.tgz'),
    join(artifacts, 'doze-bworser-mcp-' + key + '-' + metadata.version + '.tgz')]);
  assert.match(npm(['exec', '--offline', '--no', '--', 'doze-bworser-mcp', '--version']), new RegExp('doze-bworser-mcp ' + metadata.version.replaceAll('.', '\\.')));
  const installed = join(directory, 'node_modules/doze-bworser-mcp');
  // Only Node and the installed archives are available to the launched service.
  const isolated = { ...env, PATH: '' };
  child = spawn(process.execPath, [join(installed, 'bin/cli.mjs')], { cwd: unrelated, env: isolated, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', bytes => { errors += bytes; });
  const pending = new Map();
  let next = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const deadline = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out: ' + errors)); }, 15_000);
    pending.set(id, value => { clearTimeout(deadline); pending.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'npm-smoke', version: '1' } });
  assert.equal(initialized.result?.serverInfo.version, metadata.version, JSON.stringify(initialized));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const catalog = await request('tools/list', {});
  assert.equal(catalog.result.tools.length, 16);
  assert.ok(catalog.result.tools.some(tool => tool.name === 'show_page'));
  const pages = await request('tools/call', { name: 'list_pages', arguments: {} });
  assert.equal(pages.result?.content[0].text, '[]');
  config = JSON.parse(await readFile(join(home, '.config/doze-bworser-mcp/config.json'), 'utf8'));
  assert.equal(await realpath(config.daemon_path), await realpath(join(installed, 'runtime/daemon.mjs')));
  assert.equal(config.node_path, process.execPath);
  const closed = once(child, 'exit');
  child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  await new Promise(resolve => setTimeout(resolve, 3500));
  const status = spawnSync(process.execPath, [join(installed, 'bin/cli.mjs'), 'status'], { cwd: unrelated, env: isolated, timeout: 5000 });
  assert.equal(status.status, 1, 'the isolated npm service must stop after disconnect');
  const native = join(directory, 'node_modules', 'doze-bworser-mcp-' + key);
  await rm(native, { recursive: true });
  const missing = spawnSync(process.execPath, [join(installed, 'bin/cli.mjs'), '--version'], { cwd: unrelated, env: isolated, encoding: 'utf8', timeout: 5000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing native package/);
  console.log('npm archive installation, command shim, isolated MCP, version and missing-native checks passed (' + key + ')');
} finally {
  if (child?.exitCode === null) child.kill();
  await rm(temporary, { recursive: true, force: true });
  if (config && process.platform !== 'win32') await rm(dirname(config.socket_path), { recursive: true, force: true });
}
