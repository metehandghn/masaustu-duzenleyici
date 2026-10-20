const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const ops = require('./fileops');

let win;
const historyPath = () => path.join(app.getPath('userData'), 'history.json');

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: 'Masaüstü Düzenleyici',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: '#f4f5f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile('index.html');
}

ipcMain.handle('get-desktop', () => app.getPath('desktop'));

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Düzenlenecek klasörü seç', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan', (_e, dir) => ops.scan(dir));
ipcMain.handle('scan-folders', (_e, dir) => ops.scanFolders(dir));
ipcMain.handle('apply', (_e, { dir, groups }) => ops.apply(dir, groups, historyPath()));
ipcMain.handle('undo', () => ops.undo(historyPath()));
ipcMain.handle('list-history', () => ops.listHistory(historyPath()));
ipcMain.handle('undo-selected', (_e, picks) => ops.undoSelected(historyPath(), picks));
ipcMain.handle('history-count', () => ops.historyCount(historyPath()));
ipcMain.handle('open-folder', (_e, p) => shell.openPath(p));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
