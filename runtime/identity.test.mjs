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
  const manager = new BrowserManager({ chrome_path: 'fixture', operation_timeout_seconds: 1 });
  manager.register('child', 'root');
  assert.equal(manager.root('child'), 'root');
  assert.throws(() => manager.register('root', 'child'), /chain/);
});

test('unknown page allocation is bounded and interrupted on cancellation', async () => {
  for (const cancel of [false, true]) {
    const pending = Promise.withResolvers();
    const entered = Promise.withResolvers();
    let killed = false;
    const context = { newPage() { entered.resolve(); return pending.promise; }, async close() {} };
    const manager = new BrowserManager({ chrome_path: 'fixture', operation_timeout_seconds: 0.02 });
    const browser = { async createBrowserContext() { return context; }, async close() {}, process() { return { kill() { killed = true; pending.reject(new Error('Browser terminated')); } }; } };
    manager.engines.set('temporary', { groups: new Map(), browser });
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
