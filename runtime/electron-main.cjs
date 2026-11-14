const { app, BaseWindow, WebContentsView, ipcMain, session, nativeTheme, Menu, MenuItem, dialog } = require('electron');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { preserveSessionCookies } = require('./session-cookies.cjs');
const { OnePassword, extensionId } = require('./one-password.cjs');
const { pathToFileURL } = require('node:url');
const { readFile, writeFile } = require('node:fs/promises');
const { isUserOnlyURL, privacyError, PagePrivacy } = require('./privacy.cjs');
const { selectAnnotation, publicAnnotation } = require('./annotations.cjs');
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
let onePassword;
let registeringTab = false;
let extensionsLoaded;
let openExtensionTab;
let scriptsUsed = false;
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const uiURL = pathToFileURL(join(__dirname, 'ui/index.html')).href;
const toolbarPreload = join(profile, 'doze-toolbar-preload.cjs');
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
    onePassword: entry?.partition === 'persist:project' ? { ...onePassword.state, tabId: wc.id } : null,
    annotation: { active: !!view.annotating, available: !!entry && !entry.userOnly && !entry.dialog,
      draft: view.annotationDraft ? publicAnnotation(view.annotationDraft, entry) : null,
      zoom: wc?.getZoomFactor() || 1, viewport: view.annotationViewport,
      notes: view.annotating && entry ? entry.annotations.map(note => publicAnnotation(note, entry)) : [] },
    pages: view.tabs.map(id => entries.get(id)).filter(Boolean).map(pageState) };
}
function refresh() {
  if (quitting) return;
  refreshStopMenu();
  for (const view of views.values()) if (!view.window.isDestroyed()) {
    if (entries.get(view.active)?.dialog) stopAnnotations(view);
    for (const entry of entries.values()) if (entry.view === view && !entry.content.webContents.isDestroyed()) {
      entry.visible = view.active === entry.id && !entry.dialog;

    }
    resizeUI(view);
    view.ui.webContents.send('doze-state', state(view));
  }
}
function select(entry, showWindow = false) {
  const view = entry.view;
  if (view.active !== entry.id) stopAnnotations(view);
  if (!view.tabs.includes(entry.id)) view.tabs.push(entry.id);
  view.active = entry.id;
  if (entry.partition === 'persist:project' && !registeringTab) onePassword.host.selectTab(entry.content.webContents);
  resize(entry);
  view.window.contentView.addChildView(entry.content);
  view.window.contentView.addChildView(view.ui);
  refresh();
  if (showWindow) view.window.show();
  if (view.window.isVisible()) { if (entry.dialog) view.ui.webContents.focus(); else entry.content.webContents.focus(); }
}
function stopAnnotations(view) {
  view.annotating = false;
  view.annotationDraft = null;
  view.annotationToken = randomUUID();
}
function hideTab(view, id) {
  const index = view.tabs.indexOf(id);
  if (index === -1) throw new Error('Tab is not shown');
  view.tabs.splice(index, 1);
  if (view.active === id) {
    stopAnnotations(view);
    view.active = null;
    const next = entries.get(view.tabs[Math.min(index, view.tabs.length - 1)]);
    if (next) select(next);
  }
  if (!view.tabs.length) view.window.hide();
  refresh();
}
function runShortcut(view, { action, value }) {
  if (action === 'save-annotation') {
    if (view.annotating && view.annotationDraft) view.ui.webContents.send('doze-save-annotation');
    return;
  }
  if (view.annotating) { stopAnnotations(view); refresh(); }
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
  const saveAnnotation = browserMenu?.getMenuItemById('save-annotation');
  if (saveAnnotation) saveAnnotation.enabled = !!view?.annotating && !!view.annotationDraft;
  const contents = entry?.content.webContents;
  if (stop) stop.enabled = !!contents && !contents.isDestroyed() && !entry.dialog && contents.isFocused();
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
      command('注釈を保存', 'CommandOrControl+Enter', { action: 'save-annotation' }, { id: 'save-annotation', enabled: false }),
      { type: 'separator' },
      command('タブを隠す', 'CommandOrControl+W', { action: 'hide-tab' }),
      command('ウインドウを隠す', 'CommandOrControl+Shift+W', { action: 'hide-window' }),
    ] },
    { role: 'editMenu', label: '編集', id: 'edit-menu' },
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
  if (!mac) {
    const editMenu = browserMenu.getMenuItemById('edit-menu').submenu;
    editMenu.insert(editMenu.items.findIndex(item => item.role === 'paste') + 1, new MenuItem({ role: 'pasteAndMatchStyle' }));
  }
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
  const ui = new WebContentsView({ webPreferences: { preload: toolbarPreload, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  ui.setBackgroundColor('#00000000');
  window.contentView.addChildView(ui);
  const view = { key, window, ui, tabs: [], active: null };
  views.set(key, view);
  window.on('resize', () => {
    stopAnnotations(view);
    for (const entry of entries.values()) if (entry.view === view) resize(entry);
    resizeUI(view);
    refresh();
  });
  window.on('hide', () => { stopAnnotations(view); refresh(); });
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
  view.ui.setBounds({ x: 0, y: 0, width, height: entries.get(view.active)?.dialog || view.annotating ? height : toolbarHeight });
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
  const view = options.view || (opener ? entries.get(opener).view : views.get(key) || createView(key));
  // Reuse the renderer-created WebContents to retain the popup's initial navigation and opener.
  const content = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options.webPreferences, session: session.fromPartition(partition),
      preload: join(__dirname, 'electron-prompt.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  view.window.contentView.addChildView(content, 0);
  const entry = { id, partition, opener, view, content, favicon: '', visible: true, userOnly: !!options.userOnly || !!entries.get(opener)?.userOnly,
    annotations: [], document: randomUUID() };
  entries.set(id, entry);
  content.setVisible(true);
  resize(entry);
  const wc = content.webContents;
  wc.on('did-start-navigation', event => {
    if (event.isMainFrame) { entry.document = randomUUID(); if (view.active === id) { stopAnnotations(view); refresh(); } }
    if (event.isMainFrame && isUserOnlyURL(event.url) && !entry.userOnly) {
      entry.userOnly = true;
      output({ event: 'protected', page: id });
    }
  });
  if (partition === 'persist:project') {
    registeringTab = true;
    try { onePassword.host.addTab(wc, view.window); }
    finally { registeringTab = false; }
    wc.on('context-menu', (_event, params) => {
      const items = onePassword.host.getContextMenuItems(wc, params);
      if (items.length) Menu.buildFromTemplate(items).popup({ window: view.window, frame: params.frame });
    });
  }
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
    if (view.tabs.includes(id)) {
      if (quitting || view.window.isDestroyed()) { view.tabs.splice(view.tabs.indexOf(id), 1); if (view.active === id) view.active = null; }
      else hideTab(view, id);
    }
    for (const child of entries.values()) if (!quitting && child.opener === id && child.content.webContents && !child.content.webContents.isDestroyed()) child.content.webContents.close({ waitForBeforeUnload: false });
    output({ event: 'closed', page: id });
    if (![...entries.values()].some(e => e.view === view)) { views.delete(view.key); if (!view.window.isDestroyed()) view.window.destroy(); }
    refresh();
  });
  if (!entry.userOnly) output({ event: 'created', entry: { id, opener, targetId: wc.getOrCreateDevToolsTargetId(), uiTargetId: view.ui.webContents.getOrCreateDevToolsTargetId() } });
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
    case 'annotation-toggle': {
      if (view.annotating) { stopAnnotations(view); refresh(); break; }
      if (!entry || entry.userOnly || entry.dialog || !isShown(entry)) throw privacyError();
      view.annotating = true;
      view.annotationToken = randomUUID();
      const token = view.annotationToken;
      view.annotationDraft = null;
      view.annotationViewport = null;
      try {
        entry.privacy ||= new PagePrivacy(wc);
        await entry.privacy.start();
        const { cssLayoutViewport } = await entry.privacy.send('Page.getLayoutMetrics');
        view.annotationViewport = { width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight, scrollX: cssLayoutViewport.pageX, scrollY: cssLayoutViewport.pageY };
      } catch (error) { refresh(); throw error; }
      if (view.annotationToken !== token || view.active !== entry.id || !isShown(entry)) break;
      view.ui.webContents.focus(); refresh(); break;
    }
    case 'annotation-select': {
      if (!entry || !view.annotating || entry.userOnly || !isShown(entry)) throw privacyError();
      const token = view.annotationToken;
      view.annotationDraft = null;
      refresh();
      const draft = await selectAnnotation(entry, { kind: args.kind, x: args.x, y: args.y, width: args.width, height: args.height });
      if (view.annotationToken !== token || view.active !== entry.id) throw new Error('The page changed. Select the target again.');
      view.annotationDraft = draft;
      refresh(); break;
    }
    case 'annotation-cancel': view.annotationDraft = null; refresh(); break;
    case 'annotation-save': {
      const draft = view.annotationDraft;
      if (!entry || !view.annotating || !draft || draft.document !== entry.document || draft.url !== wc.getURL()) throw new Error('Select the annotation target again.');
      if (typeof args.comment !== 'string' || !args.comment.trim() || args.comment.length > 4000) throw new Error('Enter an annotation comment.');
      const token = view.annotationToken;
      const selected = await selectAnnotation(entry, draft.kind === 'element' ? draft : { kind: 'area', ...Object.fromEntries(Object.entries(draft.rect).map(([key, value]) => [key, value * draft.zoom])) });
      if (view.annotationToken !== token || view.active !== entry.id) throw new Error('The page changed. Select the target again.');
      entry.annotations.push({ ...selected, comment: args.comment.trim() });
      view.annotationDraft = null;
      refresh(); break;
    }
    case 'annotation-delete':
      if (!entry || !view.annotating || entry.userOnly) throw privacyError();
      entry.annotations = entry.annotations.filter(note => note.id !== args.id); refresh(); break;
    case 'ready': refresh(); break;
    case 'close-window': view.window.close(); break;
    case 'navigate':
      await navigate(entry, validateURL(args.url.includes('://') || args.url === 'about:blank' ? args.url : 'https://' + args.url));
      if (isShown(entry)) wc.focus();
      break;
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'one-password':
      if (entry?.partition !== 'persist:project') throw new Error('1Password requires a saved project session');
      try {
        await onePassword.enable();
        if (scriptsUsed) throw new Error('このセッションでは任意JavaScriptが実行されています。すべてのページを終了して開き直してから1Passwordを導入してください。');
        await onePassword.install();
        await openExtensionTab(view, 'app/app.html#/page/welcome');
      } catch (error) { await dialog.showMessageBox(view.window, { type: 'error', message: '1Passwordを開けませんでした', detail: error.message }); }
      break;
    case 'one-password-menu':
      if (entry?.partition !== 'persist:project' || !onePassword.state.installed) break;
      Menu.buildFromTemplate([
        { label: '1Passwordの設定', click: () => { void openExtensionTab(view, 'app/app.html#/page/settings').catch(error => dialog.showMessageBox(view.window, { type: 'error', message: error.message })); } },
        { label: '1Passwordを更新', enabled: !onePassword.state.busy, click: () => { void onePassword.install(true).catch(error => dialog.showMessageBox(view.window, { type: 'error', message: '1Passwordを更新できませんでした', detail: error.message })); } },
      ]).popup({ window: view.window });
      break;
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
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  // The library ships a bundled renderer API. Combine it with our bridge for Electron's sandboxed preload.
  const actionPreload = await readFile(require.resolve('electron-chrome-extensions/browser-action'), 'utf8');
  await writeFile(toolbarPreload, actionPreload + '\nmodule.exports.injectBrowserAction();\n' + await readFile(join(__dirname, 'ui/preload.cjs'), 'utf8'), { mode: 0o600 });
  installMenuShortcuts();
  const projectSession = session.fromPartition('persist:project');
  const entryFor = contents => [...entries.values()].find(entry => entry.content.webContents === contents);
  const extensionSource = windowId => {
    const focused = BaseWindow.getFocusedWindow();
    const view = [...views.values()].find(view => view.window.id === windowId)
      || [...views.values()].find(view => view.window === focused || view.window === focused?.getParentWindow());
    const entry = entries.get(view?.active) || [...entries.values()].find(entry => entry.view === view)
      || [...entries.values()].find(entry => entry.partition === 'persist:project');
    if (!entry || entry.partition !== 'persist:project') throw new Error('No project tab is available for the extension');
    return entry;
  };
  const createExtensionTab = async (details, view) => {
    const source = extensionSource(details.windowId);
    const url = new URL(details.url || 'about:blank');
    if (!['http:', 'https:'].includes(url.protocol) && url.href !== 'about:blank'
      && !(url.protocol === 'chrome-extension:' && url.host === extensionId)) throw new Error('Unsupported extension tab URL');
    const child = make(randomUUID(), source.partition, source.id, { view, userOnly: isUserOnlyURL(url.href) });
    try { await navigate(child, url.href); }
    catch (error) { child.content.webContents.close({ waitForBeforeUnload: false }); throw error; }
    if (details.active !== false) select(child, source.view.window.isVisible());
    return [child.content.webContents, child.view.window];
  };
  openExtensionTab = (view, path) => createExtensionTab({ windowId: view.window.id, url: `chrome-extension://${extensionId}/${path}` });
  onePassword = new OnePassword(projectSession, profile, {
    createTab: details => createExtensionTab(details),
    selectTab: contents => { const entry = entryFor(contents); if (entry && !registeringTab && entry.view.active !== entry.id) select(entry); },
    removeTab: contents => { if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false }); },
    createWindow: async details => {
      const source = extensionSource();
      const view = createView(randomUUID());
      try {
        const urls = Array.isArray(details.url) ? details.url : [details.url || 'about:blank'];
        for (const url of urls) await createExtensionTab({ url, windowId: source.view.window.id }, view);
        return view.window;
      } catch (error) { if (!view.window.isDestroyed()) view.window.destroy(); throw error; }
    },
    removeWindow: window => {
      for (const entry of entries.values()) if (entry.view.window === window) entry.content.webContents.close({ waitForBeforeUnload: false });
    },
    requestPermissions: async () => false,
  }, refresh);
  const flush = await preserveSessionCookies(session.fromPartition('persist:project'), join(profile, 'session-cookies.enc'), () => { output({ event: 'fatal', message: 'Cannot securely preserve session cookies' }); app.exit(1); });
  output({ ready: true });
  readline.createInterface({ input: process.stdin }).on('line', line => { void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      let result;
      switch (message.action) {
        case 'policy': {
          const entry = entries.get(message.page);
          if (!entry) throw new Error('Page is closed');
          if (entry.userOnly || isUserOnlyURL(entry.content.webContents.getURL())) throw privacyError();
          if (entry.view.annotating && entry.view.active === entry.id && message.operation !== 'get_annotations') throw new Error('The user is adding annotations. Wait until annotation mode is closed.');
          const enabled = entry.partition === 'persist:project' && onePassword.enabled;
          if (message.operation === 'evaluate_script') {
            if (enabled) throw new Error('Arbitrary JavaScript is disabled in sessions with 1Password enabled. Use inspect_page, click and fill.');
            scriptsUsed = true;
          }
          if (!enabled) { result = { enabled: false }; break; }
          entry.privacy ||= new PagePrivacy(entry.content.webContents);
          const report = await entry.privacy.report();
          if (report.entered) throw privacyError();
          if (message.operation === 'take_screenshot' && (report.passwords || report.privateFrames)) throw privacyError();
          if (message.version !== undefined && message.version !== report.version) throw new Error('The page changed during this operation. No content was returned; inspect the page again.');
          result = { enabled: true, ...report }; break;
        }
        case 'open': {
          const entry = make(message.page, message.partition, undefined, {}, message.owner);
          await entry.content.webContents.loadURL('about:blank');
          if (message.partition === 'persist:project') {
            extensionsLoaded ||= onePassword.loadInstalled().catch(error => { onePassword.error = error.message; refresh(); });
            await extensionsLoaded;
          }
          result = true; break;
        }
        case 'navigate': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); await navigate(entry, validateURL(message.url)); result = true; break; }
        case 'show': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); select(entry, true); result = true; break; }
        case 'close': entries.get(message.page)?.content.webContents.close({ waitForBeforeUnload: false }); result = true; break;
        case 'answer': { const entry = entries.get(message.page); if (!entry || entry.dialog?.info.id !== message.dialog) throw new Error('Dialog is no longer open'); finishDialog(entry, !!message.accept, message.text); result = true; break; }
        case 'capture': {
          const entry = entries.get(message.page);
          if (!entry) throw new Error('Page is closed');
          if (entry.userOnly || isUserOnlyURL(entry.content.webContents.getURL())) throw privacyError();
          const protectedSession = entry.partition === 'persist:project' && onePassword.enabled;
          const before = protectedSession ? await (entry.privacy ||= new PagePrivacy(entry.content.webContents)).report() : null;
          if (before && (before.passwords || before.privateFrames)) throw privacyError();
          const bounds = entry.content.getBounds();
          try {
            entry.content.setBounds({ ...bounds, width: message.width, height: message.height });
            await entry.content.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
            const image = await entry.content.webContents.capturePage();
            if (image.isEmpty()) throw new Error('Browser capture returned an empty image');
            if (before) {
              const after = await entry.privacy.report();
              if (after.passwords || after.privateFrames || after.version !== before.version || entry.userOnly) throw privacyError();
            }
            result = image.resize({ width: Math.round(message.width * message.scale), height: Math.round(message.height * message.scale) }).toPNG().toString('base64');
          } finally {
            if (!entry.content.webContents.isDestroyed()) entry.content.setBounds(bounds);
          }
          break;
        }
        case 'list': result = [...entries.values()].filter(entry => !entry.userOnly && !isUserOnlyURL(entry.content.webContents.getURL())).map(e => ({ ...pageState(e), visible: isShown(e) })); break;
        case 'annotations': {
          const entry = entries.get(message.page);
          if (!entry || entry.userOnly || isUserOnlyURL(entry.content.webContents.getURL())) throw privacyError();
          result = entry.annotations.map(note => publicAnnotation(note, entry)); break;
        }
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
