const { app, BaseWindow, WebContentsView, ipcMain, session, nativeTheme, Menu, MenuItem } = require('electron');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { preserveSessionCookies } = require('./session-cookies.cjs');
const { pathToFileURL } = require('node:url');
const profile = process.env.DOZE_ELECTRON_PROFILE;
if (!profile) throw new Error('Missing private browser profile');
app.setPath('userData', profile);
app.setName('doze');
const entries = new Map();
const views = new Map();
const configuredSessions = new WeakSet();
const toolbarHeight = 48;
let quitting = false;
let browserMenu;
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const uiURL = pathToFileURL(join(__dirname, 'ui/index.html')).href;
function pageState(entry) {
  const wc = entry.content.webContents;
  return { id: entry.id, title: wc.getTitle(), url: wc.getURL(), favicon: entry.favicon };
}
function state(view) {
  const entry = entries.get(view.active);
  let origin = '';
  try { origin = new URL(entry.content.webContents.getURL()).origin; } catch {}
  const wc = entry?.content.webContents;
  return { id: entry?.id, mac: process.platform === 'darwin', url: wc?.getURL() || '', origin,
    back: wc?.navigationHistory.canGoBack() || false, forward: wc?.navigationHistory.canGoForward() || false, dialog: entry?.dialog?.info,
    pages: view.tabs.map(id => entries.get(id)).filter(Boolean).map(pageState) };
}
function refresh() {
  refreshStopMenu();
  for (const view of views.values()) if (!view.window.isDestroyed()) {
    for (const entry of entries.values()) if (entry.view === view && !entry.content.webContents.isDestroyed()) {
      entry.visible = view.active === entry.id && !entry.dialog;

    }
    resizeUI(view);
    view.ui.webContents.send('doze-state', state(view));
  }
}
function select(entry, showWindow = false) {
  const view = entry.view;
  if (!view.tabs.includes(entry.id)) view.tabs.push(entry.id);
  view.active = entry.id;
  resize(entry);
  view.window.contentView.addChildView(entry.content);
  view.window.contentView.addChildView(view.ui);
  refresh();
  if (showWindow) view.window.show();
  if (view.window.isVisible()) { if (entry.dialog) view.ui.webContents.focus(); else entry.content.webContents.focus(); }
}
function hideTab(view, id) {
  const index = view.tabs.indexOf(id);
  if (index === -1) throw new Error('Tab is not shown');
  view.tabs.splice(index, 1);
  if (view.active === id) {
    view.active = null;
    const next = entries.get(view.tabs[Math.min(index, view.tabs.length - 1)]);
    if (next) select(next);
  }
  if (!view.tabs.length) view.window.hide();
  refresh();
}
function runShortcut(view, { action, value }) {
  const entry = entries.get(view.active);
  const wc = entry?.content.webContents;
  if (!wc) return;
  if (action === 'tab') {
    const id = view.tabs[value === 9 ? view.tabs.length - 1 : value - 1];
    if (id) select(entries.get(id));
  } else if (action === 'cycle') {
    const index = (view.tabs.indexOf(view.active) + value + view.tabs.length) % view.tabs.length;
    select(entries.get(view.tabs[index]));
  } else if (action === 'hide-tab') hideTab(view, entry.id);
  else if (action === 'hide-window') view.window.hide();
  else if (!entry.dialog) {
    if (action === 'url') { view.ui.webContents.focus(); view.ui.webContents.send('doze-focus-url'); }
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'reload-fresh') wc.reloadIgnoringCache();
    else if (action === 'stop') wc.stop();
    else if (action === 'zoom') wc.setZoomLevel(value === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + value)));
  }
}
function refreshStopMenu() {
  const view = [...views.values()].find(view => view.window === BaseWindow.getFocusedWindow());
  const entry = entries.get(view?.active);
  const stop = browserMenu?.getMenuItemById('stop');
  if (stop) stop.enabled = !!entry && !entry.dialog && entry.content.webContents.isFocused();
}
function installMenuShortcuts() {
  const mac = process.platform === 'darwin';
  const command = (label, accelerator, shortcut, options = {}) => ({ label, accelerator, ...options, click: (_item, window) => {
    const view = [...views.values()].find(view => view.window === window);
    if (view) runShortcut(view, shortcut);
  } });
  const alias = (accelerator, shortcut) => command('', accelerator, shortcut, { visible: false });
  browserMenu = Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'ファイル', submenu: [
      command('URLを開く…', 'CommandOrControl+L', { action: 'url' }),
      { type: 'separator' },
      command('タブを隠す', 'CommandOrControl+W', { action: 'hide-tab' }),
      command('ウインドウを隠す', 'CommandOrControl+Shift+W', { action: 'hide-window' }),
    ] },
    { role: 'editMenu', label: '編集' },
    { label: '表示', submenu: [
      command('再読み込み', 'CommandOrControl+R', { action: 'reload' }),
      command('キャッシュを無視して再読み込み', 'CommandOrControl+Shift+R', { action: 'reload-fresh' }),
      alias('F5', { action: 'reload' }),
      alias('Shift+F5', { action: 'reload-fresh' }),
      command('読み込みを停止', 'Escape', { action: 'stop' }, { id: 'stop', enabled: false }),
      { type: 'separator' },
      command('実際のサイズ', 'CommandOrControl+0', { action: 'zoom', value: 0 }),
      command('拡大', 'CommandOrControl+Plus', { action: 'zoom', value: 1 }),
      alias('CommandOrControl+=', { action: 'zoom', value: 1 }),
      command('縮小', 'CommandOrControl+-', { action: 'zoom', value: -1 }),
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: '履歴', submenu: [
      command('戻る', 'CommandOrControl+[', { action: 'back' }),
      command('進む', 'CommandOrControl+]', { action: 'forward' }),
      alias(mac ? 'Command+Left' : 'Alt+Left', { action: 'back' }),
      alias(mac ? 'Command+Right' : 'Alt+Right', { action: 'forward' }),
    ] },
    mac ? { role: 'windowMenu', label: 'ウインドウ', id: 'window-menu' } : { label: 'ウインドウ', id: 'window-menu', submenu: [{ role: 'minimize' }] },
  ]);
  const windowMenu = browserMenu.getMenuItemById('window-menu').submenu;
  windowMenu.append(new MenuItem({ type: 'separator' }));
  windowMenu.append(new MenuItem(command('次のタブを表示', 'Control+Tab', { action: 'cycle', value: 1 })));
  windowMenu.append(new MenuItem(command('前のタブを表示', 'Control+Shift+Tab', { action: 'cycle', value: -1 })));
  if (mac) {
    windowMenu.append(new MenuItem(alias('Command+Shift+]', { action: 'cycle', value: 1 })));
    windowMenu.append(new MenuItem(alias('Command+Shift+[', { action: 'cycle', value: -1 })));
  }
  windowMenu.append(new MenuItem({ type: 'separator' }));
  for (let number = 1; number <= 9; number++) windowMenu.append(new MenuItem(command(number === 9 ? '最後のタブを表示' : `${number}番目のタブを表示`, `CommandOrControl+${number}`, { action: 'tab', value: number })));
  Menu.setApplicationMenu(browserMenu);
}
function createView(key) {
  const window = new BaseWindow({ show: false, width: 1200, height: 900, minWidth: 520, minHeight: 380,
    title: 'doze', autoHideMenuBar: process.platform !== 'darwin', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#f5f5f5', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 17 } } : {}) });
  const ui = new WebContentsView({ webPreferences: { preload: join(__dirname, 'ui/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.contentView.addChildView(ui);
  const view = { key, window, ui, tabs: [], active: null };
  views.set(key, view);
  window.on('resize', () => {
    for (const entry of entries.values()) if (entry.view === view) resize(entry);
    resizeUI(view);
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { if (!ui.webContents.isDestroyed()) ui.webContents.close({ waitForBeforeUnload: false }); });
  ui.webContents.on('focus', refreshStopMenu);
  ui.webContents.on('blur', refreshStopMenu);
  window.on('focus', refreshStopMenu);
  ui.webContents.once('did-finish-load', refresh);
  resizeUI(view);
  void ui.webContents.loadURL(uiURL);
  return view;
}
function resizeUI(view) {
  const [width, height] = view.window.getContentSize();
  view.ui.setBounds({ x: 0, y: 0, width, height: entries.get(view.active)?.dialog ? height : toolbarHeight });
}
function resize(entry) {
  const [width, height] = entry.view.window.getContentSize();
  entry.content.setBounds({ x: 0, y: toolbarHeight, width, height: Math.max(1, height - toolbarHeight) });
}
function finishDialog(entry, accept, text) {
  const dialog = entry.dialog;
  if (!dialog) throw new Error('No JavaScript dialog is open on this page');
  entry.dialog = null;
  dialog.callback(accept, typeof text === 'string' ? text : dialog.info.defaultValue || '');
  output({ event: 'answered', page: entry.id, dialog: dialog.info.id });
  refresh();
  if (entry.view.active === entry.id && entry.view.window.isVisible()) entry.content.webContents.focus();
}
function isShown(entry) { return entry.view.active === entry.id && entry.view.window.isVisible(); }
function configurePermissions(browserSession) {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  const granted = new Set();
  browserSession.setPermissionCheckHandler((_contents, permission, origin) => {
    try { return granted.has(permission + ':' + new URL(origin).origin); } catch { return false; }
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const entry = [...entries.values()].find(e => e.content.webContents === contents);
    if (!entry || !isShown(entry) || entry.dialog) { callback(false); return; }
    const labels = { media: 'カメラ・マイク', geolocation: '位置情報', notifications: '通知', 'clipboard-read': 'クリップボードの読み取り', 'clipboard-sanitized-write': 'クリップボードへの書き込み', fullscreen: '全画面表示', pointerLock: 'ポインターの固定' };
    const origin = new URL(details.requestingUrl || contents.getURL()).origin;
    entry.dialog = { callback: accept => { if (accept) granted.add(permission + ':' + origin); callback(accept); }, info: { id: randomUUID(), type: 'permission', origin, message: `このサイトによる「${labels[permission] || permission}」の使用を許可しますか？`, defaultValue: '' } };
    output({ event: 'dialog', page: entry.id, dialog: entry.dialog.info.id, ...entry.dialog.info });
    refresh();
  });
}
function make(id, partition, opener, options = {}, owner) {
  configurePermissions(session.fromPartition(partition));
  const key = JSON.stringify([partition, owner]);
  const view = opener ? entries.get(opener).view : views.get(key) || createView(key);
  // Reuse the renderer-created WebContents to retain the popup's initial navigation and opener.
  const content = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options.webPreferences, session: session.fromPartition(partition),
      preload: join(__dirname, 'electron-prompt.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  view.window.contentView.addChildView(content, 0);
  const entry = { id, partition, opener, view, content, favicon: '', visible: true };
  entries.set(id, entry);
  content.setVisible(true);
  resize(entry);
  const wc = content.webContents;
  wc.on('focus', refreshStopMenu);
  wc.on('blur', refreshStopMenu);
  // Keep the native callback from creation, before Puppeteer can acquire the Page.
  // This version-pinned internal handler is the only non-public Electron integration.
  if (wc.listenerCount('-run-dialog') !== 1) throw new Error('Unsupported Electron dialog implementation');
  wc.removeAllListeners('-run-dialog');
  wc.on('-run-dialog', (info, callback) => {
    entry.dialog = { callback, info: { id: randomUUID(), type: info.dialogType, message: info.messageText, defaultValue: info.defaultPromptText } };
    output({ event: 'dialog', page: id, dialog: entry.dialog.info.id, ...entry.dialog.info });
    refresh();
    if (isShown(entry)) view.ui.webContents.focus();
  });
  wc.on('-cancel-dialogs', () => { if (entry.dialog) { const dialog = entry.dialog.info.id; entry.dialog = null; output({ event: 'answered', page: id, dialog }); refresh(); } });
  wc.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false,
    webPreferences: { preload: join(__dirname, 'electron-prompt.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } },
    createWindow: options => {
      const shown = isShown(entry);
      const child = make(randomUUID(), partition, id, options);
      if (shown) select(child);
      return child.content.webContents;
    } }));
  wc.on('page-favicon-updated', (_event, icons) => {
    entry.favicon = icons.find(icon => /^https?:\/\//i.test(icon) || /^data:image\//i.test(icon)) || '';
    refresh();
  });
  wc.on('did-navigate', () => { entry.favicon = ''; refresh(); });
  for (const event of ['did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) wc.on(event, refresh);
  wc.on('destroyed', () => {
    entries.delete(id);
    if (view.tabs.includes(id)) hideTab(view, id);
    for (const child of entries.values()) if (child.opener === id) child.content.webContents.close({ waitForBeforeUnload: false });
    output({ event: 'closed', page: id });
    if (![...entries.values()].some(e => e.view === view)) { views.delete(view.key); if (!view.window.isDestroyed()) view.window.destroy(); }
    refresh();
  });
  output({ event: 'created', entry: { id, opener, targetId: wc.getOrCreateDevToolsTargetId(), uiTargetId: view.ui.webContents.getOrCreateDevToolsTargetId() } });
  return entry;
}
async function navigate(entry, url) { await entry.content.webContents.loadURL(url); }
function validateURL(value) {
  const url = new URL(value);
  if (value !== 'about:blank' && !['http:', 'https:'].includes(url.protocol)) throw new Error('Use HTTP(S) or about:blank');
  return url.href;
}
ipcMain.handle('doze-ui', async (event, action, args = {}) => {
  const view = [...views.values()].find(v => v.ui.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
  if (!view) throw new Error('Invalid browser UI sender');
  const entry = entries.get(view.active);
  const wc = entry?.content.webContents;
  switch (action) {
    case 'ready': refresh(); break;
    case 'close-window': view.window.close(); break;
    case 'navigate':
      await navigate(entry, validateURL(args.url.includes('://') || args.url === 'about:blank' ? args.url : 'https://' + args.url));
      if (isShown(entry)) wc.focus();
      break;
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'switch': {
      const next = entries.get(args.page);
      if (!next || next.view !== view || !view.tabs.includes(next.id)) throw new Error('Unknown shown page');
      select(next); break;
    }
    case 'hide-tab': hideTab(view, args.page); break;
    case 'answer': if (entry?.dialog?.info.id !== args.dialog) throw new Error('Dialog is no longer open'); finishDialog(entry, !!args.accept, args.text); break;
    default: throw new Error('Unknown browser UI action');
  }
});
nativeTheme.on('updated', () => {
  for (const view of views.values()) view.window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1c' : '#f5f5f5');
});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  installMenuShortcuts();
  const flush = await preserveSessionCookies(session.fromPartition('persist:project'), join(profile, 'session-cookies.enc'), () => { output({ event: 'fatal', message: 'Cannot securely preserve session cookies' }); app.exit(1); });
  output({ ready: true });
  readline.createInterface({ input: process.stdin }).on('line', line => { void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      let result;
      switch (message.action) {
        case 'open': { const entry = make(message.page, message.partition, undefined, {}, message.owner); await entry.content.webContents.loadURL('about:blank'); result = true; break; }
        case 'navigate': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); await navigate(entry, validateURL(message.url)); result = true; break; }
        case 'show': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); select(entry, true); result = true; break; }
        case 'close': entries.get(message.page)?.content.webContents.close({ waitForBeforeUnload: false }); result = true; break;
        case 'answer': { const entry = entries.get(message.page); if (!entry || entry.dialog?.info.id !== message.dialog) throw new Error('Dialog is no longer open'); finishDialog(entry, !!message.accept, message.text); result = true; break; }
        case 'capture': {
          const entry = entries.get(message.page);
          if (!entry) throw new Error('Page is closed');
          const bounds = entry.content.getBounds();
          try {
            entry.content.setBounds({ ...bounds, width: message.width, height: message.height });
            await entry.content.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
            const image = await entry.content.webContents.capturePage();
            if (image.isEmpty()) throw new Error('Browser capture returned an empty image');
            result = image.resize({ width: Math.round(message.width * message.scale), height: Math.round(message.height * message.scale) }).toPNG().toString('base64');
          } finally {
            if (!entry.content.webContents.isDestroyed()) entry.content.setBounds(bounds);
          }
          break;
        }
        case 'list': result = [...entries.values()].map(e => ({ ...pageState(e), visible: isShown(e) })); break;
        case 'quit':
          quitting = true;
          for (const entry of entries.values()) entry.content.webContents.close({ waitForBeforeUnload: false });
          await flush();
          output({ id: message.id, result: true }); app.quit(); return;
        default: throw new Error('Unknown browser command');
      }
      output({ id: message.id, result });
    } catch (error) { output({ id: message?.id, error: error.message }); }
  })(); });
}).catch(() => { output({ event: 'fatal', message: 'Cannot initialize secure browser storage' }); app.exit(1); });
process.stdin.once('end', () => { quitting = true; app.quit(); });
