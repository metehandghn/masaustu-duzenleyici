// Dosya işlemleri: tarama, taşıma, geri alma. Electron'dan bağımsız (Node ile test edilebilir).
const path = require('path');
const fs = require('fs/promises');

const IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_HISTORY = 50;

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function sanitizeFolderName(name) {
  let s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '');
  if (!s || RESERVED.test(s)) s = 'Grup';
  return s.slice(0, 100);
}

// Hedefte aynı isim varsa: "dosya (2).pdf", "dosya (3).pdf"…
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  let i = 2;
  while (await exists(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}

async function scan(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = e.name;
    if (IGNORE.has(n.toLowerCase()) || n.startsWith('.') || n.startsWith('~$')) continue;
    try {
      const st = await fs.stat(path.join(dir, n));
      files.push({ name: n, size: st.size, mtime: st.mtimeMs });
    } catch { /* erişilemeyen dosyayı atla */ }
  }
  return files;
}

// Klasördeki alt klasörleri ve içlerindeki dosya adlarını (tek seviye) listeler.
// Proje klasörleri (package.json / node_modules içeren) atlanır.
async function scanFolders(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
    try {
      const inner = await fs.readdir(path.join(dir, e.name), { withFileTypes: true });
      const names = inner.map(x => x.name.toLowerCase());
      if (names.includes('package.json') || names.includes('node_modules')) continue;
      const files = inner
        .filter(x => x.isFile() && !IGNORE.has(x.name.toLowerCase()) && !x.name.startsWith('.') && !x.name.startsWith('~$'))
        .map(x => x.name)
        .slice(0, 2000);
      folders.push({ name: e.name, files });
    } catch { /* erişilemeyen klasörü atla */ }
  }
  return folders;
}

async function readHistory(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return []; }
}

async function writeHistory(file, history) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(history.slice(-MAX_HISTORY), null, 2), 'utf8');
}

/**
 * groups: [{ folderName, files: ['a.pdf', 'b.pdf'] }]
 * Dosyaları dir/<klasör> içine taşır ve geri alma kaydı tutar.
 */
async function apply(dir, groups, historyPath) {
  const ops = [];
  const createdDirs = [];
  const errors = [];

  for (const g of groups) {
    const target = path.join(dir, sanitizeFolderName(g.folderName));
    try {
      if (await exists(target)) {
        const st = await fs.stat(target);
        if (!st.isDirectory()) throw new Error('Bu isimde bir dosya zaten var');
      } else {
        await fs.mkdir(target);
        createdDirs.push(target);
      }
    } catch (e) {
      errors.push({ file: g.folderName, message: 'Klasör oluşturulamadı: ' + e.message });
      continue;
    }

    for (const name of g.files) {
      if (path.basename(name) !== name) { // "../" gibi yollara izin verme
        errors.push({ file: name, message: 'Geçersiz dosya adı' });
        continue;
      }
      const from = path.join(dir, name);
      try {
        const to = await uniquePath(target, name);
        await fs.rename(from, to);
        ops.push({ from, to });
      } catch (e) {
        errors.push({ file: name, message: e.code === 'EBUSY' || e.code === 'EPERM' ? 'Dosya kullanımda veya erişim yok' : e.message });
      }
    }
  }

  if (ops.length || createdDirs.length) {
    const history = await readHistory(historyPath);
    history.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: Date.now(), dir, ops, createdDirs });
    await writeHistory(historyPath, history);
  }
  return { moved: ops.length, folders: groups.length, errors };
}

// Geçmişteki işlemleri listeler (en yeni en üstte), her işlemi klasör klasör gösterir.
async function listHistory(historyPath) {
  const history = await readHistory(historyPath);
  return history.map((h, i) => {
    const byFolder = new Map();
    for (const op of h.ops) {
      const d = path.dirname(op.to);
      if (!byFolder.has(d)) byFolder.set(d, []);
      byFolder.get(d).push(path.basename(op.to));
    }
    return {
      id: String(h.id || h.date || i),
      date: h.date,
      dir: h.dir,
      folders: [...byFolder].map(([p, files]) => ({ path: p, name: path.basename(p), files })),
    };
  }).filter(h => h.folders.length).reverse();
}

/**
 * Seçilen işlemleri / klasörleri geri alır.
 * picks: { [işlemId]: [klasörYolu, ...] }
 * Seçilmeyen klasörler geçmişte kalır, sonra yine geri alınabilir.
 */
async function undoSelected(historyPath, picks) {
  const history = await readHistory(historyPath);
  let restored = 0;
  const errors = [];
  const leftDirs = [];

  // Yeniden eskiye doğru geri al (aynı dosya birden çok kez taşındıysa doğru sırada döner)
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const id = String(h.id || h.date || i);
    const folders = picks[id];
    if (!folders || !folders.length) continue;
    const chosen = new Set(folders);

    const keep = [];
    for (const op of [...h.ops].reverse()) {
      if (!chosen.has(path.dirname(op.to))) { keep.unshift(op); continue; }
      try {
        if (!(await exists(op.to))) throw new Error('Dosya artık bu klasörde değil (taşınmış veya silinmiş)');
        const back = (await exists(op.from))
          ? await uniquePath(path.dirname(op.from), path.basename(op.from))
          : op.from;
        await fs.rename(op.to, back);
        restored++;
      } catch (e) {
        errors.push({ file: path.basename(op.to), message: e.message });
      }
    }
    h.ops = keep;

    const created = h.createdDirs || [];
    h.createdDirs = [];
    for (const d of created) {
      if (chosen.has(d)) {
        if (!(await removeDirIfEmpty(d))) leftDirs.push(path.basename(d));
      } else {
        h.createdDirs.push(d);
      }
    }
  }

  const rest = history.filter(h => h.ops.length);
  await writeHistory(historyPath, rest);
  return { restored, errors, leftDirs };
}

// Sadece en son işlemin tamamını geri al
async function undo(historyPath) {
  const list = await listHistory(historyPath);
  if (!list.length) return { restored: 0, nothing: true, errors: [], leftDirs: [] };
  const last = list[0];
  return undoSelected(historyPath, { [last.id]: last.folders.map(f => f.path) });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Klasörde sadece Windows'un kendi gizli dosyaları (desktop.ini, Thumbs.db) varsa
// onları temizleyip klasörü siler. OneDrive eşitleme sırasında klasörü kısa süre
// kilitleyebildiği için birkaç kez tekrar dener. Kullanıcı dosyası varsa dokunmaz.
async function removeDirIfEmpty(dir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (!(await exists(dir))) return true;
      const entries = await fs.readdir(dir);
      const real = entries.filter(n => !IGNORE.has(n.toLowerCase()));
      if (real.length) return false;
      for (const n of entries) await fs.rm(path.join(dir, n), { force: true });
      await fs.rmdir(dir);
      return true;
    } catch (e) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(e.code)) return false;
      await sleep(400 * (attempt + 1));
    }
  }
  return false;
}

async function historyCount(historyPath) {
  return (await readHistory(historyPath)).length;
}

module.exports = { scan, scanFolders, apply, undo, undoSelected, listHistory, historyCount, sanitizeFolderName };
