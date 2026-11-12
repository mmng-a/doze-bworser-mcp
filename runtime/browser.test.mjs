import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserManager } from './browser.mjs';
import { ElectronEngine } from './electron-engine.mjs';
import { PendingDialog } from './controller.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeEngine() {
  const engine = Object.assign(new EventEmitter(), { entries: new Map(), async close() { this.emit('disconnected'); },
    async page() { return new EventEmitter(); }, async request(action, args) {
      if (action === 'open') {
        const entry = Object.assign(new EventEmitter(), { id: args.page, targetId: args.page });
        this.entries.set(entry.id, entry); this.emit('created', entry);
      }
      if (action === 'list') return [...this.entries.values()].map(e => ({ id: e.id, url: 'about:blank', title: '' }));
      if (action === 'close') { const entry = this.entries.get(args.page); this.entries.delete(args.page); entry?.emit('close'); }
      return true;
    } });
  return engine;
}

test('project processes are shared, popup ownership is inherited and other projects are isolated', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'doze-engine-test-'));
  const project = join(directory, 'project'); const other = join(directory, 'other');
  await Promise.all([mkdir(project), mkdir(other)]);
  const launches = [];
  t.mock.method(ElectronEngine, 'launch', async (path, profile) => { const e = fakeEngine(); launches.push({ path, profile, e }); return e; });
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 }, new Map(), join(directory, 'profiles'));
  t.after(async () => { await manager.closeWhere(() => true); await rm(directory, { recursive: true, force: true }); });
  const one = { thread: 'one', cwd: project, connection: 'first' };
  const two = { thread: 'two', cwd: project, connection: 'second' };
  const a = await manager.call(one, 'open_page', { url: 'about:blank' });
  await manager.call(two, 'open_page', { url: 'about:blank' });
  assert.equal(launches.length, 1);
  const child = Object.assign(new EventEmitter(), { id: 'popup', opener: a.page_id, targetId: 'child' });
  launches[0].e.entries.set(child.id, child); launches[0].e.emit('created', child);
  assert.equal(manager.pages.get('popup').owner, 'one');
  assert.equal(manager.pages.get('popup').connection, 'first');
  assert.equal((await manager.call(one, 'list_pages', {})).length, 2);
  await assert.rejects(manager.call(two, 'show_page', a), /Page is closed/);
  await manager.call({ thread: 'other', cwd: other }, 'open_page', { url: 'about:blank' });
  assert.equal(launches.length, 2);
  assert.notEqual(launches[0].profile, launches[1].profile);
});

test('startup cancellation does not register an engine or page', async t => {
  t.mock.method(ElectronEngine, 'launch', (_path, _profile, _timeout, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 });
  const abort = new AbortController();
  const task = manager.call({ thread: 'one' }, 'open_page', { url: 'about:blank' }, abort.signal);
  const rejected = assert.rejects(task, { name: 'AbortError' });
  await new Promise(r => setImmediate(r)); abort.abort(); await rejected;
  assert.equal(manager.pages.size, 0); assert.equal(manager.engines.size, 0);
});

test('a popup dialog can be answered before Puppeteer Page is available', async t => {
  const engine = fakeEngine();
  t.mock.method(ElectronEngine, 'launch', async () => engine);
  const manager = new BrowserManager({ electron_path: 'fixture', operation_timeout_seconds: 1 });
  t.after(() => manager.closeWhere(() => true));
  const caller = { thread: 'one' }; const first = await manager.call(caller, 'open_page', { url: 'about:blank' });
  const ready = Promise.withResolvers(); engine.page = () => ready.promise;
  const entry = Object.assign(new EventEmitter(), { id: 'popup', opener: first.page_id, targetId: 'popup' });
  engine.entries.set('popup', entry); engine.emit('created', entry);
  let text;
  entry.emit('dialog', { handled: false, type: () => 'prompt', message: () => 'early', async accept(value) { text = value; this.handled = true; ready.resolve(new EventEmitter()); } });
  await assert.rejects(manager.call(caller, 'inspect_page', { page_id: 'popup' }), PendingDialog);
  await manager.call(caller, 'handle_dialog', { page_id: 'popup', accept: true, prompt_text: 'answer' });
  assert.equal(text, 'answer');
});
