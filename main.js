const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const ops = require('./fileops');
const Grouping = require('./grouping');
const { arrangeDesktop, refreshShell } = require('./desktop-arrange');

const APP_ID = 'com.metehan.masaustuduzenleyici';
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;

const userFile = (name) => path.join(app.getPath('userData'), name);
const historyPath = () => userFile('history.json');
const rulesPath = () => userFile('rules.json');
const settingsPath = () => userFile('settings.json');

// ---------- Ayarlar ----------
// notifyNew: kurala uymayan her yeni dosya için bildirim (varsayılan kapalı).
// Otomatik taşıma bildirimi her zaman gelir.
const DEFAULT_SETTINGS = { background: true, startWithWindows: false, notifyNew: false, theme: 'system', hideNoticeDone: false };
const THEMES = new Set(['system', 'light', 'dark']);
const bgColor = () => (nativeTheme.shouldUseDarkColors ? '#16181d' : '#f4f5f8');

// Tema: 'system' Windows'u takip eder; 'light' / 'dark' sabitler. Arayüzdeki
// prefers-color-scheme buna göre değişir, CSS ayrıca bir şey yapmaz.
function applyTheme() {
  nativeTheme.themeSource = THEMES.has(settings.theme) ? settings.theme : 'system';
  if (win) win.setBackgroundColor(bgColor());
}
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; }
  catch { settings = { ...DEFAULT_SETTINGS }; }
  applyTheme();
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch { /* yoksay */ }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: ['--hidden'] });
  }
  buildTrayMenu();
  if (win) win.webContents.send('settings-changed', settings);
}

async function readRules() {
  try {
    const r = JSON.parse(await fsp.readFile(rulesPath(), 'utf8'));
    return { autoApply: !!r.autoApply, folders: Array.isArray(r.folders) ? r.folders : [] };
  } catch { return { autoApply: false, folders: [] }; }
}

// ---------- Pencere ----------
function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Masaüstü Düzenleyici',
    icon: path.join(__dirname, 'icon.ico'),
    backgroundColor: bgColor(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile('index.html');
  if (show) win.once('ready-to-show', () => win.show());

  // Kapat'a basınca: arka planda çalışma açıksa tepsiye gizle
  win.on('close', (e) => {
    if (quitting || !settings.background) return;
    e.preventDefault();
    win.hide();
    if (!settings.hideNoticeDone) { // sadece ilk seferde
      settings.hideNoticeDone = true;
      saveSettings();
      notify('Arka planda çalışmaya devam ediyor',
        'Masaüstüne yeni dosya gelince haber vereceğim. Tamamen kapatmak için saatin yanındaki simgeye sağ tıkla → Çıkış.');
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// ---------- Bildirim ----------
function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, 'icon.ico'), silent: false });
  n.on('click', () => { showWindow(); if (onClick) onClick(); });
  n.show();
}

// ---------- Sistem tepsisi ----------
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Masaüstü Düzenleyici\'yi aç', click: showWindow },
    { label: 'Şimdi tara', click: () => { showWindow(); win && win.webContents.send('rescan'); } },
    { type: 'separator' },
    { label: 'Arka planda çalış', type: 'checkbox', checked: settings.background,
      click: (i) => { settings.background = i.checked; saveSettings(); restartWatcher(); } },
    { label: 'Her yeni dosya için bildirim', type: 'checkbox', checked: settings.notifyNew, enabled: settings.background,
      click: (i) => { settings.notifyNew = i.checked; saveSettings(); } },
    { label: 'Windows açılınca başlat', type: 'checkbox', checked: settings.startWithWindows, enabled: app.isPackaged,
      click: (i) => { settings.startWithWindows = i.checked; saveSettings(); } },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'icon.ico')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Masaüstü Düzenleyici');
  tray.on('click', showWindow);
  buildTrayMenu();
}

// ---------- Masaüstünü izleme ----------
// Yeni dosya gelince: kural varsa ve "otomatik uygula" açıksa taşır, yoksa bildirim gösterir.
let watcher = null;
let known = new Set();
let debounce = null;
let quietUntil = 0; // kendi taşımalarımız bildirim üretmesin
const notified = new Set(); // aynı dosya için tekrar bildirim gösterme
let retryTimer = null;

async function snapshot() {
  try { known = new Set((await ops.scan(app.getPath('desktop'))).map(f => f.name)); } catch { known = new Set(); }
}

async function onDesktopChange() {
  const desktop = app.getPath('desktop');
  let files;
  try { files = await ops.scan(desktop); } catch { return; }
  const fresh = files.filter(f => !known.has(f.name));
  known = new Set(files.map(f => f.name));
  if (Date.now() < quietUntil || !fresh.length) return;

  // Arayüz açıksa haber ver (kullanıcı "Yeniden tara" diyebilsin)
  if (win) win.webContents.send('desktop-changed', fresh.length);

  // Kurallar otomatikse yeni dosyalara uygula — ama sadece "hazır" olanlara.
  // Yeni oluşturulmuş / hâlâ kopyalanan / Word'de açık dosyalar sonra tekrar denenir.
  const rules = await readRules();
  let moved = 0;
  const movedNames = new Set();
  if (rules.autoApply) {
    const candidates = Grouping.matchRules(fresh, rules).flatMap(g => g.files);
    const ready = [];
    const waiting = [];
    for (const f of candidates) ((await ops.isFileReady(desktop, f.name)) ? ready : waiting).push(f);
    if (waiting.length) {
      waiting.forEach(f => known.delete(f.name)); // bir dahaki kontrolde yine "yeni" sayılsın
      clearTimeout(retryTimer);
      retryTimer = setTimeout(onDesktopChange, 10000);
    }
    const groups = Grouping.matchRules(ready, rules);
    if (groups.length) {
      quietUntil = Date.now() + 5000;
      const res = await ops.apply(desktop, groups.map(g => ({ folderName: g.folderName, target: g.target, files: g.files.map(f => f.name) })), historyPath());
      moved = res.moved;
      if (moved) groups.forEach(g => g.files.forEach(f => movedNames.add(f.name)));
      refreshShell([desktop]);
      await snapshot();
      if (moved) {
        notify(`Kurallara göre ${moved} dosya taşındı`,
          groups.map(g => `${g.folderName}: ${g.files.length}`).join(' · ') + '\nGeçmiş\'ten geri alabilirsin.',
          () => win && win.webContents.send('rescan'));
        if (win) win.webContents.send('rescan');
      }
    }
  }

  const rest = fresh.filter(f => !movedNames.has(f.name) && !notified.has(f.name)
    && !(rules.autoApply && Grouping.matchRules([f], rules).length)); // kurala uyan bekleyenler için bildirim yok
  rest.forEach(f => notified.add(f.name));
  const visible = win && win.isVisible() && win.isFocused();
  if (rest.length && settings.notifyNew && !visible) {
    const names = rest.slice(0, 3).map(f => f.name).join(', ') + (rest.length > 3 ? '…' : '');
    notify(`Masaüstüne ${rest.length} yeni dosya geldi`, `${names}\nDüzenlemek için tıkla.`,
      () => win && win.webContents.send('rescan'));
  }
}

function startWatcher() {
  if (watcher || !settings.background) return;
  snapshot();
  try {
    watcher = fs.watch(app.getPath('desktop'), () => {
      clearTimeout(debounce);
      debounce = setTimeout(onDesktopChange, 3000); // dosya kopyalanırken birkaç olay gelir, bekle
    });
    watcher.on('error', () => { watcher = null; });
  } catch { watcher = null; }
}

function stopWatcher() {
  if (watcher) { watcher.close(); watcher = null; }
  clearTimeout(debounce);
}

function restartWatcher() { stopWatcher(); startWatcher(); }

// ---------- IPC ----------
const quiet = (fn) => async (...a) => {
  quietUntil = Date.now() + 5000;
  try { return await fn(...a); }
  finally {
    quietUntil = Date.now() + 5000;
    snapshot();
    const arg = a[1];
    refreshShell([app.getPath('desktop'), arg && arg.dir].filter(Boolean)); // masaüstü simgeleri hemen güncellensin
  }
};

ipcMain.handle('get-desktop', () => app.getPath('desktop'));
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Klasör seç', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('scan', (_e, dir) => ops.scan(dir));
ipcMain.handle('scan-folders', (_e, dir) => ops.scanFolders(dir));
ipcMain.handle('find-duplicates', (_e, dir) => ops.findDuplicates(dir));
ipcMain.handle('apply', quiet((_e, { dir, groups }) => ops.apply(dir, groups, historyPath())));
ipcMain.handle('undo', quiet(() => ops.undo(historyPath())));
ipcMain.handle('list-history', () => ops.listHistory(historyPath()));
ipcMain.handle('undo-selected', quiet((_e, picks) => ops.undoSelected(historyPath(), picks)));
ipcMain.handle('history-count', () => ops.historyCount(historyPath()));
ipcMain.handle('open-folder', (_e, p) => shell.openPath(p));
ipcMain.handle('get-rules', () => readRules());
ipcMain.handle('save-rules', async (_e, rules) => {
  await fsp.mkdir(path.dirname(rulesPath()), { recursive: true });
  await fsp.writeFile(rulesPath(), JSON.stringify(rules, null, 2), 'utf8');
  return true;
});
ipcMain.handle('arrange-desktop', (_e, { mode, auto }) => arrangeDesktop(mode, auto));
ipcMain.handle('get-settings', () => ({ ...settings, canAutostart: app.isPackaged }));
ipcMain.handle('set-settings', (_e, patch) => {
  settings = { ...settings, ...patch };
  if ('theme' in patch) applyTheme();
  saveSettings();
  restartWatcher();
  return { ...settings, canAutostart: app.isPackaged };
});

// ---------- Başlangıç ----------
if (!app.requestSingleInstanceLock()) {
  app.quit(); // zaten açıksa ikinci kopyayı kapat, ilki öne gelsin
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId(APP_ID); // Windows bildirimleri için gerekli

  app.whenReady().then(() => {
    loadSettings();
    createWindow(!(startHidden && settings.background));
    createTray();
    startWatcher();
    app.on('activate', showWindow);
  });

  app.on('before-quit', () => { quitting = true; stopWatcher(); });
  app.on('window-all-closed', () => {
    if (!settings.background && process.platform !== 'darwin') app.quit();
  });
}
