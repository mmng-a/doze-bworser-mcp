import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerFromMeta } from './tools.mjs';
import { BrowserManager } from './browser.mjs';

test('Codex sources accept plain root names and serialized subagent metadata', async () => {
  for (const source of ['cli', 'vscode', '"cli"', undefined]) {
    assert.equal(callerFromMeta({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'root', thread_source: source }) }, 'connection').thread, 'root');
  }
  const child = { subagent: { thread_spawn: { parent_thread_id: 'parent' } } };
  for (const source of [child, JSON.stringify(child)]) assert.equal(callerFromMeta({ 'x-codex-turn-metadata': { thread_id: 'child', thread_source: source } }, 'connection').parent, 'parent');
  const manager = new BrowserManager({ operation_timeout_seconds: 1 });
  manager.startThread('root');
  manager.register('child', 'root');
  await manager.endThread('never-started');
  await assert.rejects(manager.call({ thread: 'never-started' }, 'list_pages', {}), /ended/);
  const oldRoot = manager.threadSignal('root');
  const oldChild = manager.threadSignal('child');
  await manager.endThread('root');
  assert.ok(oldRoot.aborted && oldChild.aborted);
  await assert.rejects(manager.call({ thread: 'root' }, 'list_pages', {}), /ended/);
  manager.startThread('root');
  assert.deepEqual(await manager.call({ thread: 'root' }, 'list_pages', {}), []);
  assert.ok(oldRoot.aborted, 'a resumed thread must not revive old requests');
  assert.equal(manager.threadSignal('root').aborted, false);
  assert.throws(() => manager.register('root', 'child'), /chain/);
});

test('ending and resuming a thread cannot register its earlier page allocation', async () => {
  const { EventEmitter } = await import('node:events');
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let closed = false;
  const page = Object.assign(new EventEmitter(), {
    async emulateFocusedPage() { entered.resolve(); await resume.promise; },
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    async createCDPSession() { return { async send() { return { targetInfo: { targetId: 'target' } }; }, async detach() {} }; },
    async close() { closed = true; }, isClosed: () => closed,
    async goto() { assert.fail('ended request navigated'); },
  });
  const context = { async newPage() { return page; }, async close() { closed = true; } };
  const manager = new BrowserManager({ operation_timeout_seconds: 1 });
  manager.engines.set(false, { groups: new Map(), browser: { async createBrowserContext() { return context; }, async close() {} } });
  const open = manager.call({ thread: 'root', connection: 'connection' }, 'open_page', { url: 'about:blank' });
  const rejected = assert.rejects(open, /ended/);
  await entered.promise;
  await manager.endThread('root');
  manager.startThread('root');
  resume.resolve();
  await rejected;
  assert.equal(manager.pages.size, 0);
  assert.equal(closed, true);
});

test('unknown page allocation is bounded and interrupted on cancellation', async () => {
  for (const cancel of [false, true]) {
    const pending = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let killed = false;
    const context = { newPage() { entered.resolve(); return pending.promise; }, async close() {} };
    const manager = new BrowserManager({ operation_timeout_seconds: 0.02 });
    const browser = { async createBrowserContext() { return context; }, async close() {}, process() { return { kill() { killed = true; pending.reject(new Error('Browser terminated')); } }; } };
    manager.engines.set(false, { groups: new Map(), browser });
    const abort = new AbortController();
    const open = manager.call({ thread: 'root' }, 'open_page', { url: 'about:blank' }, abort.signal);
    const rejected = assert.rejects(open);
    await entered.promise;
    if (cancel) abort.abort();
    await rejected;
    assert.equal(killed, true);
    assert.equal(manager.pages.size, 0);
  }
});
