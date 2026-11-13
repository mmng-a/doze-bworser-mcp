import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from './browser.mjs';
import { PendingDialog } from './controller.mjs';

const enabled = !!process.env.DOZE_BROWSER_ELECTRON;
async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'doze electron 日本語 '));
  const server = createServer((req, res) => {
    if (req.url.startsWith('/favicon.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#527a64"/><circle cx="16" cy="16" r="7" fill="white"/></svg>');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<title>共同操作</title><link rel="icon" href="/favicon.svg"><input aria-label="Name"><button onclick="window.child=window.open(\'/early\',\'child\',\'width=500,height=400\')">Popup</button><script>window.marker=crypto.randomUUID();</script>' +
      (req.url === '/early' ? '<script>window.reply=prompt("初回の入力","初期値");window.done=true;</script>' : ''));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const manager = new BrowserManager({ electron_path: process.env.DOZE_BROWSER_ELECTRON, operation_timeout_seconds: 10 }, new Map(), join(folder, 'profiles'));
  t.after(async () => { await manager.closeWhere(() => true); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(folder, { recursive: true, force: true }); });
  return { manager, caller: { thread: 'one', connection: 'one', cwd: folder }, url: 'http://127.0.0.1:' + server.address().port };
}

test('Electron: hidden pages, initial popup prompt, inherited ownership and native screenshot', { skip: !enabled, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  await manager.call(caller, 'evaluate_script', { ...first, expression: "window.child=window.open('/early','child','width=500,height=400'); 'opened'" });
  let child;
  for (let i = 0; i < 100; i++) {
    child = [...manager.pages.values()].find(p => p.entry.opener === first.page_id && p.controller.dialog);
    if (child) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(child?.controller.dialog, 'initial child dialog is captured before Puppeteer Page is available');
  assert.equal((await manager.call(caller, 'list_pages', {})).length, 2);
  await assert.rejects(manager.call({ thread: 'other' }, 'show_page', { page_id: child.id }), /Page is closed/);
  await assert.rejects(manager.call(caller, 'inspect_page', { page_id: child.id }), PendingDialog);
  await manager.call(caller, 'handle_dialog', { page_id: child.id, accept: true, prompt_text: '子ページへの回答' });
  assert.equal(await manager.call(caller, 'evaluate_script', { page_id: child.id, expression: 'window.reply' }), '子ページへの回答');
  assert.ok((await record.engine.request('list')).every(p => !p.visible));
  const png = await manager.call(caller, 'take_screenshot', first);
  assert.ok(Buffer.from(png.image, 'base64').length > 1000);
  assert.equal(record.page.viewport(), null, 'capture restores the original device metrics');
  const before = await record.page.evaluate(() => { document.body.style.minHeight = '2000px'; document.body.insertAdjacentHTML('beforeend', '<div style="position:absolute;top:1950px;height:50px;width:100%;background:rgb(0,128,0)"></div>'); scrollTo(0, 200); return {width: innerWidth, height: innerHeight, scale: devicePixelRatio, y: scrollY}; });
  const full = await manager.call(caller, 'take_screenshot', { ...first, full_page: true });
  const fullBytes = Buffer.from(full.image, 'base64');
  assert.ok(fullBytes.readUInt32BE(20) >= 2000 * before.scale);
  assert.deepEqual(await record.page.evaluate(() => ({width: innerWidth, height: innerHeight, scale: devicePixelRatio, y: scrollY})), before);
  await writeFile(join(tmpdir(), 'doze-electron-full.png'), fullBytes);
  assert.ok((await record.engine.request('list')).every(p => !p.visible));
  await manager.call(caller, 'close_page', first);
  assert.equal(manager.pages.size, 0);
});

test('Electron joint UI: URL navigation, prompt entry and hiding retain live state', { skip: !enabled || !process.env.DOZE_TEST_VIEWER, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  const marker = await manager.call(caller, 'evaluate_script', { ...first, expression: 'marker' });
  await manager.call(caller, 'show_page', first);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  await ui.waitForSelector('#url');
  await manager.call(caller, 'evaluate_script', { ...first, expression: "window.answer=prompt('人が入力','初期値')" }).then(() => assert.fail('dialog expected'), e => assert.ok(e instanceof PendingDialog));
  await ui.waitForFunction(() => !document.querySelector('#modal').hidden);
  await ui.locator('#prompt').fill('画面からの回答');
  await ui.screenshot({ path: join(tmpdir(), 'doze-electron-prompt.png') });
  const answered = new Promise(resolve => record.entry.once('dialog-closed', resolve));
  await ui.locator('button.primary').click();
  await answered;
  await record.controller.run(async () => assert.equal(await record.page.evaluate(() => window.answer), '画面からの回答'));
  await ui.evaluate(() => window.doze.act('close-window'));
  await waitFor(async () => (await record.engine.request('list')).every(p => !p.visible));
  assert.ok((await record.engine.request('list')).every(p => !p.visible));
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'marker' }), marker);
  await manager.call(caller, 'show_page', first);
  await ui.locator('.tab.active .tab-select').click();
  await ui.locator('#url').fill(url + '/next'); await ui.keyboard.press('Enter');
  await record.page.waitForFunction(() => location.pathname === '/next');
  await ui.locator('#back').click(); await record.page.waitForFunction(() => location.pathname === '/');
  await ui.screenshot({ path: process.env.DOZE_UI_SCREENSHOT || join(tmpdir(), 'doze-electron-ui.png') });
});

test('Electron: beforeunload preserves the original page and reports blocked navigation', { skip: !enabled, timeout: 30_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  await record.page.click('input');
  await record.page.evaluate(() => { window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; });
  await assert.rejects(manager.call(caller, 'navigate_page', { ...first, url: url + '/next' }), /ERR_ABORTED/);
  assert.equal(new URL(record.page.url()).pathname, '/');
  assert.ok((await record.engine.request('list')).every(p => !p.visible));
});

test('Electron: an authentication-style popup can message its opener and close itself', { skip: !enabled, timeout: 30_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  await record.page.evaluate(() => { addEventListener('message', event => { window.authMessage = event.data; }); window.child = window.open('/callback', 'auth', 'width=500,height=400'); });
  let child;
  for (let i = 0; i < 100; i++) { child = [...manager.pages.values()].find(p => p.entry.opener === first.page_id); if (child) break; await new Promise(r => setTimeout(r, 20)); }
  assert.ok(child);
  await manager.call(caller, 'evaluate_script', { page_id: child.id, expression: "opener.postMessage('authorized',location.origin);setTimeout(()=>close(),0);'closing'" });
  for (let i = 0; i < 100 && manager.pages.has(child.id); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(await record.page.evaluate(() => window.authMessage), 'authorized');
  assert.equal(await record.page.evaluate(() => window.child.closed), true);
  assert.equal(manager.pages.has(child.id), false);
});


test('Electron: hidden permission requests are denied and visible requests use the joint dialog', { skip: !enabled || !process.env.DOZE_TEST_VIEWER, timeout: 30_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'Notification.requestPermission()' }), 'denied');
  await manager.call(caller, 'show_page', first);
  const record = manager.pages.get(first.page_id);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  await assert.rejects(manager.call(caller, 'evaluate_script', { ...first, expression: 'window.permissionResult=Notification.requestPermission()' }), PendingDialog);
  await ui.waitForFunction(() => !document.querySelector('#modal').hidden);
  assert.match(await ui.$eval('#message', element => element.textContent), /通知/);
  const answered = new Promise(resolve => record.entry.once('dialog-closed', resolve));
  await ui.locator('button.primary').click();
  await answered;
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'window.permissionResult' }), 'granted');
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'Notification.permission' }), 'granted');
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail('Expected browser state was not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('Electron tabs: one owner window, hide-only controls, redisplay and system closure', { skip: !enabled || !process.env.DOZE_TEST_VIEWER, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const second = await manager.call(caller, 'open_page', { url: url + '/two' });
  const foreign = await manager.call({ ...caller, thread: 'other' }, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  assert.equal(record.entry.uiTargetId, manager.pages.get(second.page_id).entry.uiTargetId);
  assert.notEqual(record.entry.uiTargetId, manager.pages.get(foreign.page_id).entry.uiTargetId);
  const marker = await manager.call(caller, 'evaluate_script', { ...second, expression: 'marker' });
  await manager.call(caller, 'show_page', first);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  await ui.waitForFunction(() => document.querySelectorAll('.tab').length === 1);
  await manager.call(caller, 'show_page', second);
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, second.page_id);
  assert.deepEqual(await ui.$$eval('.tab', elements => elements.map(element => element.dataset.page)), [first.page_id, second.page_id]);
  assert.equal(await ui.$('#hide'), null);
  await assert.rejects(ui.evaluate(id => window.doze.act('switch', { page: id }), foreign.page_id), /Unknown shown page/);
  await ui.locator(`[data-page="${first.page_id}"] .tab-select`).click();
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, first.page_id);
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await ui.keyboard.down(modifier); await ui.keyboard.press('l'); await ui.keyboard.up(modifier);
  await ui.waitForFunction(() => document.activeElement.id === 'url');
  await ui.locator('#url').fill('file:///not-allowed');
  await ui.keyboard.press('Enter');
  await ui.waitForFunction(() => !document.querySelector('#url').validity.valid);
  await ui.keyboard.press('Escape');
  assert.equal(record.page.url(), url + '/');
  await ui.locator(`[data-page="${second.page_id}"] .tab-hide`).click();
  await ui.waitForFunction(() => document.querySelectorAll('.tab').length === 1);
  assert.equal(await manager.call(caller, 'evaluate_script', { ...second, expression: 'marker' }), marker);
  assert.equal((await manager.call(caller, 'list_pages', {})).length, 2);
  await manager.call(caller, 'show_page', second);
  await ui.waitForFunction(() => document.querySelectorAll('.tab').length === 2);
  await ui.locator(`[data-page="${second.page_id}"] .tab-hide`).click();
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, first.page_id);
  await ui.evaluate(() => window.doze.act('close-window'));
  await waitFor(async () => (await record.engine.request('list')).every(p => !p.visible));
  assert.equal(await ui.$$eval('.tab', elements => elements.length), 1);
  await manager.call(caller, 'show_page', first);
  await ui.locator('.tab.active .tab-hide').click();
  await waitFor(async () => (await record.engine.request('list')).every(p => !p.visible));
  assert.equal(ui.isClosed(), false);
  assert.equal((await manager.call(caller, 'list_pages', {})).length, 2);
  await manager.call(caller, 'show_page', second);
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, second.page_id);
  assert.equal(await manager.call(caller, 'evaluate_script', { ...second, expression: 'marker' }), marker);
  await manager.call(caller, 'close_page', first);
  assert.equal(ui.isClosed(), false);
  await manager.call(caller, 'close_page', second);
  await waitFor(() => ui.isClosed());
});

test('Electron tabs: compact single-row layout, overflow selection and favicon', { skip: !enabled || !process.env.DOZE_TEST_VIEWER, timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const pages = [];
  for (let i = 0; i < 6; i++) {
    const page = await manager.call(caller, 'open_page', { url: url + '/' + i, headed: true });
    await manager.call(caller, 'evaluate_script', { ...page, expression: `document.title=${JSON.stringify(['Overview', 'Notes', 'Review', 'Settings', 'Activity', 'Projects'][i])}` });
    pages.push(page);
  }
  const record = manager.pages.get(pages[0].page_id);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  await ui.waitForFunction(() => document.querySelectorAll('.tab').length === 4 && !document.querySelector('#overflow').hidden);
  const pick = await ui.$eval('#overflow', select => select.options[1].value);
  await ui.select('#overflow', pick);
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, pick);
  await ui.waitForFunction(() => [...document.querySelectorAll('.favicon img')].every(image => !image.hidden && image.complete && image.naturalWidth > 0));
  await ui.locator(`[data-page="${pages[1].page_id}"] .tab-select`).click();
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, pages[1].page_id);
  const geometry = () => {
    const header = document.querySelector('header').getBoundingClientRect();
    return { height: header.height, width: innerWidth, tabs: [...document.querySelectorAll('.tab')].map(tab => { const rect = tab.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, active: tab.classList.contains('active') }; }) };
  };
  const normal = await ui.evaluate(geometry);
  assert.equal(normal.height, 48);
  assert.ok(normal.tabs.every(tab => tab.y >= 0 && tab.bottom <= 48 && tab.right <= normal.width));
  assert.ok(normal.tabs.find(tab => tab.active).width > normal.tabs.find(tab => !tab.active).width);
  await ui.screenshot({ path: join(tmpdir(), 'doze-electron-tabs.png'), clip: { x: 0, y: 0, width: normal.width, height: 48 } });
  await ui.setViewport({ width: 520, height: 600 });
  await ui.waitForFunction(() => document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth);
  const narrow = await ui.evaluate(geometry);
  assert.ok(narrow.tabs.every(tab => tab.y >= 0 && tab.bottom <= 48 && tab.right <= narrow.width));
  assert.ok(narrow.tabs.some(tab => tab.active));
  await ui.screenshot({ path: join(tmpdir(), 'doze-electron-tabs-narrow.png'), clip: { x: 0, y: 0, width: 520, height: 48 } });
});

test('Electron tabs: shown popup uses its opener window and hiding retains its native relationship', { skip: !enabled || !process.env.DOZE_TEST_VIEWER, timeout: 30_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url, headed: true });
  const record = manager.pages.get(first.page_id);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  await record.page.evaluate(() => { window.child = window.open('/early', 'child', 'width=500,height=400'); });
  await waitFor(() => [...manager.pages.values()].some(page => page.entry.opener === first.page_id && page.controller.dialog));
  const child = [...manager.pages.values()].find(page => page.entry.opener === first.page_id);
  assert.equal(child.entry.uiTargetId, record.entry.uiTargetId);
  await ui.waitForFunction(id => document.querySelector('.tab.active')?.dataset.page === id && !document.querySelector('#modal').hidden, {}, child.id);
  await ui.locator('#prompt').fill('popup reply');
  const answered = new Promise(resolve => child.entry.once('dialog-closed', resolve));
  await ui.locator('button.primary').click(); await answered;
  assert.equal(await manager.call(caller, 'evaluate_script', { page_id: child.id, expression: 'reply' }), 'popup reply');
  await ui.locator('.tab.active .tab-hide').click();
  await ui.waitForFunction(id => document.querySelector('.tab.active').dataset.page === id, {}, first.page_id);
  assert.equal(await record.page.evaluate(() => child.closed), false);
  const png = await manager.call(caller, 'take_screenshot', { page_id: child.id });
  assert.ok(Buffer.from(png.image, 'base64').length > 1000);
  assert.ok((await record.engine.request('list')).find(page => page.id === first.page_id).visible);
  await manager.call(caller, 'show_page', { page_id: child.id });
  await manager.call(caller, 'close_page', first);
  assert.equal(manager.pages.size, 0);
});
