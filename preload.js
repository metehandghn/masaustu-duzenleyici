// Arayüze yalnızca bu güvenli fonksiyonlar açılır.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDesktop: () => ipcRenderer.invoke('get-desktop'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  scan: (dir) => ipcRenderer.invoke('scan', dir),
  scanFolders: (dir) => ipcRenderer.invoke('scan-folders', dir),
  findDuplicates: (dir) => ipcRenderer.invoke('find-duplicates', dir),
  apply: (dir, groups) => ipcRenderer.invoke('apply', { dir, groups }),
  undo: () => ipcRenderer.invoke('undo'),
  listHistory: () => ipcRenderer.invoke('list-history'),
  undoSelected: (picks) => ipcRenderer.invoke('undo-selected', picks),
  historyCount: () => ipcRenderer.invoke('history-count'),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  getRules: () => ipcRenderer.invoke('get-rules'),
  saveRules: (rules) => ipcRenderer.invoke('save-rules', rules),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  onRescan: (cb) => ipcRenderer.on('rescan', () => cb()),
  onDesktopChanged: (cb) => ipcRenderer.on('desktop-changed', (_e, n) => cb(n)),
  arrangeDesktop: (mode, auto) => ipcRenderer.invoke('arrange-desktop', { mode, auto }),
});
