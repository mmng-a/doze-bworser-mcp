import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from './browser.mjs';
import { PendingDialog } from './controller.mjs';
import { WebSocket } from 'ws';

const enabled = process.env.DOZE_TEST_VIEWER && process.env.DOZE_BROWSER_CHROME;

async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'doze viewer 日本語 '));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Shared page</title><input aria-label="Name"><button onclick="document.querySelector(\'output\').textContent=\'clicked\'">Click</button><output></output>' +
      (request.url === '/dialog' ? '<script>window.started=1;alert("once");window.finished=true;</script>' : ''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ chrome_path: process.env.DOZE_BROWSER_CHROME, operation_timeout_seconds: 15 }, new Map(), join(folder, 'profiles'));
  t.after(async () => { await manager.closeWhere(() => true); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const caller = { thread: 'one', cwd: folder };
  const url = 'http://127.0.0.1:' + server.address().port;
  return { manager, caller, url, requests };
}

function canvasBounds() {
  function find(root) {
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'CANVAS' && element.getBoundingClientRect().width) {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      if (element.shadowRoot) { const result = find(element.shadowRoot); if (result) return result; }
    }
    return null;
  }
  return find(document);
}

async function clickInView(view, selector) {
  const session = await view.record.page.createCDPSession();
  const deadline = AbortSignal.timeout(5000);
  try {
    const frame = once(session, 'Page.screencastFrame', { signal: deadline });
    await session.send('Page.startScreencast', { format: 'jpeg' });
    const [{ metadata }] = await frame;
    const point = await view.record.page.$eval(selector, e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const canvas = await view.front.evaluate(canvasBounds);
    await view.front.mouse.click(canvas.x + point.x * canvas.width / metadata.deviceWidth, canvas.y + point.y * canvas.height / metadata.deviceHeight);
  } finally { await session.send('Page.stopScreencast'); await session.detach(); }
}

test('real viewer: shared page, address bar, input, parallel pages and independent display lifetime', { skip: !enabled, timeout: 90_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  const backend = record.engine.browser;
  await record.page.evaluate(() => { document.cookie = 'login=shared; path=/'; localStorage.setItem('state', 'saved'); });
  await manager.call(caller, 'show_page', first);
  const view = manager.viewer.views.get(first.page_id);
  assert.equal(view.record.page, record.page);
  assert.equal(record.engine.browser, backend);
  assert.ok(await view.front.evaluate(canvasBounds));
  await assert.rejects(manager.call({ thread: 'two' }, 'show_page', first), /Page is closed/);
  const other = await manager.call({ ...caller, thread: 'two' }, 'open_page', { url, headed: true });
  const secondView = manager.viewer.views.get(other.page_id);
  assert.equal(secondView.browser, view.browser);
  assert.equal(manager.pages.get(other.page_id).engine.browser, backend);
  assert.equal(await manager.pages.get(other.page_id).page.evaluate(() => document.cookie), 'login=shared');
  const socket = new WebSocket('ws://' + new URL(view.front.url()).searchParams.get('ws'), { origin: 'devtools://devtools' });
  await once(socket, 'open');
  for (const [method, params] of [['Browser.close', {}], ['Target.closeTarget', { targetId: manager.pages.get(other.page_id).targetId }]]) {
    const response = once(socket, 'message');
    socket.send(JSON.stringify({ id: 1, method, params }));
    assert.ok(JSON.parse((await response)[0]).error);
  }
  socket.close();
  assert.ok(await record.page.evaluate(() => document.hasFocus()), 'other headless window must not deactivate this page');
  await view.front.bringToFront();
  await view.front.locator('::-p-aria(Address bar)').fill(url + '/next');
  await view.front.keyboard.press('Enter');
  await record.page.waitForFunction(() => location.pathname === '/next');
  assert.equal(await record.page.evaluate(() => localStorage.getItem('state')), 'saved');
  await clickInView(view, 'input');
  await view.front.keyboard.type('human input');
  await record.page.waitForFunction(() => document.querySelector('input').value === 'human input');
  await clickInView(view, 'button');
  await record.page.waitForFunction(() => document.querySelector('output').textContent === 'clicked');
  const endpoint = 'http://' + new URL(view.front.url()).searchParams.get('ws');
  await view.front.close();
  await manager.viewer.tail;
  assert.equal(record.page.isClosed(), false);
  assert.equal(manager.viewer.views.size, 1);
  assert.equal(await record.page.evaluate(() => 2 + 2), 4);
  await assert.rejects(fetch(endpoint));
  const displayStopped = once(secondView.browser, 'disconnected');
  secondView.browser.process().kill('SIGKILL');
  await displayStopped;
  await manager.viewer.tail;
  assert.equal(await record.page.evaluate(() => 3 + 4), 7);
  assert.equal(await manager.pages.get(other.page_id).page.evaluate(() => 4 + 5), 9);
  await manager.call(caller, 'show_page', first);
  const reopened = manager.viewer.views.get(first.page_id);
  const stopped = once(reopened.browser, 'disconnected');
  await manager.call(caller, 'close_page', first);
  await stopped;
  assert.equal(manager.viewer.views.size, 0);
  assert.equal(await manager.pages.get(other.page_id).page.evaluate(() => 5 + 6), 11);
  await assert.rejects(manager.call(caller, 'show_page', first), /Page is closed/);
});

test('real viewer: cancellation leaves the headless page usable and no display resources', { skip: !enabled, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const page = await manager.call(caller, 'open_page', { url });
  const abort = new AbortController();
  const opening = manager.call(caller, 'show_page', page, abort.signal);
  const rejected = assert.rejects(opening, /canceled|timed out/);
  setTimeout(() => abort.abort(), 100);
  await rejected;
  assert.equal(manager.viewer.views.size, 0);
  assert.ok(!manager.viewer.browser);
  assert.equal(await manager.pages.get(page.page_id).page.evaluate(() => 7 + 8), 15);
});

test('real viewer: initial navigation dialog retains the page and is handled without replay', { skip: !enabled, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  await assert.rejects(manager.call(caller, 'open_page', { url: url + '/dialog', headed: true }), PendingDialog);
  const [record] = manager.pages.values();
  assert.ok(manager.viewer.views.has(record.id));
  await manager.call(caller, 'handle_dialog', { page_id: record.id, accept: true });
  assert.deepEqual(await record.page.evaluate(() => [window.started, window.finished]), [1, true]);
});

test('real browser: native profile retains cookies without replaying tabs after closure or crash', { skip: !enabled, timeout: 45_000 }, async t => {
  const { manager, caller, url, requests } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  const process = record.engine.browser.process();
  await record.page.evaluate(() => {
    document.cookie = 'session=saved; path=/';
    document.cookie = 'persistent=saved; Max-Age=3600; path=/';
  });
  const started = Date.now();
  await manager.call(caller, 'close_page', first);
  t.diagnostic(JSON.stringify({ closeMilliseconds: Date.now() - started, exitCode: process.exitCode, signalCode: process.signalCode }));
  const second = await manager.call(caller, 'open_page', { url: url + '/once' });
  assert.equal(await manager.pages.get(second.page_id).page.evaluate(() => document.cookie), 'session=saved; persistent=saved');
  const browser = manager.pages.get(second.page_id).engine.browser;
  const disconnected = once(browser, 'disconnected');
  browser.process().kill('SIGKILL');
  await disconnected;
  await manager.closeWhere(() => true);
  const third = await manager.call(caller, 'open_page', { url: url + '/next' });
  assert.equal(await manager.pages.get(third.page_id).page.evaluate(() => document.cookie), 'session=saved; persistent=saved');
  assert.equal(requests.filter(path => path === '/once').length, 1, 'restoring cookies must not revisit a previous tab');
});
