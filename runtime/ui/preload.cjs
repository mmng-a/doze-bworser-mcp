const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('doze', {
  act: (action, args) => ipcRenderer.invoke('doze-ui', action, args),
  focusURL: callback => ipcRenderer.on('doze-focus-url', callback),
  saveAnnotation: callback => ipcRenderer.on('doze-save-annotation', callback),
  subscribe: callback => ipcRenderer.on('doze-state', (_event, state) => callback(state)),
});
