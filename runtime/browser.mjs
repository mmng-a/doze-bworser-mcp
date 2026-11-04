import { randomUUID } from 'node:crypto';
import { PageController, PageClosed } from './controller.mjs';
import { inspect } from './snapshot.mjs';

/** Use Puppeteer's selection API for native options, preserving ordinary widget clicks. */
async function selectOption(handle) {
  const option = await handle.evaluate(element => {
    if (!(element instanceof HTMLOptionElement)) return null;
    const select = element.closest('select');
    if (!select || !element.isConnected) throw new Error('Option is stale; inspect the page again');
    if (select.disabled || element.matches(':disabled')) throw new Error('Option is disabled');
    if ([...select.options].filter(other => other.value === element.value).length !== 1) {
      throw new Error('Option value is ambiguous');
    }
    return { value: element.value };
  });
  if (!option) return false;
  const parent = await handle.evaluateHandle(element => element.closest('select'));
  try {
    const select = parent.asElement();
    if (!select) throw new Error('Option is stale; inspect the page again');
    const selected = await select.select(option.value);
    if (!selected.includes(option.value)) throw new Error('Option is stale; inspect the page again');
    return true;
  } finally {
    await parent.dispose();
  }
}


export function validateUrl(value) {
  const url = new URL(value);
  if (value !== 'about:blank' && !['http:', 'https:'].includes(url.protocol)) throw new Error('url must be HTTP(S) or about:blank');
  return value;
}

/** The sole owner of Chromium, contexts, pages, and operation controllers. */
export class BrowserManager {
  constructor(config, parents = new Map()) {
    this.config = config;
    this.parents = parents;
    this.pages = new Map();
    this.engines = new Map();
    this.locks = new Map();
    this.timeout = config.operation_timeout_seconds * 1000;
  }
  register(thread, parent) {
    if (typeof thread !== 'string' || !thread.length || thread.length > 200) throw new Error('Invalid thread identity');
    if (parent !== undefined && (typeof parent !== 'string' || !parent.length || parent.length > 200 || parent === thread)) throw new Error('Invalid parent identity');
    const existing = this.parents.get(thread);
    if (existing !== undefined && parent !== undefined && existing !== parent) throw new Error('Caller parent changed');
    if (parent !== undefined && existing !== parent) {
      let ancestor = parent;
      const seen = new Set([thread]);
      while (ancestor !== undefined) {
        if (seen.has(ancestor)) throw new Error('Invalid parent chain');
        seen.add(ancestor);
        ancestor = this.parents.get(ancestor);
      }
      if ([...this.pages.values()].some(p => this.root(p.owner) === thread)) throw new Error('Cannot change parent while pages are open');
      this.parents.set(thread, parent);
      this.saveParents?.();
    }
  }
  root(thread) {
    const seen = new Set();
    while (this.parents.has(thread)) {
      if (seen.has(thread)) throw new Error('Invalid parent chain');
      seen.add(thread);
      thread = this.parents.get(thread);
    }
    return thread;
  }
  async serial(mode, action) {
    const previous = this.locks.get(mode) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(mode, next);
    try { return await next; }
    finally { if (this.locks.get(mode) === next) this.locks.delete(mode); }
  }
  async open(caller, url, headed, signal) {
    validateUrl(url);
    const id = randomUUID();
    const root = this.root(caller.thread);
    if (!this.config.chrome_path) {
      signal?.throwIfAborted();
      this.chrome ??= import('./chrome.mjs').then(module => module.chromePath()).catch(error => { this.chrome = null; throw error; });
      let abort;
      try {
        const canceled = new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
        });
        this.config.chrome_path = await Promise.race([this.chrome, canceled]);
      } finally { signal?.removeEventListener('abort', abort); }
      signal?.throwIfAborted();
    }
    const queuedAt = Date.now();
    const record = await this.serial(headed, async () => {
      signal?.throwIfAborted();
      if (Date.now() - queuedAt >= this.timeout) throw new Error('Timed out waiting to open a page; request was not executed');
      let engine = this.engines.get(headed);
      if (!engine) {
        const { default: puppeteer } = await import('puppeteer-core');
        const startup = new AbortController();
        const abort = () => startup.abort(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const deadline = setTimeout(() => startup.abort(new Error('Browser startup timed out')), this.timeout);
        try {
          startup.signal.throwIfAborted();
          signal?.throwIfAborted();
          const browser = await puppeteer.launch({ executablePath: this.config.chrome_path, headless: !headed,
            pipe: true, timeout: 0, protocolTimeout: 0, signal: startup.signal,
            defaultViewport: { width: 1440, height: 900 }, waitForInitialPage: false, args: ['--no-startup-window'] });
          const session = await browser.target().createCDPSession();
          startup.signal.throwIfAborted();
          engine = { browser, session, groups: new Map() };
        } catch (error) {
          startup.abort(error);
          throw startup.signal.reason;
        } finally {
          clearTimeout(deadline);
          signal?.removeEventListener('abort', abort);
        }
        this.engines.set(headed, engine);
        engine.browser.on('disconnected', () => {
          if (this.engines.get(headed) === engine) this.engines.delete(headed);
          for (const p of this.pages.values()) if (p.engine === engine) {
            void p.controller.close(new PageClosed('Browser disconnected; page is closed. Open a new page'));
          }
        });
      }
      const creationDeadline = setTimeout(() => engine.browser.process()?.kill('SIGKILL'), this.timeout);
      let group = engine.groups.get(root);
      let page;
      const abortCreation = () => {
        if (page) void page.close().catch(() => engine.browser.process()?.kill('SIGKILL'));
        else engine.browser.process()?.kill('SIGKILL');
      };
      signal?.addEventListener('abort', abortCreation, { once: true });
      try {
        signal?.throwIfAborted();
        if (!group) {
          group = { context: await engine.browser.createBrowserContext(), pages: new Set() };
          engine.groups.set(root, group);
        }
        page = await group.context.newPage();
        signal?.throwIfAborted();
        await page.emulateFocusedPage(true);
        page.setDefaultTimeout(0);
        page.setDefaultNavigationTimeout(0);
        const session = await page.createCDPSession();
        let targetId;
        try { targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
        finally { await session.detach(); }
        signal?.throwIfAborted();
        if (this.root(caller.thread) !== root) throw new Error('Caller parent changed while opening page');
        const record = { id, owner: caller.thread, connection: caller.connection, root, headed, engine, group, targetId, page };
        record.controller = new PageController(page, () => this.dispose(record), this.timeout);
        group.pages.add(id);
        this.pages.set(id, record);
        page.once('close', () => { void record.controller.close(); });
        return record;
      } catch (error) {
        try {
          if (page && !page.isClosed()) await page.close();
          if (group?.pages.size === 0) { await group.context.close(); engine.groups.delete(root); }
          if (engine.groups.size === 0) await engine.browser.close();
        } catch { engine.browser.process()?.kill('SIGKILL'); }
        throw error;
      } finally { clearTimeout(creationDeadline); signal?.removeEventListener('abort', abortCreation); }
    });
    try {
      await record.controller.run(() => this.perform(record, 'navigate_page', { url }), signal);
      return { page_id: id };
    } catch (error) {
      if (signal?.aborted) await record.controller.close();
      // A dialog is an interruption with a usable page, not a failed creation.
      if (!record.controller.closed) error.message = `page_id: ${id}\n${error.message}`;
      throw error;
    }
  }
  get(caller, id) {
    const record = this.pages.get(id);
    if (!record || record.owner !== caller.thread) throw new PageClosed();
    return record;
  }
  async call(caller, name, args, signal) {
    signal?.throwIfAborted();
    if (name === 'open_page') return this.open(caller, args.url, args.headed ?? false, signal);
    if (name === 'list_pages') {
      const records = [...this.pages.values()].filter(p => p.owner === caller.thread && !p.controller.closed);
      const metadata = new Map();
      await Promise.all([...new Set(records.map(p => p.engine))].map(async engine => {
        const { targetInfos } = await engine.session.send('Target.getTargets', {}, { timeout: this.timeout });
        for (const info of targetInfos) metadata.set(info.targetId, info);
      }));
      signal?.throwIfAborted();
      return records.filter(p => metadata.has(p.targetId)).map(p => ({ page_id: p.id, url: metadata.get(p.targetId).url, title: metadata.get(p.targetId).title }));
    }
    const record = this.get(caller, args.page_id);
    if (name === 'close_page') return record.controller.close(undefined, signal);
    if (name === 'handle_dialog') return record.controller.handle(args.accept, signal);
    return record.controller.run(() => this.perform(record, name, args), signal);
  }
  async perform(record, name, args) {
    const { page, controller } = record;
    switch (name) {
      case 'navigate_page':
        validateUrl(args.url);
        controller.nodes.clear();
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 0 });
        break;
      case 'inspect_page': return inspect(controller);
      case 'click':
      case 'fill': {
        const node = controller.nodes.get(args.element);
        if (!node) throw new Error('Unknown element; inspect the page again');
        const handle = await node.elementHandle();
        if (!handle) throw new Error('Element is stale; inspect the page again');
        try {
          const locator = handle.asLocator().setTimeout(0);
          if (name === 'click') {
            if (node.role !== 'option' || !(await selectOption(handle))) await locator.click();
          } else await locator.fill(args.value);
        } finally { await handle.dispose(); }
        break;
      }
      case 'press_key': await page.keyboard.press(args.key); break;
      case 'scroll_page': await page.evaluate((x, y) => scrollTo(x, y), args.x ?? 0, args.y); break;
      case 'set_viewport': await page.setViewport({ width: args.width, height: args.height }); break;
      case 'take_screenshot': return { image: await page.screenshot({ type: 'png', encoding: 'base64', fullPage: args.full_page ?? false }) };
      case 'evaluate_script': return (await page.evaluate(args.expression)) ?? null;
      default: throw new Error('Unknown operation');
    }
    return 'OK';
  }
  async dispose(record) {
    return this.serial(record.headed, async () => {
      const { engine, group, page, id } = record;
      const timeout = setTimeout(() => engine.browser.process()?.kill('SIGKILL'), 3000);
      try {
        if (group.pages.size === 1) { await group.context.close(); engine.groups.delete(record.root); }
        else if (!page.isClosed()) await page.close();
      } catch (error) {
        engine.browser.process()?.kill('SIGKILL');
        throw error;
      } finally {
        group.pages.delete(id);
        this.pages.delete(id);
        record.controller.nodes.clear();
        if (engine.groups.size === 0) {
          try { await engine.browser.close(); }
          finally { if (this.engines.get(record.headed) === engine) this.engines.delete(record.headed); }
        }
        clearTimeout(timeout);
      }
    });
  }
  async closeWhere(predicate) {
    await Promise.all([...this.pages.values()].filter(predicate).map(p => p.controller.close()));
  }
  async expireIdle() {
    const cutoff = Date.now() - 30 * 60_000;
    await this.closeWhere(p => (!p.controller.active || p.controller.dialog) && p.controller.lastUsed < cutoff);
  }
}
