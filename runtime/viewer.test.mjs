import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from './browser.mjs';
import { PendingDialog } from './controller.mjs';

const enabled = !!process.env.DOZE_BROWSER_ELECTRON;
async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), 'doze electron 日本語 '));
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<title>共同操作</title><input aria-label="Name"><button onclick="window.child=window.open(\'/early\',\'child\',\'width=500,height=400\')">Popup</button><script>window.marker=crypto.randomUUID();</script>' +
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
  t.diagnostic('Starting viewport screenshot');
  const png = await manager.call(caller, 'take_screenshot', first);
  t.diagnostic('Viewport screenshot complete');
  assert.ok(Buffer.from(png.image, 'base64').length > 1000);
  assert.equal(record.page.viewport(), null, 'capture restores the original device metrics');
  t.diagnostic('Starting full-page screenshot');
  const full = await manager.call(caller, 'take_screenshot', { ...first, full_page: true });
  t.diagnostic('Full-page screenshot complete');
  assert.ok(Buffer.from(full.image, 'base64').length > 1000);
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
  await ui.waitForSelector('#url');
  await manager.call(caller, 'evaluate_script', { ...first, expression: "window.answer=prompt('人が入力','初期値')" }).then(() => assert.fail('dialog expected'), e => assert.ok(e instanceof PendingDialog));
  await ui.waitForFunction(() => !document.querySelector('#modal').hidden);
  await ui.locator('#prompt').fill('画面からの回答');
  await ui.screenshot({ path: join(tmpdir(), 'doze-electron-prompt.png') });
  const answered = new Promise(resolve => record.entry.once('dialog-closed', resolve));
  await ui.locator('button.primary').click();
  await answered;
  await record.controller.run(async () => assert.equal(await record.page.evaluate(() => window.answer), '画面からの回答'));
  await ui.locator('#hide').click();
  assert.ok((await record.engine.request('list')).every(p => !p.visible));
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'marker' }), marker);
  await manager.call(caller, 'show_page', first);
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
  await assert.rejects(manager.call(caller, 'evaluate_script', { ...first, expression: 'window.permissionResult=Notification.requestPermission()' }), PendingDialog);
  await ui.waitForFunction(() => !document.querySelector('#modal').hidden);
  assert.match(await ui.$eval('#message', element => element.textContent), /通知/);
  const answered = new Promise(resolve => record.entry.once('dialog-closed', resolve));
  await ui.locator('button.primary').click();
  await answered;
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'window.permissionResult' }), 'granted');
  assert.equal(await manager.call(caller, 'evaluate_script', { ...first, expression: 'Notification.permission' }), 'granted');
});


for (const variant of ['native', 'prime', 'parent', 'ui-throttle', 'focus']) test('Linux capture probe: ' + variant, { skip: !enabled || process.platform !== 'linux', timeout: 20_000 }, async t => {
  const { manager, caller, url } = await setup(t);
  const first = await manager.call(caller, 'open_page', { url });
  const record = manager.pages.get(first.page_id);
  await record.page.evaluate(() => { window.child = window.open('/callback'); });
  let timer;
  const action = async () => {
    const image = await record.engine.request('capture-probe', { page: first.page_id, mode: variant });
    t.diagnostic('Native capture preparation finished: ' + variant);
    const png = variant === 'native' ? Buffer.from(image, 'base64') : await record.page.screenshot({ type: 'png' });
    assert.ok(png.length > 1000);
    assert.ok((await record.engine.request('list')).every(p => !p.visible));
  };
  try { await Promise.race([action(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Capture probe timed out: ' + variant)), 5000);})]); }
  finally { clearTimeout(timer); }
});
