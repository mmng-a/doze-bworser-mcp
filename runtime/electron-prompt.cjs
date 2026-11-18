const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Electron replaces prompt with an exception. Keep Chromium's synchronous semantics
// in the same frame, rather than recreating dialogs with synchronous IPC.
contextBridge.exposeInIsolatedWorld(1001, 'dozePromptBridge', {
  publish(nativePrompt) {
    contextBridge.exposeInMainWorld('__dozeNativePrompt', nativePrompt);
    contextBridge.executeInMainWorld({ func: () => { window.prompt = window.__dozeNativePrompt; } });
  },
});
webFrame.executeJavaScriptInIsolatedWorld(1001, [{ code: 'dozePromptBridge.publish(window.prompt)' }]).catch(error => {
  console.error('Cannot restore native prompt:', error.message);
});

if (process.isMainFrame) {
  const reportScroll = () => ipcRenderer.send('doze-annotation-scroll', window.scrollX, window.scrollY);
  ipcRenderer.on('doze-watch-annotation-scroll', (_event, watch) => {
    if (watch) window.addEventListener('scroll', reportScroll, { passive: true });
    else window.removeEventListener('scroll', reportScroll);
  });
}
