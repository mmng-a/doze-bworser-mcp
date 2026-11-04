import puppeteer, { TimeoutError } from 'puppeteer-core';
import { createInterface } from 'node:readline';
import { inspect } from './snapshot.mjs';

let browser;
let browserSession;
const lifetime = new AbortController();
let nextPage = 1;
const contexts = new Map();
const pages = new Map();

class PendingDialog extends Error {
  constructor(dialog) {
    super(`JavaScript dialog (${dialog.type()}): ${dialog.message()}. Use handle_dialog; do not repeat the original operation`);
  }
}

async function withDialog(record, action) {
  if (record.dialog?.handled) record.dialog = null;
  if (record.dialog) throw new PendingDialog(record.dialog);
  let rejectDialog;
  try {
    return await Promise.race([
      new Promise((_, reject) => { rejectDialog = reject; record.waiters.add(reject); }),
      action(),
    ]);
  } finally {
    record.waiters.delete(rejectDialog);
  }
}

async function closePage(id) {
  const record = pages.get(id);
  if (!record) return 'OK';
  const group = contexts.get(record.root);
  if (group.pages.size === 1) {
    await group.context.close();
    contexts.delete(record.root);
  } else if (!record.page.isClosed()) {
    await record.page.close();
  }
  group.pages.delete(id);
  pages.delete(id);
  return 'OK';
}

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

async function request(name, args) {
  if (name === 'init') {
    browser = await puppeteer.launch({
      executablePath: args.chrome,
      signal: lifetime.signal,
      timeout: 15_000,
      headless: !args.headed,
      defaultViewport: { width: 1440, height: 900 },
      waitForInitialPage: false,
      // Do not open Chromium's startup window in the foreground.
      args: ['--no-startup-window'],
    });
    browser.on('disconnected', () => process.exit(1));
    browserSession = await browser.target().createCDPSession();
    return 'OK';
  }
  if (name === 'new_page') {
    let group = contexts.get(args.root);
    if (!group) {
      group = { context: await browser.createBrowserContext(), pages: new Set() };
      contexts.set(args.root, group);
    }
    let page;
    try {
      page = await group.context.newPage();
      // Background pages must keep animation frames running for locator readiness.
      await page.emulateFocusedPage(true);
      const session = await page.createCDPSession();
      let targetId;
      try {
        targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
      } finally {
        await session.detach();
      }
      const id = nextPage++;
      const record = { page, targetId, root: args.root, dialog: null, waiters: new Set(), nodes: new Map(), dismissDialogs: false };
      page.on('dialog', dialog => {
        if (record.dismissDialogs) {
          void dialog.dismiss().catch(() => {});
          return;
        }
        record.dialog = dialog;
        for (const reject of record.waiters) reject(new PendingDialog(dialog));
      });
      group.pages.add(id);
      pages.set(id, record);
      return id;
    } catch (error) {
      try {
        if (group.pages.size === 0) {
          await group.context.close();
          contexts.delete(args.root);
        } else if (page && !page.isClosed()) {
          await page.close();
        }
      } catch {
        lifetime.abort();
      }
      throw error;
    }
  }
  if (name === 'list_pages') {
    for (const [id, record] of pages) {
      if (record.page.isClosed()) await closePage(id);
    }
    // Browser metadata remains available when a renderer's JavaScript is blocked.
    const { targetInfos } = await browserSession.send('Target.getTargets');
    const targets = new Map(targetInfos.map(info => [info.targetId, info]));
    return [...pages].filter(([, record]) => targets.has(record.targetId)).map(([id, record]) => {
      const info = targets.get(record.targetId);
      return { id, url: info.url, title: info.title };
    });
  }
  if (name === 'close_page') return await closePage(args.page_id);

  const record = pages.get(args.page_id);
  if (!record || record.page.isClosed()) throw new Error('Page is closed; open a new page with open_page');
  if (record.dialog?.handled) record.dialog = null;
  if (record.dialog && name !== 'handle_dialog') throw new PendingDialog(record.dialog);
  const { page } = record;
  page.setDefaultTimeout(args.timeout);
  const action = async () => {
    switch (name) {
      case 'navigate_page':
        record.nodes.clear();
        await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
        break;
      case 'inspect_page':
        return await inspect(record);
      case 'click':
      case 'fill': {
        const node = record.nodes.get(args.element);
        if (!node) throw new Error('Unknown element; inspect the page again');
        const handle = await node.elementHandle();
        if (!handle) throw new Error('Element is stale; inspect the page again');
        try {
          const locator = handle.asLocator().setTimeout(args.timeout);
          if (name === 'click') {
            if (node.role !== 'option' || !(await selectOption(handle))) await locator.click();
          } else await locator.fill(args.value);
        } finally {
          await handle.dispose();
        }
        break;
      }
      case 'press_key':
        await page.keyboard.press(args.key);
        break;
      case 'scroll_page':
        await page.evaluate((x, y) => scrollTo(x, y), args.x ?? 0, args.y);
        break;
      case 'set_viewport':
        await page.setViewport({ width: args.width, height: args.height });
        break;
      case 'take_screenshot':
        return { image: await page.screenshot({ type: 'png', encoding: 'base64', fullPage: args.full_page ?? false }) };
      case 'evaluate_script':
        record.dismissDialogs = true;
        try {
          return (await page.evaluate(args.expression)) ?? null;
        } finally {
          record.dismissDialogs = false;
        }
      case 'handle_dialog': {
        const dialog = record.dialog;
        if (!dialog) throw new Error('No JavaScript dialog is open on this page');
        record.dialog = null;
        try {
          if (args.accept) await dialog.accept();
          else await dialog.dismiss();
        } catch (error) {
          if (!dialog.handled && !record.dialog) record.dialog = dialog;
          throw error;
        }
        break;
      }
      default:
        throw new Error('Unknown browser operation');
    }
    return 'OK';
  };
  if (name === 'handle_dialog') return await action();
  return await withDialog(record, action);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => lifetime.abort(), 3000);
  try {
    if (browser) {
      browser.removeAllListeners('disconnected');
      await browser.close();
    }
  } finally {
    clearTimeout(deadline);
    // Puppeteer's launcher also kills the owned process group and removes its profile.
    lifetime.abort();
    process.exit(0);
  }
}

// Requests may finish out of order; Rust serializes only operations on one page.
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  void (async () => {
    const { id, name, args } = JSON.parse(line);
    try {
      const result = await request(name, args);
      process.stdout.write(JSON.stringify({ id, result }) + '\n');
    } catch (error) {
      const kind = error instanceof PendingDialog ? 'dialog' : error instanceof TimeoutError ? 'timeout' : 'error';
      process.stdout.write(JSON.stringify({ id, error: String(error.message), kind }) + '\n');
    }
  })().catch(error => { console.error(error); void stop(); });
});
input.on('close', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
