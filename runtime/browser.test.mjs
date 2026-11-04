import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import puppeteer from 'puppeteer-core';
import { Connection } from './node_modules/puppeteer-core/lib/puppeteer/cdp/Connection.js';
import { BrowserManager } from './browser.mjs';
import { PendingDialog } from './controller.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('dialog wait retains its CDP request until response and does not inherit a protocol deadline', async t => {
  let connection;
  let request;
  let closed = false;
  let options;
  const transport = { send(message) { request = JSON.parse(message); }, close() {} };
  const page = Object.assign(new EventEmitter(), {
    async emulateFocusedPage() {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async goto() {},
    async createCDPSession() { return { async send() { return { targetInfo: { targetId: 'target' } }; }, async detach() {} }; },
    evaluate() { return connection.send('Runtime.callFunctionOn', { awaitPromise: true }); },
    async close() { closed = true; }, isClosed: () => closed,
  });
  const browser = Object.assign(new EventEmitter(), {
    async createBrowserContext() { return { newPage: async () => page, close: async () => page.close() }; },
    target() { return { async createCDPSession() { return { async send() { return { targetInfos: [] }; } }; } }; },
    async close() { this.emit('disconnected'); connection.dispose(); },
  });
  t.mock.method(puppeteer, 'launch', async args => {
    options = args;
    connection = new Connection('', transport, 0, args.protocolTimeout ?? 15);
    return browser;
  });
  const manager = new BrowserManager({ chrome_path: 'fixture', operation_timeout_seconds: 1 });
  t.after(async () => { await manager.closeWhere(() => true); connection?.dispose(); });
  const caller = { thread: 'root', connection: 'connection' };
  const originalSignal = new AbortController();
  const { page_id } = await manager.call(caller, 'open_page', { url: 'about:blank' }, originalSignal.signal);
  originalSignal.abort();
  assert.notEqual(options.signal?.aborted, true, 'completed open request must not own the shared browser lifetime');
  const operation = manager.call(caller, 'evaluate_script', { page_id, expression: 'pending' });
  const interrupted = assert.rejects(operation, PendingDialog);
  await tick();
  const dialog = { handled: false, type: () => 'alert', message: () => 'wait', async accept() { this.handled = true; } };
  page.emit('dialog', dialog);
  await interrupted;
  await new Promise(resolve => setTimeout(resolve, 40));
  let replied = false;
  const reply = manager.call(caller, 'handle_dialog', { page_id, accept: true }).then(() => { replied = true; });
  await tick();
  assert.equal(replied, false);
  transport.onmessage(JSON.stringify({ id: request.id, result: { result: { type: 'string', value: 'done' } } }));
  await reply;
  assert.equal(closed, false);
  assert.equal(options.protocolTimeout, 0);
});

test('browser startup has an owned deadline and accepts cancellation', async t => {
  for (const cancel of [false, true]) {
    const entered = Promise.withResolvers();
    t.mock.method(puppeteer, 'launch', options => {
      entered.resolve();
      return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const manager = new BrowserManager({ chrome_path: 'fixture', operation_timeout_seconds: 0.02 });
    const abort = new AbortController();
    const opened = manager.call({ thread: 'root' }, 'open_page', { url: 'about:blank' }, abort.signal);
    const rejected = assert.rejects(opened);
    await entered.promise;
    if (cancel) abort.abort();
    await rejected;
    assert.equal(manager.engines.size, 0);
  }
});

test('page listing has a per-command deadline after the shared protocol deadline is disabled', async () => {
  const transport = { send() {}, close() {} };
  const connection = new Connection('', transport, 0, 0);
  const manager = new BrowserManager({ chrome_path: 'fixture', operation_timeout_seconds: 0.02 });
  let attached = 0;
  const engine = { session: { send: (...args) => connection.send(...args) }, browser: { target() { return { async createCDPSession() { attached++; return { send: (...args) => connection.send(...args), async detach() {} }; } }; } } };
  manager.pages.set('page', { id: 'page', owner: 'root', targetId: 'target', engine, controller: {} });
  try {
    await assert.rejects(manager.call({ thread: 'root' }, 'list_pages', {}), /timed out/);
    assert.equal(attached, 0);
    assert.deepEqual(connection.getPendingProtocolErrors(), []);
  } finally { connection.dispose(); }
});

test('canceling the first browser download does not wait for it or launch a browser later', async t => {
  const manager = new BrowserManager({ operation_timeout_seconds: 1 });
  const download = Promise.withResolvers();
  manager.chrome = download.promise;
  let launches = 0;
  t.mock.method(puppeteer, 'launch', () => { launches++; throw new Error('must not launch'); });
  const abort = new AbortController();
  const opened = manager.call({ thread: 'root' }, 'open_page', { url: 'about:blank' }, abort.signal);
  const rejected = assert.rejects(opened, { name: 'AbortError' });
  await tick();
  abort.abort();
  await rejected;
  download.resolve('downloaded-chrome');
  await tick();
  assert.equal(launches, 0);
  assert.equal(manager.pages.size, 0);
});
