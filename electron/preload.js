const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tftApi', {
  getUnitCatalog: () => ipcRenderer.invoke('tft:get-unit-catalog'),
  queryExplorer: (filters) => ipcRenderer.invoke('tft:query-explorer', filters),
  openSource: () => ipcRenderer.invoke('tft:open-source'),
  openReleases: () => ipcRenderer.invoke('tft:open-releases'),
  getAppInfo: () => ipcRenderer.invoke('tft:get-app-info'),
  getUpdateStatus: () => ipcRenderer.invoke('tft:get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('tft:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('tft:download-update'),
  installUpdate: () => ipcRenderer.invoke('tft:install-update'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('tft:update-status', listener);
    return () => ipcRenderer.removeListener('tft:update-status', listener);
  },
});
