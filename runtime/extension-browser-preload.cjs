const { contextBridge } = require('electron');

// Electron's browser namespace does not include the APIs added to chrome by the library.
if (process.type === 'service-worker' || location.protocol === 'chrome-extension:') {
  contextBridge.executeInMainWorld({ func: () => {
    if (globalThis.chrome?.runtime?.id) {
      Object.defineProperty(globalThis, 'browser', { value: globalThis.chrome, configurable: true });
    }
  } });
}
