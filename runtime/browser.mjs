import { randomUUID } from 'node:crypto';
import { PageController, PageClosed } from './controller.mjs';
import { inspect } from './snapshot.mjs';
import { workspaceKey, prepareProfile, GitRootMismatch } from './profiles.mjs';
import { ElectronEngine } from './electron-engine.mjs';
import { join } from 'node:path';

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
  constructor(config, parents = new Map(), profilesDirectory) {
    this.config = config;
    this.parents = parents;
    this.profilesDirectory = profilesDirectory;
    this.pages = new Map();
    this.engines = new Map();
    this.locks = new Map();
    this.timeout = config.operation_timeout_seconds * 1000;
    this.opening = new Map();
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
  async serial(key, action) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(key, next);
    try { return await next; }
    finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async open(caller, url, headed, signal) {
    validateUrl(url);
    const id = randomUUID();
    if (caller.codex && !caller.cwd) throw new Error('Codex did not provide sandboxCwd. Update Codex and reconnect the MCP server before opening a page');
    const threadRoot = this.root(caller.thread);
    let project;
    let temporaryFolder;
    let warning;
    try { project = await workspaceKey(caller.cwd, { signal, timeout: this.timeout }); }
    catch (error) {
      if (!(error instanceof GitRootMismatch)) throw error;
      temporaryFolder = error.folder;
      warning = '警告: Git情報に不整合があるため、保存済みのログイン状態を使わず、一時環境で開きました。この環境でのログイン状態は、すべてのタブを閉じると失われます。';
    }
    // An uncertain folder must not reuse another temporary folder's login state.
    const root = project ?? JSON.stringify([threadRoot, temporaryFolder ?? null]);
    const key = project ? `project:${project}` : 'temporary';
    if (!this.config.electron_path) {
      this.download ??= import('./electron.mjs').then(module => module.electronPath()).catch(error => { this.download = null; throw error; });
      let abort;
      try {
        this.config.electron_path = await Promise.race([this.download, new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
        })]);
      } finally { signal?.removeEventListener('abort', abort); }
      signal?.throwIfAborted();
    }
    const queuedAt = Date.now();
    const record = await this.serial(key, async () => {
      signal?.throwIfAborted();
      if (Date.now() - queuedAt >= this.timeout) throw new Error('Timed out waiting to open a page; request was not executed');
      let engine = this.engines.get(key);
      if (!engine) {
        const profile = project ? await prepareProfile(join(this.profilesDirectory, 'electron'), project) : undefined;
        engine = await ElectronEngine.launch(this.config.electron_path, profile, this.timeout, signal);
        engine.groups = new Map();
        this.engines.set(key, engine);
        engine.on('created', entry => {
          const parent = this.pages.get(entry.opener);
          const owner = this.opening.get(entry.id) ?? parent;
          if (!owner) return;
          this.addRecord(entry, engine, owner);
        });
        engine.on('disconnected', () => {
          if (this.engines.get(key) === engine) this.engines.delete(key);
          for (const record of this.pages.values()) if (record.engine === engine) {
            void record.controller.close(new PageClosed('Browser disconnected; open a new page'));
          }
        });
      }
      let group = engine.groups.get(root);
      if (!group) { group = { pages: new Set(), partition: project ? 'persist:project' : 'temporary:' + randomUUID() }; engine.groups.set(root, group); }
      this.opening.set(id, { id, owner: caller.thread, connection: caller.connection, root, key, group });
      try {
        await engine.request('open', { page: id, partition: group.partition }, signal);
        signal?.throwIfAborted();
        if (!project && this.root(caller.thread) !== threadRoot) throw new Error('Caller parent changed while opening page');
        return this.pages.get(id);
      } catch (error) {
        await engine.request('close', { page: id }).catch(() => {});
        const record = this.pages.get(id);
        // The enclosing creation lock owns cleanup until creation finishes.
        if (record) { this.pages.delete(id); group.pages.delete(id); record.controller.closed = error; }
        if (!group.pages.size) engine.groups.delete(root);
        if (!engine.groups.size) { this.engines.delete(key); await engine.close(); }
        throw error;
      } finally { this.opening.delete(id); }
    });
    try {
      if (headed) await record.engine.request('show', { page: id });
      await record.controller.run(() => this.perform(record, 'navigate_page', { url }), signal);
      return { page_id: id, ...(warning ? { warning } : {}) };
    } catch (error) {
      if (signal?.aborted) await record.controller.close();
      if (!record.controller.closed) error.message = `page_id: ${id}\n${warning ? warning + '\n' : ''}${error.message}`;
      throw error;
    }
  }
  addRecord(entry, engine, owner) {
    const record = { id: entry.id, owner: owner.owner, connection: owner.connection, root: owner.root, key: owner.key,
      group: owner.group, engine, entry, targetId: entry.targetId };
    record.controller = new PageController(entry, () => this.dispose(record), this.timeout);
    entry.on('dialog-closed', () => record.controller.syncDialog());
    entry.once('close', () => { void record.controller.close(); });
    record.group.pages.add(record.id);
    this.pages.set(record.id, record);
    record.ready = engine.page(entry).then(page => { record.page = page; record.controller.page = page; return page; });
    record.ready.catch(() => {});
    return record;
  }
  get(caller, id) {
    const record = this.pages.get(id);
    if (!record || record.owner !== caller.thread || record.controller.closed) throw new PageClosed();
    return record;
  }
  async call(caller, name, args, signal) {
    signal?.throwIfAborted();
    if (name === 'open_page') return this.open(caller, args.url, args.headed ?? false, signal);
    if (name === 'list_pages') {
      const records = [...this.pages.values()].filter(p => p.owner === caller.thread && !p.controller.closed);
      const metadata = new Map();
      await Promise.all([...new Set(records.map(p => p.engine))].map(async engine => {
        for (const page of await engine.request('list')) metadata.set(page.id, page);
      }));
      signal?.throwIfAborted();
      return records.filter(p => metadata.has(p.id)).map(p => ({ page_id: p.id, url: metadata.get(p.id).url, title: metadata.get(p.id).title }));
    }
    const record = this.get(caller, args.page_id);
    if (name === 'show_page') {
      await record.engine.request('show', { page: record.id });
      return 'OK';
    }
    if (name === 'close_page') return record.controller.close(undefined, signal);
    if (name === 'handle_dialog') return record.controller.handle(args.accept, signal, args.prompt_text);
    return record.controller.run(() => this.perform(record, name, args), signal);
  }
  async perform(record, name, args) {
    const page = await record.ready;
    const { controller } = record;
    switch (name) {
      case 'navigate_page':
        validateUrl(args.url);
        controller.nodes.clear();
        await record.engine.request('navigate', { page: record.id, url: args.url });
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
      case 'take_screenshot': {
        const viewport = page.viewport();
        // Hidden Linux views need explicit device metrics to produce a capture frame.
        if (!viewport) await page.setViewport(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })));
        try { return { image: await page.screenshot({ type: 'png', encoding: 'base64', fullPage: args.full_page ?? false }) }; }
        finally { if (!viewport && !page.isClosed()) await page.setViewport(null); }
      }
      case 'evaluate_script': return (await page.evaluate(args.expression)) ?? null;
      default: throw new Error('Unknown operation');
    }
    return 'OK';
  }
  async dispose(record) {
    await Promise.all([...this.pages.values()].filter(p => p.entry.opener === record.id).map(p => p.controller.close()));
    return this.serial(record.key, async () => {
      const { engine, group, id } = record;
      try {
        if (engine.entries.has(id)) await engine.request('close', { page: id });
      } finally {
        group.pages.delete(id);
        this.pages.delete(id);
        record.controller.nodes.clear();
        if (!group.pages.size) engine.groups.delete(record.root);
        if (!engine.groups.size) { if (this.engines.get(record.key) === engine) this.engines.delete(record.key); await engine.close(); }
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
