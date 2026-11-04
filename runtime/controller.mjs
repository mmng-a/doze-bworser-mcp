import { EventEmitter } from 'node:events';

export class PendingDialog extends Error {
  constructor(dialog) {
    super(`JavaScript dialog (${dialog.type()}): ${dialog.message()}. Use handle_dialog; do not repeat the original operation`);
  }
}
export class PageClosed extends Error {
  constructor(reason = 'Page is closed; open a new page with open_page') { super(reason); }
}

/** Own an operation until it settles, even if its MCP response reports a dialog. */
export class PageController extends EventEmitter {
  constructor(page, dispose, timeout = 20_000) {
    super();
    Object.assign(this, { page, dispose, timeout, nodes: new Map(), dialog: null, active: null,
      tail: Promise.resolve(), controls: Promise.resolve(), closed: null, lastUsed: Date.now() });
    page.on('dialog', dialog => {
      this.dialog = dialog;
      clearInterval(this.dialogWatch);
      // Puppeteer exposes handled state but no public dialog-closed event.
      this.dialogWatch = setInterval(() => this.syncDialog(), 250);
      this.dialogWatch.unref();
      if (this.active) this.pause(this.active);
      this.emit('change');
    });
  }
  syncDialog() {
    if (!this.dialog?.handled || this.responding === this.dialog) return;
    this.dialog = null;
    clearInterval(this.dialogWatch);
    if (this.active) { this.resume(this.active); this.finish(this.active); }
    this.emit('change');
  }
  check(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw this.closed;
  }
  pause(active) {
    clearTimeout(active.timer);
    if (active.started) active.remaining -= Date.now() - active.started;
    active.started = 0;
  }
  resume(active) {
    if (active.settled || this.dialog || this.closed) return;
    active.started = Date.now();
    active.timer = setTimeout(() => {
      void this.close(new PageClosed('Operation timed out; outcome may be unknown. Page closed; open a new page'));
    }, Math.max(1, active.remaining));
  }
  finish(active) {
    if (this.dialog?.handled && this.responding !== this.dialog) { this.dialog = null; clearInterval(this.dialogWatch); }
    if (!active.settled || this.dialog) return;
    this.pause(active);
    active.signal?.removeEventListener('abort', active.abort);
    if (this.active === active) this.active = null;
    this.lastUsed = Date.now();
    active.slot.resolve();
  }
  async changed(signal, milliseconds) {
    this.check(signal);
    await new Promise((resolve, reject) => {
      let timer;
      const clean = () => { clearTimeout(timer); this.off('change', change); signal?.removeEventListener('abort', abort); };
      const change = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      this.once('change', change);
      signal?.addEventListener('abort', abort, { once: true });
      if (milliseconds !== undefined) timer = setTimeout(() => { clean(); reject(new Error('Timed out waiting for this page; request was not executed')); }, Math.max(1, milliseconds));
    });
  }
  async outcome(active, signal) {
    for (;;) {
      this.check(signal);
      this.syncDialog();
      if (this.dialog) throw new PendingDialog(this.dialog);
      if (active.settled) {
        if (active.error) throw active.error;
        return active.value;
      }
      await this.changed(signal);
    }
  }
  async run(action, signal) {
    this.check(signal);
    this.syncDialog();
    if (this.dialog) throw new PendingDialog(this.dialog);
    const previous = this.tail;
    const slot = Promise.withResolvers();
    this.tail = previous.then(() => slot.promise);
    let ready = false;
    previous.then(() => { ready = true; this.emit('change'); });
    let active;
    try {
      const deadline = Date.now() + this.timeout;
      while (!ready) {
        this.check(signal);
        if (this.dialog) throw new PendingDialog(this.dialog);
        await this.changed(signal, deadline - Date.now());
      }
      this.check(signal);
      if (this.dialog) throw new PendingDialog(this.dialog);
      this.lastUsed = Date.now();
      active = { slot, signal, remaining: this.timeout, settled: false };
      this.active = active;
      active.abort = () => { void this.close(new PageClosed('Operation canceled; outcome may be unknown. Page closed; open a new page')); };
      signal?.addEventListener('abort', active.abort, { once: true });
      this.resume(active);
      // The action is invoked only after the queue and cancellation checks above.
      Promise.resolve().then(() => { this.check(signal); return action(); }).then(
        value => { active.value = value; }, error => { active.error = error; },
      ).finally(() => {
        active.settled = true;
        this.finish(active);
        this.emit('change');
      });
      return await this.outcome(active, signal);
    } finally {
      if (!active) slot.resolve();
    }
  }
  control(action, signal) {
    const result = this.controls.then(() => { this.check(signal); return action(); });
    this.controls = result.catch(() => {});
    return result;
  }
  handle(accept, signal) {
    return this.control(async () => {
      const dialog = this.dialog;
      if (!dialog || dialog.handled) throw new Error('No JavaScript dialog is open on this page');
      const active = this.active;
      this.responding = dialog;
      const abort = () => { void this.close(new PageClosed('Dialog response canceled; outcome may be unknown. Page closed; open a new page')); };
      signal?.addEventListener('abort', abort, { once: true });
      const deadline = setTimeout(() => { void this.close(new PageClosed('Dialog response timed out; page closed. Open a new page')); }, this.timeout);
      try {
        await (accept ? dialog.accept() : dialog.dismiss());
        if (this.dialog === dialog) { this.dialog = null; clearInterval(this.dialogWatch); }
        this.lastUsed = Date.now();
        if (active) {
          this.resume(active);
          this.finish(active);
        }
        this.emit('change');
        if (active) await this.outcome(active, signal);
        return 'OK';
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abort);
        if (this.responding === dialog) this.responding = null;
        this.syncDialog();
      }
    }, signal);
  }
  close(reason = new PageClosed(), signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closing) return this.closing;
    this.closed = reason;
    clearInterval(this.dialogWatch);
    if (this.active) {
      this.pause(this.active);
      this.active.signal?.removeEventListener('abort', this.active.abort);
    }
    this.emit('change');
    this.closing = Promise.resolve().then(() => this.dispose()).then(() => 'OK');
    // Timeout/cancellation cleanup has no awaiting MCP handler.
    this.closing.catch(error => console.error('Page cleanup failed:', error.message));
    return this.closing;
  }
}
