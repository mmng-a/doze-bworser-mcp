const { app, BrowserWindow, WebContentsView, ipcMain, session } = require('electron');
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
const configuredSessions = new WeakSet();
let quitting = false;
const output = message => process.stdout.write(JSON.stringify(message) + '\n');
const uiURL = pathToFileURL(join(__dirname, 'ui/index.html')).href;
function state(entry) {
  let origin = '';
  try { origin = new URL(entry.content.webContents.getURL()).origin; } catch {}
  const wc = entry.content.webContents;
  return { id: entry.id, mac: process.platform === 'darwin', url: wc.getURL(), origin,
    back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), dialog: entry.dialog?.info,
    pages: [...entries.values()].filter(e => e.family === entry.family).map(e => ({ id: e.id, title: e.content.webContents.getTitle(), url: e.content.webContents.getURL() })) };
}
function refresh() {
  for (const entry of entries.values()) if (!entry.window.isDestroyed() && !entry.content.webContents.isDestroyed()) {
    entry.content.setVisible(!entry.dialog);
    entry.window.webContents.send('doze-state', state(entry));
  }
}
function finishDialog(entry, accept, text) {
  const dialog = entry.dialog;
  if (!dialog) throw new Error('No JavaScript dialog is open on this page');
  entry.dialog = null;
  dialog.callback(accept, typeof text === 'string' ? text : dialog.info.defaultValue || '');
  output({ event: 'answered', page: entry.id, dialog: dialog.info.id });
  refresh();
}
function configurePermissions(browserSession) {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  const granted = new Set();
  browserSession.setPermissionCheckHandler((_contents, permission, origin) => {
    try { return granted.has(permission + ':' + new URL(origin).origin); } catch { return false; }
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const entry = [...entries.values()].find(e => e.content.webContents === contents);
    if (!entry || !entry.window.isVisible() || entry.dialog) { callback(false); return; }
    const labels = { media: 'カメラ・マイク', geolocation: '位置情報', notifications: '通知', 'clipboard-read': 'クリップボードの読み取り', 'clipboard-sanitized-write': 'クリップボードへの書き込み', fullscreen: '全画面表示', pointerLock: 'ポインターの固定' };
    const origin = new URL(details.requestingUrl || contents.getURL()).origin;
    entry.dialog = { callback: accept => { if (accept) granted.add(permission + ':' + origin); callback(accept); }, info: { id: randomUUID(), type: 'permission', message: `このサイトによる「${labels[permission] || permission}」の使用を許可しますか？`, defaultValue: '' } };
    output({ event: 'dialog', page: entry.id, dialog: entry.dialog.info.id, ...entry.dialog.info });
    refresh();
  });
}
function make(id, partition, opener, options = {}) {
  configurePermissions(session.fromPartition(partition));
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, minWidth: 520, minHeight: 380,
    title: 'doze', backgroundColor: '#f5f7f4', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: { preload: join(__dirname, 'ui/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  // A renderer-created popup already has a WebContents. Reuse it to preserve
  // its initial navigation, WindowProxy and opener relationship.
  const content = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}),
    webPreferences: { ...options.webPreferences, session: session.fromPartition(partition),
      preload: join(__dirname, 'electron-prompt.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  window.contentView.addChildView(content);
  const entry = { id, partition, opener, family: opener ? entries.get(opener).family : id, window, content };
  entries.set(id, entry);
  const wc = content.webContents;
  const resize = () => { const [width, height] = window.getContentSize(); content.setBounds({ x: 0, y: 64, width, height: Math.max(1, height - 64) }); };
  resize(); window.on('resize', resize);
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.meta || input.control) && input.key.toLowerCase() === 'l') { event.preventDefault(); window.webContents.focus(); window.webContents.send('doze-focus-url'); }
  });
  // This version-pinned internal handler is the only non-public Electron integration.
  // Keep the native callback from creation, including before Puppeteer can acquire Page.
  if (wc.listenerCount('-run-dialog') !== 1) throw new Error('Unsupported Electron dialog implementation');
  wc.removeAllListeners('-run-dialog');
  wc.on('-run-dialog', (info, callback) => {
    entry.dialog = { callback, info: { id: randomUUID(), type: info.dialogType, message: info.messageText, defaultValue: info.defaultPromptText } };
    output({ event: 'dialog', page: id, dialog: entry.dialog.info.id, ...entry.dialog.info });
    refresh();
  });
  wc.on('-cancel-dialogs', () => { if (entry.dialog) { const dialog = entry.dialog.info.id; entry.dialog = null; output({ event: 'answered', page: id, dialog }); refresh(); } });
  wc.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false,
    webPreferences: { preload: join(__dirname, 'electron-prompt.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } },
    createWindow: options => {
      const child = make(randomUUID(), partition, id, options);
      if (window.isVisible()) { window.hide(); child.window.show(); }
      return child.content.webContents;
    } }));
  for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) wc.on(event, refresh);
  wc.on('destroyed', () => {
    for (const child of entries.values()) if (child.opener === id) child.content.webContents.close({ waitForBeforeUnload: false });
    entries.delete(id);
    output({ event: 'closed', page: id });
    window.destroy();
    refresh();
  });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.webContents.once('did-finish-load', refresh);
  void window.loadURL(uiURL);
  output({ event: 'created', entry: { id, opener, targetId: wc.getOrCreateDevToolsTargetId(), uiTargetId: window.webContents.getOrCreateDevToolsTargetId() } });
  return entry;
}
async function navigate(entry, url) { await entry.content.webContents.loadURL(url); }
function validateURL(value) {
  const url = new URL(value);
  if (value !== 'about:blank' && !['http:', 'https:'].includes(url.protocol)) throw new Error('Use HTTP(S) or about:blank');
  return url.href;
}
ipcMain.handle('doze-ui', async (event, action, args = {}) => {
  const entry = [...entries.values()].find(e => e.window.webContents === event.sender && event.senderFrame === event.sender.mainFrame);
  if (!entry) throw new Error('Invalid browser UI sender');
  const wc = entry.content.webContents;
  switch (action) {
    case 'ready': refresh(); break;
    case 'hide': entry.window.hide(); break;
    case 'navigate': await navigate(entry, validateURL(args.url.includes('://') || args.url === 'about:blank' ? args.url : 'https://' + args.url)); break;
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
    case 'reload': wc.reload(); break;
    case 'switch': { const next = entries.get(args.page); if (!next || next.family !== entry.family) throw new Error('Unknown related page'); entry.window.hide(); next.window.show(); break; }
    case 'answer': if (entry.dialog?.info.id !== args.dialog) throw new Error('Dialog is no longer open'); finishDialog(entry, !!args.accept, args.text); break;
    default: throw new Error('Unknown browser UI action');
  }
});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const flush = await preserveSessionCookies(session.fromPartition('persist:project'), join(profile, 'session-cookies.enc'), () => { output({ event: 'fatal', message: 'Cannot securely preserve session cookies' }); app.exit(1); });
  output({ ready: true });
  readline.createInterface({ input: process.stdin }).on('line', line => { void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      let result;
      switch (message.action) {
        case 'open': { const entry = make(message.page, message.partition); await entry.content.webContents.loadURL('about:blank'); result = true; break; }
        case 'navigate': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); await navigate(entry, validateURL(message.url)); result = true; break; }
        case 'show': { const entry = entries.get(message.page); if (!entry) throw new Error('Page is closed'); entry.window.show(); refresh(); result = true; break; }
        case 'close': entries.get(message.page)?.content.webContents.close({ waitForBeforeUnload: false }); result = true; break;
        case 'answer': { const entry = entries.get(message.page); if (!entry || entry.dialog?.info.id !== message.dialog) throw new Error('Dialog is no longer open'); finishDialog(entry, !!message.accept, message.text); result = true; break; }
        case 'capture-probe': {
          const entry = entries.get(message.page), wc = entry.content.webContents;
          if (message.mode === 'ui-throttle') entry.window.webContents.setBackgroundThrottling(false);
          else if (message.mode === 'focus') wc.focus();
          else result = (await wc.capturePage()).toPNG().toString('base64');
          break;
        }
        case 'list': result = [...entries.values()].map(e => ({ id: e.id, url: e.content.webContents.getURL(), title: e.content.webContents.getTitle(), visible: e.window.isVisible() })); break;
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
