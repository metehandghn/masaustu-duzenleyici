// Arayüze yalnızca bu güvenli fonksiyonlar açılır.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDesktop: () => ipcRenderer.invoke('get-desktop'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  scan: (dir) => ipcRenderer.invoke('scan', dir),
  scanFolders: (dir) => ipcRenderer.invoke('scan-folders', dir),
  apply: (dir, groups) => ipcRenderer.invoke('apply', { dir, groups }),
  undo: () => ipcRenderer.invoke('undo'),
  listHistory: () => ipcRenderer.invoke('list-history'),
  undoSelected: (picks) => ipcRenderer.invoke('undo-selected', picks),
  historyCount: () => ipcRenderer.invoke('history-count'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
});
