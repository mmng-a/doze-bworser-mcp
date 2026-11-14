import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { isUserOnlyURL } from './privacy.cjs';

/** Carry CDP over inherited pipes; the browser never listens on a TCP port. */
class PipeTransport {
  constructor(child) {
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.output.setEncoding('utf8');
    let pending = '';
    this.output.on('data', chunk => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\0')) >= 0) {
        const message = pending.slice(0, end);
        pending = pending.slice(end + 1);
        this.onmessage?.(message);
      }
    });
    this.input.on('error', () => this.onclose?.());
    this.output.once('close', () => this.onclose?.());
  }
  send(message) { this.input.write(message + '\0'); }
  close() { this.input.end(); }
}

/** Own one project's Electron process and its private RPC and CDP pipes. */
export class ElectronEngine extends EventEmitter {
  static async launch(executable, profile, timeout, signal) {
    const engine = new ElectronEngine();
    try { await engine.start(executable, profile, timeout, signal); return engine; }
    catch (error) { await engine.close(); throw error; }
  }
  async start(executable, profile, timeout, signal) {
    this.timeout = timeout;
    this.entries = new Map();
    this.pending = new Map();
    this.sequence = 0;
    if (!profile) this.temporary = await mkdtemp(join(tmpdir(), 'doze-electron-'));
    const env = { ...process.env, DOZE_ELECTRON_PROFILE: profile ?? this.temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(executable, ['--remote-debugging-pipe', fileURLToPath(new URL('./electron-main.cjs', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    const ready = Promise.withResolvers();
    const fail = error => {
      ready.reject(error);
      for (const task of this.pending.values()) task.reject(error);
      this.pending.clear();
    };
    this.child.once('error', fail);
    this.child.stdin.on('error', fail);
    // Electron diagnostics can contain page URLs; do not copy arbitrary stderr into MCP replies.
    this.child.stderr.resume();
    this.child.once('exit', () => { fail(new Error('Browser disconnected; open a new page')); this.emit('disconnected'); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.ready) ready.resolve();
        else if (message.event === 'fatal') { fail(new Error(message.message)); this.child.kill('SIGKILL'); }
        else if (message.event) this.event(message);
        else if (message.id) {
          const task = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) task?.reject(new Error(message.error)); else task?.resolve(message.result);
        } else this.event(message);
      } catch { fail(new Error('Invalid Electron control response')); }
    });
    const abort = () => { this.child.kill('SIGKILL'); fail(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => { this.child.kill('SIGKILL'); fail(new Error('Electron startup timed out')); }, timeout);
    try {
      signal?.throwIfAborted();
      await ready.promise;
      this.browser = await puppeteer.connect({ transport: new PipeTransport(this.child), defaultViewport: null, protocolTimeout: 0 });
      this.session = await this.browser.target().createCDPSession();
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); }
  }
  event(message) {
    if (message.event === 'created') {
      const entry = Object.assign(new EventEmitter(), message.entry);
      this.entries.set(entry.id, entry);
      this.emit('created', entry);
    } else {
      const entry = this.entries.get(message.page);
      if (!entry) return;
      if (message.event === 'protected') {
        entry.userOnly = true;
        entry.emit('protected');
      } else if (message.event === 'dialog') {
        if (entry.userOnly) return;
        const dialog = {
          id: message.dialog, handled: false, type: () => message.type, message: () => message.message,
          defaultValue: () => message.defaultValue,
          accept: text => this.request('answer', { page: entry.id, dialog: message.dialog, accept: true, text }),
          dismiss: () => this.request('answer', { page: entry.id, dialog: message.dialog, accept: false }),
        };
        entry.dialog = dialog;
        entry.emit('dialog', dialog);
      } else if (message.event === 'answered' && entry.dialog?.id === message.dialog) {
        if (entry.dialog) entry.dialog.handled = true;
        entry.dialog = null;
        entry.emit('dialog-closed');
      } else if (message.event === 'closed') {
        this.entries.delete(entry.id);
        entry.emit('close');
      }
    }
  }
  request(action, args = {}, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.child || this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('Browser is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const abort = () => { this.pending.delete(id); cleanup(); reject(signal.reason); };
      const timer = action === 'navigate' ? null : setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error(`Browser control timed out: ${action}`)); }, this.timeout);
      this.pending.set(id, { resolve: result => { cleanup(); resolve(result); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, action, ...args }) + '\n');
    });
  }
  async page(entry) {
    const target = await this.browser.waitForTarget(async target => {
      if (target.type() !== 'page' || isUserOnlyURL(target.url())) return false;
      let session;
      try {
        session = await target.createCDPSession();
        return (await session.send('Target.getTargetInfo', {}, { timeout: this.timeout })).targetInfo.targetId === entry.targetId;
      } catch (error) {
        if (/No target with given id|Target closed|Session closed/.test(error.message)) return false;
        throw error;
      } finally { await session?.detach().catch(() => {}); }
    }, { timeout: this.timeout });
    const page = await target.page();
    // Electron owns dialog replies, including dialogs raised before Page initialization.
    page.on('dialog', () => {});
    page.setDefaultTimeout(0);
    page.setDefaultNavigationTimeout(0);
    await page.emulateFocusedPage(true);
    return page;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
        const exited = new Promise(resolve => this.child.once('exit', resolve));
        const deadline = setTimeout(() => this.child.kill('SIGKILL'), 3000);
        try { await this.request('quit'); await exited; } catch { this.child.kill('SIGKILL'); await exited; }
        finally { clearTimeout(deadline); }
      }
      this.browser?.disconnect();
      if (this.temporary) await rm(this.temporary, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
