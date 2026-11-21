const { session } = require('electron');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { access, writeFile } = require('node:fs/promises');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { downloadExtension, installExtension, updateExtensions } = require('electron-chrome-web-store');

const extensionId = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa';

/** Own 1Password's persistent installation and extension actions; website tabs remain owned by doze. */
class OnePassword {
  constructor(browserSession, profile, callbacks, changed) {
    this.session = browserSession;
    this.extensionsPath = join(profile, 'Extensions');
    // Profiles that already used the manual installer have this marker.
    this.setupPath = join(profile, 'one-password-enabled');
    this.needsSetup = !existsSync(this.setupPath) || !existsSync(join(this.extensionsPath, extensionId));
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
    return { installed: !!this.session.extensions.getExtension(extensionId), needsSetup: this.needsSetup, busy: !!this.pending, error: this.error || '' };
  }
  async showSetup(open) {
    if (!this.needsSetup) return;
    this.needsSetup = false;
    try {
      await open();
      await writeFile(this.setupPath, '', { mode: 0o600 });
    } catch (error) {
      this.needsSetup = true;
      throw error;
    } finally {
      this.changed();
    }
  }
  async loadInstalled(activate) {
    try { await access(join(this.extensionsPath, extensionId)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A fresh download should not keep the browser from opening offline.
      void downloadExtension(extensionId, this.extensionsPath)
        .then(activate)
        .catch(error => { this.error = error.message; this.changed(); });
      return;
    }
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
