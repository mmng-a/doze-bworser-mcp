const { session } = require('electron');
const { join } = require('node:path');
const { access, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installExtension, updateExtensions } = require('electron-chrome-web-store');

const extensionId = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';

/** Own 1Password's persistent installation and extension actions; website tabs remain owned by doze. */
class OnePassword {
  constructor(browserSession, profile, callbacks, changed) {
    this.session = browserSession;
    this.extensionsPath = join(profile, 'Extensions');
    this.policyPath = join(profile, 'one-password-enabled');
    this.enabled = existsSync(this.policyPath) || existsSync(join(this.extensionsPath, extensionId));
    this.changed = changed;
    this.host = new ElectronChromeExtensions({ session: browserSession, ...callbacks });
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession);
    this.host.on('browser-action-popup-created', popup => {
      const parent = popup.parent;
      const hide = () => popup.destroy();
      parent.on('hide', hide);
      popup.browserWindow.once('closed', () => parent.off('hide', hide));
    });
    for (const type of ['frame', 'service-worker']) browserSession.registerPreloadScript({
      id: `doze-extension-browser-${type}`, type, filePath: join(__dirname, 'extension-browser-preload.cjs'),
    });
  }
  get state() {
    return { installed: !!this.session.extensions.getExtension(extensionId), busy: !!this.pending, error: this.error || '' };
  }
  async enable() {
    await writeFile(this.policyPath, '', { mode: 0o600 });
    this.enabled = true;
  }
  async loadInstalled() {
    try { await access(join(this.extensionsPath, extensionId)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await this.install();
  }
  async install(update = false) {
    if (this.pending) return this.pending;
    this.error = '';
    this.pending = (async () => {
      await installExtension(extensionId, { session: this.session, extensionsPath: this.extensionsPath });
      if (update) await updateExtensions(this.session);
    })();
    this.changed();
    try { await this.pending; }
    catch (error) { this.error = error.message; throw error; }
    finally { this.pending = null; this.changed(); }
  }
}
module.exports = { OnePassword, extensionId };
