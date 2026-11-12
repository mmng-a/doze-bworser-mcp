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
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 });
  manager.register('child', 'root');
  assert.equal(manager.root('child'), 'root');
  assert.throws(() => manager.register('root', 'child'), /chain/);
});

test('Codex without sandboxCwd fails before launching a browser', async () => {
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 });
  await assert.rejects(manager.call({ thread: 'root', codex: true }, 'open_page', { url: 'about:blank' }), /sandboxCwd/);
  assert.equal(manager.engines.size, 0);
});
