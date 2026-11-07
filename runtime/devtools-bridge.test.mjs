import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket } from 'ws';
import { DevToolsBridge } from './devtools-bridge.mjs';

class Session extends EventEmitter {
  constructor(name) { super(); this.name = name; this.calls = []; }
  id() { return this.name; }
  async send(method, params) {
    this.calls.push({ method, params });
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'page' } };
    if (method === 'Runtime.throwException') throw new Error('secret backend details');
    return { name: this.name };
  }
  async detach() { this.detached = true; }
  event(method, params) { this.emit('*', method, params); }
}

test('DevTools bridge requires its capability and origin, scopes targets/sessions, and revokes on close', async t => {
  const root = new Session('root');
  const controller = {};
  const bridge = new DevToolsBridge({ targetId: 'page', page: { async createCDPSession() { return root; } }, group: { context: { id: 'context' } }, controller });
  t.after(() => bridge.close());
  const endpoint = await bridge.listen();
  assert.equal((await fetch('http://' + endpoint)).status, 404);
  for (const [path, origin] of [['/wrong', 'devtools://devtools'], [bridge.path, 'https://example.com'], [bridge.path, undefined]]) {
    const socket = new WebSocket('ws://' + endpoint.slice(0, endpoint.indexOf('/')) + path, { origin });
    const [error] = await once(socket, 'error');
    assert.match(error.message, /403/);
  }
  const socket = new WebSocket('ws://' + endpoint, { origin: 'devtools://devtools' });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  let next = 0;
  const pending = new Map();
  socket.on('message', bytes => { const value = JSON.parse(bytes); pending.get(value.id)?.(value); });
  const command = (method, params = {}, sessionId) => new Promise(resolve => {
    const id = ++next;
    pending.set(id, response => { pending.delete(id); resolve(response); });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  assert.deepEqual((await command('Target.getTargets')).result.targetInfos, [{ targetId: 'page' }]);
  for (const [method, params, session] of [
    ['Browser.close'], ['Target.createTarget', { url: 'about:blank' }], ['Target.getBrowserContexts'],
    ['Target.attachToTarget', { targetId: 'another-page' }], ['Target.getTargetInfo', { targetId: 'another-page' }],
    ['Runtime.evaluate', {}, 'another-session'], ['Target.getTargets', {}, 'another-session'],
    ['Target.detachFromTarget', { sessionId: 'another-session' }], ['Storage.getCookies', { browserContextId: 'another-context' }],
  ]) assert.ok((await command(method, params, session)).error, method);
  assert.ok((await command('Page.screencastFrameAck', { sessionId: 27 })).result, 'frame sequence is not a protocol session ID');
  await command('Storage.getCookies');
  assert.deepEqual(root.calls.at(-1).params, { browserContextId: 'context' });
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' });
  assert.ok(controller.lastUsed > 0);
  assert.doesNotMatch(JSON.stringify(await command('Runtime.throwException')), /secret/);
  const child = new Session('child');
  root.emit('sessionattached', child);
  root.event('Target.attachedToTarget', { sessionId: 'child', targetInfo: { targetId: 'frame' } });
  assert.equal((await command('Runtime.evaluate', {}, 'child')).result.name, 'child');
  assert.ok((await command('Target.getTargetInfo', { targetId: 'frame' })).result);
  root.emit('sessiondetached', child);
  assert.ok((await command('Runtime.evaluate', {}, 'child')).error);
  assert.ok((await command('Target.getTargetInfo', { targetId: 'frame' })).error);
  const closed = once(socket, 'close');
  await bridge.close();
  await closed;
  assert.equal(root.detached, true);
  assert.equal(root.listenerCount('*'), 0);
  await assert.rejects(fetch('http://' + endpoint));
});
