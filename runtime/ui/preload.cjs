const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('doze', {
  act: (action, args) => ipcRenderer.invoke('doze-ui', action, args),
  focusURL: callback => ipcRenderer.on('doze-focus-url', callback),
  saveAnnotation: callback => ipcRenderer.on('doze-save-annotation', callback),
  adjustError: callback => ipcRenderer.on('doze-adjust-error', (_event, message) => callback(message)),
  subscribe: callback => ipcRenderer.on('doze-state', (_event, state) => callback(state)),
});
