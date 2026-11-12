import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElectronEngine } from './electron-engine.mjs';

test('a disappearing unrelated target does not prevent acquiring a live page', async () => {
  const page = { on() {}, setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async emulateFocusedPage() {} };
  const engine = new ElectronEngine();
  engine.timeout = 1000;
  const gone = { type: () => 'page', async createCDPSession() { throw new Error('Protocol error (Target.attachToTarget): No target with given id found'); } };
  const live = { type: () => 'page', async createCDPSession() { return { async send() { return { targetInfo: { targetId: 'live' } }; }, async detach() {} }; }, async page() { return page; } };
  engine.browser = { async waitForTarget(predicate) { assert.equal(await predicate(gone), false); assert.equal(await predicate(live), true); return live; } };
  assert.equal(await engine.page({ targetId: 'live' }), page);
  engine.browser.waitForTarget = predicate => predicate({ type: () => 'page', async createCDPSession() { throw new Error('Unexpected connection failure'); } });
  await assert.rejects(engine.page({ targetId: 'live' }), /Unexpected connection failure/);
});
