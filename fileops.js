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

// İçeriği birebir aynı dosyaları bulur. Önce boyuta göre ayırır, sadece aynı boyuttakilerin
// SHA-1 özetini hesaplar (büyük klasörlerde hızlı kalsın diye).
// Dönüş: [{ keep: 'asıl.pdf', copies: ['asıl (1).pdf', ...] }]
const crypto = require('crypto');
const { createReadStream } = require('fs');

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function findDuplicates(dir) {
  const files = await scan(dir);
  const bySize = new Map();
  for (const f of files) {
    if (!f.size) continue; // boş dosyalar hep "aynı" görünür, atla
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const sets = [];
  for (const list of bySize.values()) {
    if (list.length < 2) continue;
    const byHash = new Map();
    for (const f of list) {
      try {
        const h = await hashFile(path.join(dir, f.name));
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(f);
      } catch { /* okunamayan dosyayı atla */ }
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      // Asıl: en eski olan; eşitse adı en kısa olan ("rapor.docx", "rapor (1).docx"dan önce)
      same.sort((a, b) => (a.mtime - b.mtime) || (a.name.length - b.name.length) || a.name.localeCompare(b.name));
      sets.push({ keep: same[0].name, copies: same.slice(1).map(f => f.name) });
    }
  }
  return sets;
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
// Taşı; farklı sürücüye taşınıyorsa (EXDEV) kopyala + sil
async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // Farklı sürücü: kopyala + sil. Silme başarısız olursa kopyayı geri al ki
    // dosya iki yerde birden kalmasın.
    await fs.copyFile(from, to);
    try {
      await fs.unlink(from);
    } catch (err) {
      await fs.unlink(to).catch(() => {});
      throw err;
    }
  }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Dosya taşınmaya hazır mı? Yeni oluşturulmuş, hâlâ yazılan ya da başka bir
// programda (Word, OneDrive…) açık olan dosyalar beklenir.
async function isFileReady(dir, name, minAgeMs = 8000) {
  const p = path.join(dir, name);
  try {
    const a = await fs.stat(p);
    if (Date.now() - Math.max(a.mtimeMs, a.birthtimeMs || 0) < minAgeMs) return false;
    await wait(1500);
    const b = await fs.stat(p);
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) return false; // hâlâ yazılıyor
    const fh = await fs.open(p, 'r+'); // başka program kilitlediyse hata verir
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

// Hedef: mutlak yol (kuraldan, ör. D:\Belgeler\Faturalar) ya da taranan klasörün içinde bir ad
function resolveTarget(dir, g) {
  const t = String(g.target || '').trim();
  if (t && path.isAbsolute(t)) return path.normalize(t);
  return path.join(dir, sanitizeFolderName(t || g.folderName));
}

async function apply(dir, groups, historyPath) {
  const ops = [];
  const createdDirs = [];
  const errors = [];

  for (const g of groups) {
    const target = resolveTarget(dir, g);
    try {
      if (await exists(target)) {
        const st = await fs.stat(target);
        if (!st.isDirectory()) throw new Error('Bu isimde bir dosya zaten var');
      } else {
        await fs.mkdir(target, { recursive: true });
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
        await moveFile(from, to);
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
        await moveFile(op.to, back);
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

module.exports = { scan, scanFolders, findDuplicates, isFileReady, apply, undo, undoSelected, listHistory, historyCount, sanitizeFolderName };
