const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flightdeskDesktop', {
  settingsStatus: () => ipcRenderer.invoke('settings:status'),
  saveSettings: values => ipcRenderer.invoke('settings:save', values),
  clearSettings: () => ipcRenderer.invoke('settings:clear')
});
