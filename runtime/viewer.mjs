import puppeteer from 'puppeteer-core';
import { DevToolsBridge } from './devtools-bridge.mjs';

/** Own display-only Chrome and authenticated views; site storage stays in headless Chrome. */
export class ViewerManager {
  constructor(config) {
    this.config = config;
    this.views = new Map();
    this.tail = Promise.resolve();
  }
  serial(action) {
    const next = this.tail.catch(() => {}).then(action);
    this.tail = next;
    return next;
  }
  async open(record, signal) {
    const queuedAt = Date.now();
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (Date.now() - queuedAt >= this.config.operation_timeout_seconds * 1000) throw new Error('Timed out waiting to open the shared view');
      if (record.controller.closed) throw record.controller.closed;
      const startup = new AbortController();
      let browser = this.browser;
      let view = this.views.get(record.id);
      let front = view?.front;
      let bridge;
      const abort = () => startup.abort(signal.reason);
      const pageClosed = () => { if (record.controller.closed) startup.abort(record.controller.closed); };
      signal?.addEventListener('abort', abort, { once: true });
      record.controller.on('change', pageClosed);
      const deadline = setTimeout(() => startup.abort(new Error('Shared view startup timed out')), this.config.operation_timeout_seconds * 1000);
      startup.signal.addEventListener('abort', () => {
        if (front) void this.closeFront(front, browser);
        else browser?.process()?.kill('SIGKILL');
      }, { once: true });
      try {
        if (view && !front.isClosed()) {
          await front.bringToFront();
          startup.signal.throwIfAborted();
          return;
        }
        if (view) {
          await this.dispose(view);
          view = null;
          front = null;
          browser = this.browser;
        }
        if (!browser) {
          browser = await puppeteer.launch({ executablePath: this.config.chrome_path, headless: false,
            pipe: true, timeout: 0, protocolTimeout: this.config.operation_timeout_seconds * 1000, signal: startup.signal,
            waitForInitialPage: false, defaultViewport: null, args: ['--no-startup-window', '--window-size=1440,1000'] });
          startup.signal.throwIfAborted();
          this.browser = browser;
          browser.once('disconnected', () => {
            if (this.browser === browser) this.browser = null;
            for (const item of this.views.values()) if (item.browser === browser) {
              void item.bridge.close();
              void this.close(item.record.id).catch(() => {});
            }
          });
        }
        bridge = new DevToolsBridge(record);
        const endpoint = await bridge.listen(startup.signal);
        startup.signal.throwIfAborted();
        front = await browser.newPage({ type: 'window', background: true });
        startup.signal.throwIfAborted();
        view = { record, browser, front, bridge };
        this.views.set(record.id, view);
        front.once('close', () => {
          void bridge.close();
          void this.close(record.id).catch(() => {});
        });
        front.setDefaultTimeout(this.config.operation_timeout_seconds * 1000);
        front.setDefaultNavigationTimeout(this.config.operation_timeout_seconds * 1000);
        await record.engine.session.send('Target.activateTarget', { targetId: record.targetId }, { timeout: this.config.operation_timeout_seconds * 1000 });
        await front.goto('devtools://devtools/bundled/inspector.html?ws=' + endpoint, { waitUntil: 'domcontentloaded' });
        startup.signal.throwIfAborted();
        const toggle = await front.waitForSelector('::-p-aria(Toggle screencast)');
        try {
          await front.waitForFunction(element => !element.disabled, {}, toggle);
          if (!await toggle.evaluate(element => element.toggled)) await toggle.asLocator().click();
        } finally { await toggle.dispose(); }
        await front.waitForFunction(hasCanvas);
        startup.signal.throwIfAborted();
        if (record.controller.closed) throw new Error('Page is closed');
        await front.bringToFront();
        startup.signal.throwIfAborted();
      } catch {
        if (view) await this.dispose(view);
        else {
          if (bridge) await bridge.close();
          if (front && !front.isClosed()) await this.closeFront(front, browser);
          if (browser && !this.views.size) {
            if (this.browser === browser) this.browser = null;
            await this.closeBrowser(browser);
          }
        }
        throw new Error(startup.signal.aborted ? 'Shared view startup was canceled or timed out' : 'Could not open the shared view; the headless page remains available');
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        record.controller.off('change', pageClosed);
      }
    });
  }
  async closeFront(front, browser) {
    const deadline = setTimeout(() => browser.process()?.kill('SIGKILL'), 1000);
    try { if (!front.isClosed()) await front.close(); }
    catch { browser.process()?.kill('SIGKILL'); }
    finally { clearTimeout(deadline); }
  }
  async closeBrowser(browser) {
    const deadline = setTimeout(() => browser.process()?.kill('SIGKILL'), 1000);
    try { await browser.close(); }
    catch { browser.process()?.kill('SIGKILL'); }
    finally { clearTimeout(deadline); }
  }
  async dispose(view) {
    if (this.views.get(view.record.id) !== view) return;
    this.views.delete(view.record.id);
    await view.bridge.close();
    await this.closeFront(view.front, view.browser);
    if (!this.views.size && this.browser === view.browser) {
      this.browser = null;
      await this.closeBrowser(view.browser);
    }
  }
  close(id) {
    if (!this.views.has(id)) return Promise.resolve();
    return this.serial(async () => {
      const view = this.views.get(id);
      if (view) await this.dispose(view);
    });
  }
}

function hasCanvas() {
  function find(root) {
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'CANVAS' && element.getBoundingClientRect().width) return true;
      if (element.shadowRoot && find(element.shadowRoot)) return true;
    }
    return false;
  }
  return find(document);
}

