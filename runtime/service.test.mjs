import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';

const binary = process.env.DOZE_TEST_BINARY;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor(path) {
    this.child = spawn(binary, ['proxy', '--config', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.next = 1;
    this.errors = '';
    this.child.stderr.on('data', b => { this.errors += b; });
    this.exit = new Promise(resolve => this.child.once('exit', resolve));
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.id !== undefined) this.pending.get(message.id)?.(message);
    });
  }
  send(message) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params) {
    const id = this.next++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} ${params?.name ?? ""} timed out: ${this.errors}`)); }, 15_000);
      this.pending.set(id, response => { clearTimeout(timer); this.pending.delete(id); resolve(response); });
      this.send({ id, method, params });
    });
    return { id, promise };
  }
  async initialize() {
    const response = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } }).promise;
    assert.ok(response.result?.capabilities.tools, JSON.stringify(response));
    this.send({ method: 'notifications/initialized' });
    return this;
  }
  call(name, args, thread = 'root', parent) {
    const metadata = { thread_id: thread, thread_source: 'cli', ...(parent ? { thread_source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) };
    return this.request('tools/call', { name, arguments: args, _meta: { 'x-codex-turn-metadata': JSON.stringify(metadata) } });
  }
  async tool(name, args, thread, parent) {
    const response = await this.call(name, args, thread, parent).promise;
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.notEqual(response.result?.isError, true, JSON.stringify(response));
    return response.result;
  }
  cancel(request) {
    this.send({ method: 'notifications/cancelled', params: { requestId: request.id } });
    this.pending.get(request.id)?.({ canceled: true });
  }
  async close() { this.child.stdin.end(); await this.exit; }
}
const text = result => result.content[0].text;
const value = result => JSON.parse(text(result));

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'doze-test-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\doze-test-${randomUUID()}` : `/tmp/doze-test-${randomUUID()}.sock`;
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ token: 'a'.repeat(64), socket_path: socket, node_path: process.execPath,
    daemon_path: fileURLToPath(new URL('./daemon.mjs', import.meta.url)), chrome_path: process.env.DOZE_BROWSER_CHROME ?? '/missing/chrome', operation_timeout_seconds: 3 }));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.child.exitCode === null ? c.close() : undefined));
    // Node exits on its own after its last MCP connection closes.
    await delay(3400);
    assert.notEqual(spawnSync(binary, ['status', '--config', path]).status, 0, 'last disconnect must stop the shared endpoint');
    const logs = readFileSync(join(directory, 'service.log'), 'utf8');
    if (logs.trim()) t.diagnostic(logs.slice(-5000));
    rmSync(directory, { recursive: true, force: true });
    if (process.platform !== 'win32') rmSync(socket, { force: true });
  });
  return {
    async client() { const c = new Client(path); clients.push(c); return c.initialize(); },
    status() { return JSON.parse(execFileSync(binary, ['status', '--config', path], { encoding: 'utf8' })); },
    path, socket,
  };
}

test('concurrent stdio launchers share one cold Node endpoint and SDK schemas', { skip: !binary, timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const [one, two, three] = await Promise.all([f.client(), f.client(), f.client()]);
  assert.deepEqual(f.status(), { connections: 3, pages: 0, browsers: 0 });
  const catalog = (await one.request('tools/list', {}).promise).result.tools;
  assert.equal(catalog.length, 13);
  assert.equal(catalog.find(t => t.name === 'handle_dialog').inputSchema.properties.accept.type, 'boolean');
  const invalid = await two.call('handle_dialog', { page_id: 'missing', accept: 'false' }).promise;
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(text(await three.tool('list_pages', {})), '[]');
  await one.close();
  await delay(50);
  assert.equal(f.status().connections, 2);
  // The lifetime lock prevents an installer from replacing an endpoint in use.
  const stop = spawn(binary, ['stop', '--config', f.path]);
  assert.notEqual(await new Promise(resolve => stop.once('exit', resolve)), 0);
});

test('real Chromium: ownership, native input, dialogs, ordering, cancellation and cleanup', { skip: !binary || !process.env.DOZE_BROWSER_CHROME, timeout: 60_000 }, async t => {
  const html = `<title>Browser contract</title><h1>Example</h1><input aria-label="Name"><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button onclick="alert('outcome may be unknown')">Dialog</button>`;
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.client(), f.client()]);
  const [a, b] = await Promise.all([one.tool('open_page', { url }, 'one'), two.tool('open_page', { url }, 'two')]);
  const page = value(a).page_id;
  const other = value(b).page_id;
  assert.deepEqual(f.status(), { connections: 2, pages: 2, browsers: 1 });
  assert.equal(value(await one.tool('evaluate_script', { page_id: page, expression: "localStorage.setItem('owner','one'); 'OK'" }, 'one')), 'OK');
  assert.equal(value(await two.tool('evaluate_script', { page_id: other, expression: "localStorage.getItem('owner')" }, 'two')), null);
  assert.equal((await two.call('inspect_page', { page_id: page }, 'two').promise).result.isError, true);
  const child = value(await two.tool('open_page', { url }, 'child', 'one')).page_id;
  assert.equal(value(await two.tool('evaluate_script', { page_id: child, expression: "localStorage.getItem('owner')" }, 'child')), 'one');
  assert.equal(value(await two.tool('list_pages', {}, 'child')).length, 1);
  await two.tool('close_page', { page_id: child }, 'child');
  const snapshot = text(await one.tool('inspect_page', { page_id: page }, 'one'));
  assert.match(snapshot, /RootWebArea "Browser contract"/);
  const input = snapshot.match(/uid=(\S+) textbox "Name"/)[1];
  const option = snapshot.match(/uid=(\S+) option "Beta"/)[1];
  await one.tool('fill', { page_id: page, element: input, value: 'Example value' }, 'one');
  await one.tool('click', { page_id: page, element: option }, 'one');
  assert.deepEqual(value(await one.tool('evaluate_script', { page_id: page, expression: '[document.querySelector("input").value,document.querySelector("select").value]' }, 'one')), ['Example value', 'b']);
  const dialog = await one.call('evaluate_script', { page_id: page, expression: "new Promise(resolve => { alert('outcome may be unknown'); setTimeout(() => { window.settled = true; resolve('done'); }, 200); })" }, 'one').promise;
  assert.equal(dialog.result.isError, true);
  assert.match(text(dialog.result), /handle_dialog/);
  assert.equal(f.status().pages, 2);
  await one.tool('handle_dialog', { page_id: page, accept: false }, 'one');
  assert.equal(value(await one.tool('evaluate_script', { page_id: page, expression: 'window.settled' }, 'one')), true);
  const slow = one.tool('evaluate_script', { page_id: page, expression: "new Promise(resolve => setTimeout(() => { window.ordered = 1; resolve(1); }, 250))" }, 'one');
  assert.match(text(await two.tool('inspect_page', { page_id: other }, 'two')), /RootWebArea/);
  const skipped = one.call('evaluate_script', { page_id: page, expression: 'window.canceledRan = true' }, 'one');
  one.cancel(skipped);
  const ordered = one.tool('evaluate_script', { page_id: page, expression: 'window.ordered' }, 'one');
  assert.equal(value(await slow), 1);
  assert.equal(value(await ordered), 1);
  assert.equal(value(await one.tool('evaluate_script', { page_id: page, expression: 'window.canceledRan ?? false' }, 'one')), false);
  const png = (await one.tool('take_screenshot', { page_id: page }, 'one')).content[0];
  assert.equal(png.type, 'image');
  assert.equal(Buffer.from(png.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const active = one.call('evaluate_script', { page_id: page, expression: 'new Promise(() => {})' }, 'one');
  await delay(100);
  const canceled = one.call('evaluate_script', { page_id: page, expression: 'window.canceledRan = true' }, 'one');
  one.cancel(canceled);
  await one.tool('close_page', { page_id: page }, 'one');
  await active.promise;
  await canceled.promise;
  assert.match(text(await two.tool('inspect_page', { page_id: other }, 'two')), /RootWebArea/);
  await two.close();
  await delay(150);
  assert.equal(f.status().pages, 0);
  assert.equal(f.status().browsers, 0);
});

test('a fake IPC endpoint cannot authenticate or obtain the credential', { skip: !binary }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'doze-auth-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\doze-auth-${randomUUID()}` : `/tmp/doze-auth-${randomUUID()}.sock`;
  const path = join(directory, 'config.json');
  const token = 'b'.repeat(64);
  writeFileSync(path, JSON.stringify({ token, socket_path: socket, node_path: process.execPath, daemon_path: 'unused', chrome_path: 'unused' }));
  let received = '';
  const server = createIpcServer(stream => {
    stream.on('data', chunk => {
      received += chunk;
      stream.end(JSON.stringify({ proof: '0'.repeat(64) }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); });
  const child = spawn(binary, ['proxy', '--config', path], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  assert.notEqual(await new Promise(resolve => child.once('exit', resolve)), 0);
  assert.match(errors, /authentication failed/);
  assert.equal(received.includes(token), false);
  assert.deepEqual(Object.keys(JSON.parse(received)), ['nonce']);
});
