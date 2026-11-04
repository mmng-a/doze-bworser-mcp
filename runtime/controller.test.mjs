import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PageController, PendingDialog, PageClosed } from './controller.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const fakeDialog = message => ({ handled: false, type: () => 'alert', message: () => message,
  async accept() { this.handled = true; }, async dismiss() { this.handled = true; } });

test('a returned dialog keeps the original operation and queued work ordered', async () => {
  const page = new EventEmitter();
  const controller = new PageController(page, async () => {});
  const action = Promise.withResolvers();
  const first = controller.run(() => action.promise);
  await tick();
  page.emit('dialog', fakeDialog('outcome may be unknown'));
  await assert.rejects(first, PendingDialog);
  assert.equal(controller.closed, null);
  await assert.rejects(controller.run(() => assert.fail('must not run')), PendingDialog);
  let handled = false;
  const handling = controller.handle(true).then(() => { handled = true; });
  await tick();
  assert.equal(handled, false);
  let secondRan = false;
  const second = controller.run(() => { secondRan = true; });
  await tick();
  assert.equal(secondRan, false);
  action.resolve('original settled');
  await handling;
  await second;
  assert.equal(secondRan, true);
});

test('canceled queued requests and pre-canceled close never execute', async () => {
  const page = new EventEmitter();
  let disposed = 0;
  const controller = new PageController(page, async () => { disposed++; });
  const active = Promise.withResolvers();
  const first = controller.run(() => active.promise);
  await tick();
  const cancellation = new AbortController();
  const queued = controller.run(() => assert.fail('canceled work ran'), cancellation.signal);
  cancellation.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(controller.close(undefined, cancellation.signal), { name: 'AbortError' });
  assert.equal(disposed, 0);
  active.resolve();
  await first;
  await controller.run(() => 'still usable');
});

test('close interrupts an active operation; cancellation and timeout close uncertain pages', async () => {
  for (const trigger of ['close', 'cancel', 'timeout']) {
    let disposed = 0;
    const controller = new PageController(new EventEmitter(), async () => { disposed++; }, 15);
    const signal = new AbortController();
    const active = controller.run(() => new Promise(() => {}), signal.signal);
    const failure = assert.rejects(active);
    await tick();
    if (trigger === 'close') await controller.close();
    if (trigger === 'cancel') signal.abort();
    await failure;
    await controller.closing;
    assert.equal(disposed, 1, trigger);
    await assert.rejects(controller.run(() => assert.fail('closed work ran')), PageClosed);
  }
});

test('dialog wait pauses the active deadline; handle waits across a second dialog', async () => {
  const page = new EventEmitter();
  const controller = new PageController(page, async () => {}, 25);
  const completion = Promise.withResolvers();
  const first = controller.run(() => completion.promise);
  await tick();
  page.emit('dialog', fakeDialog('first'));
  await assert.rejects(first, PendingDialog);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(controller.closed, null);
  const response = controller.handle(false);
  await tick();
  page.emit('dialog', fakeDialog('second'));
  await assert.rejects(response, PendingDialog);
  const response2 = controller.handle(true);
  completion.resolve();
  await response2;
  await controller.run(() => 'done');
});

test('active errors remain ordinary errors and do not get interpreted as lifecycle commands', async () => {
  const controller = new PageController(new EventEmitter(), async () => {});
  await assert.rejects(controller.run(() => { throw new Error('outcome may be unknown'); }), /outcome may be unknown/);
  assert.equal(await controller.run(() => 'usable'), 'usable');
});

test('manual dialog response resumes the active deadline without another tool call', async () => {
  const page = new EventEmitter();
  let disposed = 0;
  const controller = new PageController(page, async () => { disposed++; }, 20);
  const request = controller.run(() => new Promise(() => {}));
  await tick();
  const dialog = fakeDialog('manual');
  page.emit('dialog', dialog);
  await assert.rejects(request, PendingDialog);
  dialog.handled = true;
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(disposed, 1);
});
