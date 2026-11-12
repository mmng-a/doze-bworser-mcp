import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createIpcServer } from 'node:net';

const binary = process.env.DOZE_TEST_BINARY;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor(path, env = process.env, requestTimeout = 30_000) {
    this.child = spawn(binary, path ? ['--internal', 'proxy', path] : ['proxy'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.requestTimeout = requestTimeout;
    this.pending = new Map();
    this.next = 1;
    this.errors = '';
    this.cwd = process.cwd();
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} ${params?.name ?? ""} timed out: ${this.errors}`)); }, this.requestTimeout);
      this.pending.set(id, response => { clearTimeout(timer); this.pending.delete(id); resolve(response); });
      this.send({ id, method, params });
    });
    return { id, promise };
  }
  async initialize() {
    const response = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration', version: '1' } }).promise;
    assert.ok(response.result?.capabilities.tools, JSON.stringify(response));
    assert.ok(response.result.capabilities.experimental?.['codex/sandbox-state']);
    this.send({ method: 'notifications/initialized' });
    return this;
  }
  call(name, args, thread = 'root', parent) {
    const metadata = { thread_id: thread, thread_source: 'cli',
      ...(parent ? { thread_source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) };
    return this.request('tools/call', { name, arguments: args, _meta: { 'x-codex-turn-metadata': JSON.stringify(metadata),
      'codex/sandbox-state': { sandboxCwd: pathToFileURL(this.cwd).href } } });
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

async function waitForShutdown(path, env = process.env) {
  const deadline = Date.now() + 12_000;
  do {
    // A status connection restarts the three-second idle grace; frequent polling prevents exit.
    await delay(3400);
    const result = spawnSync(binary, path ? ['--internal', 'status', path] : ['status'], { env, timeout: 3000 });
    if (result.error) throw result.error;
    if (result.status !== 0) return;
  } while (Date.now() < deadline);
  assert.fail('last disconnect must stop the shared endpoint after browser cleanup and idle grace');
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'doze-test-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\doze-test-${randomUUID()}` : `/tmp/doze-test-${randomUUID()}.sock`;
  const path = join(directory, 'config.json');
  writeFileSync(path, JSON.stringify({ token: 'a'.repeat(64), socket_path: socket, node_path: process.execPath,
    daemon_path: fileURLToPath(new URL('./daemon.mjs', import.meta.url)), electron_path: process.env.DOZE_BROWSER_ELECTRON ?? '/missing/electron', operation_timeout_seconds: 20 }));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.child.exitCode === null ? c.close() : undefined));
    // Node exits on its own after its last MCP connection closes.
    await waitForShutdown(path);
    const logs = readFileSync(join(directory, 'service.log'), 'utf8');
    if (logs.trim()) t.diagnostic(logs.slice(-5000));
    rmSync(directory, { recursive: true, force: true });
    if (process.platform !== 'win32') rmSync(socket, { force: true });
  });
  return {
    directory,
    shutdown() { return waitForShutdown(path); },
    async client(cwd = directory) { const c = new Client(path); c.cwd = cwd; clients.push(c); return c.initialize(); },
    status() { return JSON.parse(execFileSync(binary, ['--internal', 'status', path], { encoding: 'utf8' })); },
  };
}

test('concurrent stdio launchers share one cold Node endpoint and SDK schemas', { skip: !binary, timeout: 25_000 }, async t => {
  const f = await fixture(t);
  const [one, two, three] = await Promise.all([f.client(), f.client(), f.client()]);
  assert.deepEqual(f.status(), { connections: 3, pages: 0, browsers: 0 });
  const catalog = (await one.request('tools/list', {}).promise).result.tools;
  assert.equal(catalog.length, 14);
  assert.equal(catalog.find(t => t.name === 'handle_dialog').inputSchema.properties.accept.type, 'boolean');
  const invalid = await two.call('handle_dialog', { page_id: 'missing', accept: 'false' }).promise;
  assert.ok(invalid.error || invalid.result?.isError);
  assert.equal(text(await three.tool('list_pages', {})), '[]');
  const missingCwd = await three.request('tools/call', { name: 'open_page', arguments: { url: 'about:blank' },
    _meta: { 'x-codex-turn-metadata': { thread_id: 'root' } } }).promise;
  assert.equal(missingCwd.result.isError, true);
  assert.match(text(missingCwd.result), /sandboxCwd/);
  await one.close();
  await delay(50);
  assert.equal(f.status().connections, 2);
});

test('real Electron: ownership, native input, dialogs, ordering, cancellation and cleanup', { skip: !binary || !process.env.DOZE_BROWSER_ELECTRON, timeout: 60_000 }, async t => {
  const html = `<title>Browser contract</title><h1>Example</h1><input aria-label="Name"><select aria-label="Choice"><option value="a">Alpha</option><option value="b">Beta</option></select><button onclick="alert('outcome may be unknown')">Dialog</button>`;
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const f = await fixture(t);
  const firstFolder = join(f.directory, 'first');
  const secondFolder = join(f.directory, 'second');
  mkdirSync(firstFolder);
  mkdirSync(secondFolder);
  const [one, two] = await Promise.all([f.client(firstFolder), f.client(secondFolder)]);
  const [a, b] = await Promise.all([one.tool('open_page', { url }, 'one'), two.tool('open_page', { url }, 'two')]);
  const page = value(a).page_id;
  const other = value(b).page_id;
  assert.deepEqual(f.status(), { connections: 2, pages: 2, browsers: 2 });
  assert.equal(value(await one.tool('evaluate_script', { page_id: page, expression: "localStorage.setItem('owner','one'); 'OK'" }, 'one')), 'OK');
  assert.equal(value(await two.tool('evaluate_script', { page_id: other, expression: "localStorage.getItem('owner')" }, 'two')), null);
  assert.equal((await two.call('inspect_page', { page_id: page }, 'two').promise).result.isError, true);
  const childClient = await f.client(firstFolder);
  const child = value(await childClient.tool('open_page', { url }, 'child', 'one')).page_id;
  assert.equal(value(await childClient.tool('evaluate_script', { page_id: child, expression: "localStorage.getItem('owner')" }, 'child')), 'one');
  assert.equal(value(await childClient.tool('list_pages', {}, 'child')).length, 1);
  await childClient.tool('close_page', { page_id: child }, 'child');
  const snapshot = text(await one.tool('inspect_page', { page_id: page }, 'one'));
  assert.match(snapshot, /RootWebArea "Browser contract"/);
  const input = snapshot.match(/uid=(\S+) textbox "Name"/)[1];
  const option = snapshot.match(/uid=(\S+) option "Beta"/)[1];
  await one.tool('fill', { page_id: page, element: input, value: 'Example value' }, 'one');
  await one.tool('click', { page_id: page, element: option }, 'one');
  assert.deepEqual(value(await one.tool('evaluate_script', { page_id: page, expression: '[document.querySelector("input").value,document.querySelector("select").value]' }, 'one')), ['Example value', 'b']);
  for (const [expression, expected] of [['0', '0'], ['false', 'false'], ['null', 'null'], ['undefined', 'undefined'], ["''", ''], ["'message'", 'message'], ["new Error('native')", 'native']]) {
    for (const source of [`(() => { throw ${expression}; })()`, `Promise.reject(${expression})`]) {
      const failure = await one.call('evaluate_script', { page_id: page, expression: source }, 'one').promise;
      assert.equal(failure.error, undefined, JSON.stringify(failure));
      assert.equal(failure.result.isError, true);
      assert.equal(text(failure.result), expected);
    }
  }
  for (const expression of ['0', 'false', 'null', 'undefined', "''"]) {
    const expected = expression === 'undefined' ? null : expression === "''" ? '' : JSON.parse(expression);
    assert.equal(value(await one.tool('evaluate_script', { page_id: page, expression }, 'one')), expected);
  }
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

test('real Electron: project state survives tab closure, timeout, disconnect and service restart', { skip: !binary || !process.env.DOZE_BROWSER_ELECTRON, timeout: 90_000 }, async t => {
  let logins = 0;
  const server = createServer((req, res) => {
    if (req.url === '/cookies') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.headers.cookie ?? ''));
      return;
    }
    if (req.url === '/login') {
      logins++;
      res.setHeader('Set-Cookie', ['session=fixture; HttpOnly; Path=/', 'persistent=fixture; Max-Age=3600; HttpOnly; Path=/']);
    }
    if (req.url === '/logout') res.setHeader('Set-Cookie', ['session=; Max-Age=0; Path=/', 'persistent=; Max-Age=0; Path=/']);
    res.end('<title>Project storage</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture(t);
  const project = join(f.directory, 'project');
  const otherProject = join(f.directory, 'other');
  mkdirSync(project);
  mkdirSync(otherProject);
  const [one, two, other] = await Promise.all([f.client(project), f.client(project), f.client(otherProject)]);
  const page = value(await one.tool('open_page', { url: url + '/login' }, 'first')).page_id;
  const read = `async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('fixture', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction('state').objectStore('state').get('login');
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { cookies: await fetch('/cookies').then(r => r.json()), local: localStorage.getItem('login'), stored };
  }`;
  await one.tool('evaluate_script', { page_id: page, expression: `(async () => {
    localStorage.setItem('login', 'fixture');
    const request = indexedDB.open('fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('state', 'readwrite');
      transaction.objectStore('state').put({ authenticated: true }, 'login');
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
    db.close(); return 'OK';
  })()` }, 'first');
  const expected = { cookies: 'session=fixture; persistent=fixture', local: 'fixture', stored: { authenticated: true } };
  const check = async (client, id, thread, wanted = expected) => {
    const actual = value(await client.tool('evaluate_script', { page_id: id, expression: `(${read})()` }, thread));
    const ordered = cookies => cookies.split('; ').sort().join('; ');
    assert.deepEqual({ ...actual, cookies: ordered(actual.cookies) }, { ...wanted, cookies: ordered(wanted.cookies) });
  };
  const shared = value(await two.tool('open_page', { url }, 'second')).page_id;
  await check(two, shared, 'second');
  assert.equal((await two.call('inspect_page', { page_id: page }, 'second').promise).result.isError, true);
  const isolated = value(await other.tool('open_page', { url }, 'third')).page_id;
  await check(other, isolated, 'third', { cookies: '', local: null, stored: null });
  assert.equal(f.status().browsers, 2);
  await one.tool('close_page', { page_id: page }, 'first');
  await two.tool('close_page', { page_id: shared }, 'second');
  const restored = value(await one.tool('open_page', { url }, 'new-thread')).page_id;
  await check(one, restored, 'new-thread');
  const timedOut = await one.call('evaluate_script', { page_id: restored, expression: 'new Promise(() => {})' }, 'new-thread').promise;
  assert.equal(timedOut.result.isError, true);
  assert.match(text(timedOut.result), /timed out/);
  const afterTimeout = value(await two.tool('open_page', { url }, 'after-timeout')).page_id;
  await check(two, afterTimeout, 'after-timeout');
  await Promise.all([one.close(), two.close(), other.close()]);
  await f.shutdown();
  const restarted = await f.client(project);
  const afterRestart = value(await restarted.tool('open_page', { url }, 'after-restart')).page_id;
  await check(restarted, afterRestart, 'after-restart');
  assert.equal(logins, 1, 'reopening must not restore or revisit a previous login tab');
  await restarted.tool('evaluate_script', { page_id: afterRestart, expression: `fetch('/logout').then(() => {
    localStorage.clear();
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('fixture');
      request.onsuccess = () => resolve('OK'); request.onerror = () => reject(request.error);
    });
  })` }, 'after-restart');
  await restarted.tool('close_page', { page_id: afterRestart }, 'after-restart');
  const loggedOut = value(await restarted.tool('open_page', { url }, 'logged-out')).page_id;
  await check(restarted, loggedOut, 'logged-out', { cookies: '', local: null, stored: null });
  const repo = join(f.directory, 'repository');
  const inside = join(repo, 'nested');
  mkdirSync(inside, { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  const [rootClient, nestedClient] = await Promise.all([f.client(repo), f.client(inside)]);
  const rootPage = value(await rootClient.tool('open_page', { url }, 'repo-root')).page_id;
  await rootClient.tool('evaluate_script', { page_id: rootPage, expression: "localStorage.setItem('login', 'same-repository')" }, 'repo-root');
  const nestedPage = value(await nestedClient.tool('open_page', { url }, 'repo-nested')).page_id;
  assert.equal(value(await nestedClient.tool('evaluate_script', { page_id: nestedPage, expression: "localStorage.getItem('login')" }, 'repo-nested')), 'same-repository');
  assert.equal(f.status().browsers, 2, 'the plain folder and Git root use one browser each');
});

test('real Electron: mismatched Git roots open isolated temporary pages with a warning and preserve saved profiles', { skip: !binary || !process.env.DOZE_BROWSER_ELECTRON, timeout: 60_000 }, async t => {
  const server = createServer((req, res) => res.end('<title>Temporary storage</title>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture(t);
  const outer = join(f.directory, 'outer');
  const inner = join(outer, 'inner');
  const another = join(outer, 'another');
  mkdirSync(inner, { recursive: true });
  mkdirSync(another);
  for (const folder of [outer, inner, another]) execFileSync('git', ['init', '--quiet', folder]);
  const [parent, child, otherFolder, otherThread] = await Promise.all([f.client(outer), f.client(inner), f.client(another), f.client(inner)]);
  const open = async (client, thread) => {
    const result = await client.tool('open_page', { url }, thread);
    assert.deepEqual(Object.keys(value(result)), ['page_id']);
    return { id: value(result).page_id, result };
  };
  const write = (client, page, thread, account) => client.tool('evaluate_script', { page_id: page.id,
    expression: `localStorage.setItem('account', ${JSON.stringify(account)}); document.cookie = ${JSON.stringify('account=' + account + '; path=/')}; 'OK'` }, thread);
  const check = async (client, page, thread, account) => assert.deepEqual(value(await client.tool('evaluate_script', { page_id: page.id,
    expression: "({account: localStorage.getItem('account'), cookie: document.cookie})" }, thread)),
  { account, cookie: account === null ? '' : 'account=' + account });
  const parentPage = await open(parent, 'parent');
  await write(parent, parentPage, 'parent', 'parent-account');
  const saved = await open(child, 'worker');
  await write(child, saved, 'worker', 'child-account');
  await child.tool('close_page', { page_id: saved.id }, 'worker');
  const head = readFileSync(join(inner, '.git', 'HEAD'));
  for (const folder of [inner, another]) rmSync(join(folder, '.git', 'HEAD'));
  const temporary = await open(child, 'worker');
  assert.equal(temporary.result.content.length, 2);
  assert.match(temporary.result.content[1].text, /Git.*一時/);
  await check(child, temporary, 'worker', null);
  await write(child, temporary, 'worker', 'temporary-account');
  const separateFolder = await open(otherFolder, 'worker');
  await check(otherFolder, separateFolder, 'worker', null);
  const separateThread = await open(otherThread, 'other-worker');
  await check(otherThread, separateThread, 'other-worker', null);
  await child.tool('close_page', { page_id: temporary.id }, 'worker');
  const reopened = await open(child, 'worker');
  assert.equal(reopened.result.content.length, 2);
  await check(child, reopened, 'worker', null);
  await child.tool('close_page', { page_id: reopened.id }, 'worker');
  writeFileSync(join(inner, '.git', 'HEAD'), head);
  const restored = await open(child, 'worker');
  assert.equal(restored.result.content.length, 1);
  await check(child, restored, 'worker', 'child-account');
  await check(parent, parentPage, 'parent', 'parent-account');
});

test('a fake IPC endpoint cannot authenticate or obtain the credential', { skip: !binary }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'doze-auth-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\doze-auth-${randomUUID()}` : `/tmp/doze-auth-${randomUUID()}.sock`;
  const path = join(directory, 'config.json');
  const token = 'b'.repeat(64);
  writeFileSync(path, JSON.stringify({ token, socket_path: socket, node_path: process.execPath, daemon_path: 'unused', electron_path: 'unused' }));
  let received = '';
  let attempts = 0;
  const server = createIpcServer(stream => {
    attempts++;
    stream.on('data', chunk => {
      received += chunk;
      stream.end(JSON.stringify({ proof: '0'.repeat(64) }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); rmSync(directory, { recursive: true, force: true }); });
  const child = spawn(binary, ['--internal', 'proxy', path], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.resume();
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  assert.notEqual(await new Promise(resolve => child.once('exit', resolve)), 0);
  assert.match(errors, /authentication failed/);
  assert.equal(attempts, 1, 'authentication failures must not be retried');
  assert.equal(received.includes(token), false);
  assert.deepEqual(Object.keys(JSON.parse(received)), ['nonce']);
});

test('only startup transport failures reconnect; accepted MCP bytes are never replayed', { skip: !binary, timeout: 15_000 }, async () => {
  for (const mode of ['challenge-eof', 'ack-eof', 'stopping', 'after-ack']) {
    const directory = mkdtempSync(join(tmpdir(), 'doze-reconnect-'));
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\doze-reconnect-${randomUUID()}` : `/tmp/doze-reconnect-${randomUUID()}.sock`;
    const path = join(directory, 'config.json');
    const token = 'c'.repeat(64);
    writeFileSync(path, JSON.stringify({ token, socket_path: socket, node_path: process.execPath, daemon_path: 'unused', electron_path: 'unused' }));
    let attempts = 0;
    let forwarded = 0;
    const server = createIpcServer(stream => {
      const attempt = ++attempts;
      let nonce;
      let authenticated = false;
      createInterface({ input: stream }).on('line', line => {
        const message = JSON.parse(line);
        const mac = role => createHmac('sha256', token).update(`${role}:${nonce}`).digest('hex');
        if (nonce === undefined) {
          nonce = message.nonce;
          if (attempt === 1 && mode === 'challenge-eof') stream.end();
          else stream.write(JSON.stringify({ proof: mac('server') }) + '\n');
        } else if (!authenticated) {
          assert.equal(message.proof, mac('client'));
          assert.equal(message.command, 'mcp');
          if (attempt === 1 && mode === 'ack-eof') stream.end();
          else if (attempt === 1 && mode === 'stopping') stream.end(JSON.stringify({ ok: false, code: 'stopping', error: 'Service is stopping' }) + '\n');
          else { authenticated = true; stream.write('{"ok":true}\n'); }
        } else {
          forwarded++;
          assert.equal(message.method, 'initialize');
          stream.end(mode === 'after-ack' ? undefined : JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
        }
      });
    });
    await new Promise(resolve => server.listen(socket, resolve));
    const child = spawn(binary, ['--internal', 'proxy', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    const deadline = setTimeout(() => child.kill(), 5000);
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    try {
      assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, `${mode}: ${errors}`);
      assert.equal(attempts, mode === 'after-ack' ? 1 : 2, mode);
      assert.equal(forwarded, 1, mode);
      assert.equal(mode === 'after-ack' ? output : JSON.parse(output).id, mode === 'after-ack' ? '' : 1);
    } finally {
      clearTimeout(deadline);
      child.kill();
      await new Promise(resolve => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('plain stdio registration prepares one private endpoint without client configuration changes', { skip: !binary, timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'doze-first-run-'));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory };
  const clients = [new Client(undefined, env), new Client(undefined, env), new Client(undefined, env)];
  let config;
  try {
    await Promise.all(clients.map(client => client.initialize()));
    config = JSON.parse(readFileSync(join(directory, '.config/doze-bworser-mcp/config.json'), 'utf8'));
    assert.equal(text(await clients[0].tool('list_pages', {})), '[]');
    const result = JSON.parse(execFileSync(binary, ['status'], { env, encoding: 'utf8' }));
    assert.deepEqual(result, { connections: 3, pages: 0, browsers: 0 });
    assert.equal(config.electron_path, '');
    assert.equal(spawnSync(process.execPath, ['-e', 'require("fs").accessSync(process.argv[1])', join(directory, '.codex')]).status, 1);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await waitForShutdown(undefined, env);
    rmSync(directory, { recursive: true, force: true });
    if (config && process.platform !== 'win32') rmSync(config.socket_path.slice(0, config.socket_path.lastIndexOf('/')), { recursive: true, force: true });
  }
});

test('first browser use downloads its own Electron without a separate installer', { skip: !binary || !process.env.DOZE_TEST_MANAGED_ELECTRON, timeout: 180_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'doze-managed-'));
  const env = { ...process.env, HOME: directory, USERPROFILE: directory };
  const client = new Client(undefined, env, 120_000);
  let config;
  try {
    await client.initialize();
    config = JSON.parse(readFileSync(join(directory, '.config/doze-bworser-mcp/config.json'), 'utf8'));
    assert.equal(text(await client.tool('list_pages', {})), '[]');
    const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).config.electron_version;
    const cache = join(directory, '.cache/doze-bworser-mcp/electron', version, `${process.platform}-${process.arch}`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'interrupted-extraction'), 'partial');
    const page_id = value(await client.tool('open_page', { url: 'about:blank' })).page_id;
    assert.equal(existsSync(join(cache, 'interrupted-extraction')), false);
    assert.equal(existsSync(join(cache, '.complete')), true);
    assert.equal(value(await client.tool('evaluate_script', { page_id, expression: '2 + 2' })), 4);
    await client.tool('close_page', { page_id });
    assert.equal(spawnSync(process.execPath, ['-e', 'require("fs").accessSync(process.argv[1])', join(directory, '.codex')]).status, 1);
  } finally {
    await client.close();
    await waitForShutdown(undefined, env);
    rmSync(directory, { recursive: true, force: true });
    if (config && process.platform !== 'win32') rmSync(config.socket_path.slice(0, config.socket_path.lastIndexOf('/')), { recursive: true, force: true });
  }
});
