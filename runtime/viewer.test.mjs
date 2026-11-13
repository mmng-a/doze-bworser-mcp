import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BrowserManager } from './browser.mjs';
import { PendingDialog } from './controller.mjs';

const enabled = !!process.env.DOZE_BROWSER_ELECTRON;
async function setup(t, nativeKeys = false) {
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
  let executable = process.env.DOZE_BROWSER_ELECTRON;
  if (nativeKeys) {
    const main = fileURLToPath(new URL('./electron-main.cjs', import.meta.url));
    const wrapper = join(folder, 'native-input.cjs');
    const errorLog = join(folder, 'native-input-error.log');
    t.after(async () => { try { t.diagnostic(await readFile(errorLog, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
    await writeFile(wrapper, `process.on('uncaughtException', error => { require('node:fs').appendFileSync(${JSON.stringify(errorLog)}, error.stack); process.exit(1); });
const { app, webContents, nativeTheme } = require('electron');
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('test-native-theme:')) nativeTheme.themeSource = message.slice(18);
    if (message.startsWith('test-native-key:')) {
      const { target, ...input } = JSON.parse(message.slice(16));
      webContents.fromDevToolsTargetId(target).sendInputEvent(input);
    }
  });
});
require(${JSON.stringify(main)});`);
    const launcher = join(folder, 'electron-test');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    await writeFile(launcher, `#!/bin/sh\nexec ${quote(executable)} --remote-debugging-pipe ${quote(wrapper)}\n`);
    await chmod(launcher, 0o700);
    executable = launcher;
  }
  const manager = new BrowserManager({ electron_path: executable, operation_timeout_seconds: 10 }, new Map(), join(folder, 'profiles'));
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
    const last = document.querySelector('#overflow').hidden ? document.querySelector('#tabs') : document.querySelector('#overflow');
    return { rightPadding: innerWidth - last.getBoundingClientRect().right, height: header.height, width: innerWidth, tabs: [...document.querySelectorAll('.tab')].map(tab => { const rect = tab.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, active: tab.classList.contains('active') }; }) };
  };
  const normal = await ui.evaluate(geometry);
  assert.equal(normal.height, 48);
  assert.equal(normal.rightPadding, 8);
  assert.ok(normal.tabs.every(tab => tab.y >= 0 && tab.bottom <= 48 && tab.right <= normal.width));
  assert.ok(normal.tabs.find(tab => tab.active).width > normal.tabs.find(tab => !tab.active).width);
  await ui.screenshot({ path: join(tmpdir(), 'doze-electron-tabs.png'), clip: { x: 0, y: 0, width: normal.width, height: 48 } });
  await ui.setViewport({ width: 520, height: 600 });
  await ui.waitForFunction(() => document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth);
  const narrow = await ui.evaluate(geometry);
  assert.equal(narrow.rightPadding, 8);
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

test('Electron shortcuts: native input in sites and toolbar, hidden page retention, light and dark controls', { skip: !enabled || !process.env.DOZE_TEST_VIEWER || process.platform === 'win32', timeout: 45_000 }, async t => {
  const { manager, caller, url } = await setup(t, true);
  const pages = [];
  for (let i = 0; i < 10; i++) pages.push(await manager.call(caller, 'open_page', { url: url + '/' + i, headed: true }));
  const record = manager.pages.get(pages[0].page_id);
  const ui = await record.engine.page({ targetId: record.entry.uiTargetId });
  ui.setDefaultTimeout(5000);
  const command = process.platform === 'darwin' ? 'meta' : 'control';
  const key = async (page, keyCode, modifiers = [command]) => {
    const session = await page.createCDPSession();
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach();
    await ui.evaluate(data => {
      for (const type of ['keyDown', 'keyUp']) console.log('test-native-key:' + JSON.stringify({ ...data, type }));
    }, { target: targetInfo.targetId, keyCode, modifiers });
  };
  const active = id => ui.waitForFunction(id => document.querySelector('.tab.active')?.dataset.page === id, {}, id);
  await active(pages[9].page_id);
  await key(manager.pages.get(pages[9].page_id).page, '1'); await active(pages[0].page_id);
  await key(ui, '9'); await active(pages[9].page_id);
  await key(ui, 'Tab', ['control']); await active(pages[0].page_id);
  await key(ui, 'Tab', ['control', 'shift']); await active(pages[9].page_id);
  await key(ui, '2'); await active(pages[1].page_id);
  const site = manager.pages.get(pages[1].page_id).page;
  await key(site, 'l'); await ui.waitForFunction(() => document.activeElement.id === 'url');
  const ring = () => ({ tab: getComputedStyle(document.querySelector('.tab.active')).outlineWidth, input: getComputedStyle(document.querySelector('#url')).outlineStyle, button: getComputedStyle(document.querySelector('.tab.active .tab-select')).outlineStyle });
  assert.deepEqual(await ui.evaluate(ring), { tab: '2px', input: 'none', button: 'none' });
  await key(ui, '1'); await active(pages[0].page_id);
  await key(record.page, 'l'); await ui.waitForFunction(() => document.activeElement.id === 'url');
  await ui.keyboard.press('Escape');
  assert.deepEqual(await ui.evaluate(ring), { tab: '2px', input: 'none', button: 'none' });
  await record.page.evaluate(() => history.pushState({}, '', '/next'));
  await key(record.page, '['); await record.page.waitForFunction(() => location.pathname === '/0');
  await key(record.page, ']'); await record.page.waitForFunction(() => location.pathname === '/next');
  await record.page.evaluate(() => window.marker = 'before-reload');
  await key(record.page, 'r'); await record.page.waitForFunction(() => window.marker && marker !== 'before-reload');
  await record.page.evaluate(() => window.marker = 'before-fresh-reload');
  await key(ui, 'r', [command, 'shift']); await record.page.waitForFunction(() => window.marker && marker !== 'before-fresh-reload');
  const width = await record.page.evaluate(() => innerWidth);
  await key(ui, '='); await record.page.waitForFunction(width => innerWidth < width, {}, width);
  await key(record.page, '0'); await record.page.waitForFunction(width => innerWidth === width, {}, width);
  const marker = await record.page.evaluate(() => window.marker);
  await key(ui, 'w'); await active(pages[1].page_id);
  assert.equal(await record.page.evaluate(() => window.marker), marker);
  assert.equal(manager.pages.size, 10);
  await manager.call(caller, 'show_page', pages[0]); await active(pages[0].page_id);
  for (const theme of ['light', 'dark']) {
    await ui.evaluate(theme => console.log('test-native-theme:' + theme), theme);
    await ui.waitForFunction(dark => matchMedia('(prefers-color-scheme: dark)').matches === dark, {}, theme === 'dark');
    const palette = await ui.evaluate(() => {
      const color = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { background: color('html', 'backgroundColor'), text: color('html', 'color'), inactive: color('.tab:not(.active)', 'backgroundColor'), border: color('.tab:not(.active)', 'borderTopColor'), active: color('.tab.active', 'backgroundColor'), primary: color('.primary', 'backgroundColor') };
    });
    for (const color of Object.values(palette)) {
      const channels = color.match(/\d+/g).slice(0, 3).map(Number);
      assert.equal(channels[0], channels[1]); assert.equal(channels[1], channels[2]);
    }
    assert.notEqual(palette.inactive, palette.background);
    assert.notEqual(palette.active, palette.inactive);
    assert.notEqual(palette.border, palette.inactive);
    assert.equal(palette.background, theme === 'dark' ? 'rgb(28, 28, 28)' : 'rgb(245, 245, 245)');
    await ui.screenshot({ path: join(tmpdir(), `doze-tabs-${theme}.png`), clip: { x: 0, y: 0, width: 1200, height: 48 } });
  }
  await key(ui, 'w', [command, 'shift']);
  await waitFor(async () => (await record.engine.request('list')).every(page => !page.visible));
  assert.equal(manager.pages.size, 10);
});
