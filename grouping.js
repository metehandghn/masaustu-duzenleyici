// Gruplama mantığı — hem arayüzde (tarayıcı) hem Node'da (test) çalışır.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Grouping = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CATEGORIES = [
    { name: 'Resimler', color: '#e8590c', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'avif', 'svg', 'tif', 'tiff', 'ico', 'raw', 'psd', 'jfif'] },
    { name: 'Videolar', color: '#c2255c', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'mpg', 'mpeg'] },
    { name: 'Müzikler', color: '#9c36b5', exts: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus'] },
    { name: 'PDF Dosyaları', color: '#e03131', exts: ['pdf'] },
    { name: 'Word Belgeleri', color: '#1971c2', exts: ['doc', 'docx', 'odt', 'rtf', 'docm'] },
    { name: 'Excel Tabloları', color: '#2f9e44', exts: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'] },
    { name: 'Sunumlar', color: '#f08c00', exts: ['ppt', 'pptx', 'odp', 'key', 'pps', 'ppsx'] },
    { name: 'Metin Dosyaları', color: '#495057', exts: ['txt', 'md', 'log'] },
    { name: 'Web Sayfaları', color: '#7048e8', exts: ['html', 'htm', 'mhtml'] },
    { name: 'Arşivler', color: '#795548', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'] },
    { name: 'Kurulum Dosyaları', color: '#364fc7', exts: ['exe', 'msi', 'apk', 'dmg', 'iso'] },
    { name: 'Kısayollar', color: '#0c8599', exts: ['lnk', 'url', 'website'] },
    { name: 'Kod Dosyaları', color: '#5f3dc4', exts: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'cs', 'css', 'json', 'php', 'sql', 'xml', 'sh', 'bat', 'ps1'] },
    { name: 'Torrentler', color: '#5c940d', exts: ['torrent'] },
  ];
  const OTHER = { name: 'Diğer Dosyalar', color: '#868e96', exts: [] };
  const KNOWN_EXTS = new Set(CATEGORIES.flatMap(c => c.exts));

  // İsimden atılacak "gürültü" kelimeler: rapor_son_v2 (1).docx -> "rapor"
  const NOISE = new Set(['kopya', 'kopyası', 'kopyasi', 'copy', 'son', 'final', 'yeni', 'new',
    'güncel', 'guncel', 'revize', 'rev', 'taslak', 'draft', 'at', 've']);

  function splitName(fileName) {
    const i = fileName.lastIndexOf('.');
    if (i <= 0) return { base: fileName, ext: '' };
    return { base: fileName.slice(0, i), ext: fileName.slice(i + 1).toLocaleLowerCase('tr') };
  }

  // İsim karşılaştırması için gövde: "index.html.txt" -> "index", "foto.jpg.zip" -> "foto"
  function stem(fileName) {
    let { base } = splitName(fileName);
    for (;;) {
      const s = splitName(base);
      if (s.ext && KNOWN_EXTS.has(s.ext)) base = s.base; else break;
    }
    return base;
  }

  function categoryOf(ext) {
    return CATEGORIES.find(c => c.exts.includes(ext)) || OTHER;
  }

  // Karşılaştırma için: Türkçe küçük harf + ı/i farkını yok say (IMG, img, ımg aynı)
  function fold(t) {
    return t.toLocaleLowerCase('tr').replace(/ı/g, 'i');
  }

  function isNoise(t) {
    const f = fold(t);
    return !f || NOISE.has(f) || /^v\d+$/.test(f) || /^\d+[a-z]?$/.test(f);
  }

  // Orijinal yazımı koruyarak anlamlı kelimeler
  function rawTokens(base) {
    return base
      .replace(/\(\d+\)/g, ' ')                // "(1)", "(2)"
      .replace(/[_\-.\s,+()\[\]{}]+/g, ' ')    // ayraçlar
      .split(' ')
      .filter(t => !isNoise(t));
  }

  function tokens(fileName) {
    return rawTokens(stem(fileName)).map(fold);
  }

  // Baş harfi büyüt. Türkçe harf içermeyen kelimelerde "index" -> "Index" (İndex değil)
  function capitalize(w) {
    if (w === w.toLocaleUpperCase('tr') && /\p{L}/u.test(w)) return w; // IMG, PDF olduğu gibi
    const turkish = /[çğıöşüÇĞİÖŞÜ]/.test(w);
    const first = turkish ? w.charAt(0).toLocaleUpperCase('tr') : w.charAt(0).toUpperCase();
    return first + w.slice(1);
  }

  function prettyName(file, wordCount) {
    return rawTokens(stem(file.name)).slice(0, wordCount).map(capitalize).join(' ');
  }

  // Gruptaki dosyalarda en sık geçen yazımı seç
  function bestName(list, wordCount) {
    const count = new Map();
    for (const f of list) {
      const n = prettyName(f, wordCount);
      if (n) count.set(n, (count.get(n) || 0) + 1);
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : 'Grup';
  }

  function colorFor(files) {
    const exts = new Set(files.map(f => splitName(f.name).ext));
    const cats = new Set([...exts].map(e => categoryOf(e)));
    return cats.size === 1 ? [...cats][0].color : '#4c6ef5';
  }

  function sortFiles(list) {
    return list.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  }

  /**
   * files: [{ name, size, mtime }]
   * Dört tür grup üretir:
   *  - name:     benzer isimli dosyalar (türü ne olursa olsun)
   *  - type:     aynı türdeki BÜTÜN dosyalar
   *  - nametype: hem aynı tür hem benzer isim (ör. "Oncebak - Videolar")
   * Bir dosya farklı türdeki gruplarda tekrar görünebilir; hangisine gideceğini
   * arayüz, tiklenme sırasına göre belirler.
   */
  function buildGroups(files, opts = {}) {
    const minSize = opts.minGroupSize || 2;
    const groups = [];
    let n = 0;

    // ---- 1) Benzer isim ----
    const nameGroups = [];
    const usedByName = new Set();
    const byKey = new Map();
    for (const f of files) {
      const key = tokens(f.name).join(' ');
      if (key.length < 2) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(f);
    }
    for (const [key, list] of byKey) {
      if (list.length < minSize) continue;
      list.forEach(f => usedByName.add(f.name));
      nameGroups.push({ key, folderName: bestName(list, key.split(' ').length), files: list });
    }
    // Kalanları ilk kelimeye göre (Fatura Ocak, Fatura Şubat -> Fatura)
    const byFirst = new Map();
    for (const f of files) {
      if (usedByName.has(f.name)) continue;
      const t = tokens(f.name);
      if (!t.length || t[0].length < 3) continue;
      if (!byFirst.has(t[0])) byFirst.set(t[0], []);
      byFirst.get(t[0]).push(f);
    }
    for (const [key, list] of byFirst) {
      if (list.length < minSize) continue;
      list.forEach(f => usedByName.add(f.name));
      nameGroups.push({ key, folderName: bestName(list, 1), files: list });
    }
    for (const g of nameGroups) groups.push({ id: 'n' + (n++), kind: 'name', ...g });

    // ---- 2) Dosya türü (tüm dosyalar) ----
    const byCat = new Map();
    for (const f of files) {
      const cat = categoryOf(splitName(f.name).ext);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(f);
    }
    for (const [cat, list] of byCat) {
      if (list.length < minSize) continue;
      groups.push({ id: 't' + (n++), kind: 'type', key: cat.name, folderName: cat.name, files: list });
    }

    // ---- 3) Tür + isim ----
    for (const ng of nameGroups) {
      const split = new Map();
      for (const f of ng.files) {
        const cat = categoryOf(splitName(f.name).ext);
        if (!split.has(cat)) split.set(cat, []);
        split.get(cat).push(f);
      }
      for (const [cat, list] of split) {
        if (list.length < minSize) continue;
        groups.push({
          id: 'x' + (n++), kind: 'nametype', key: ng.key + '|' + cat.name,
          folderName: `${ng.folderName} - ${cat.name}`, files: list,
        });
      }
    }

    const order = { name: 0, nametype: 1, type: 2 };
    for (const g of groups) { sortFiles(g.files); g.color = colorFor(g.files); }
    groups.sort((a, b) => (a.kind === b.kind ? b.files.length - a.files.length : order[a.kind] - order[b.kind]));

    const inAny = new Set(groups.flatMap(g => g.files.map(f => f.name)));
    const ungrouped = files.filter(f => !inAny.has(f.name));
    return { groups, ungrouped };
  }

  // ---- Var olan klasörler ----
  // Klasörün "profili": içindeki dosyalarda en sık geçen ilk kelime ve tür.
  // Klasör boşsa ya da karışıksa klasörün adına bakılır ("Oncebak - Videolar", "PDF Dosyaları").
  function dominant(values, minShare) {
    const count = new Map();
    for (const v of values) if (v) count.set(v, (count.get(v) || 0) + 1);
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] / values.length >= minShare ? best[0] : null;
  }

  function categoryByName(text) {
    const f = fold(text.trim());
    return CATEGORIES.find(c => fold(c.name) === f || fold(c.name).split(' ')[0] === f) || null;
  }

  function folderProfile(folder) {
    const names = folder.files || [];
    let token = null, cat = null;
    if (names.length) {
      token = dominant(names.map(n => tokens(n)[0]).filter(t => t && t.length >= 3), 0.6);
      if (token && names.filter(n => tokens(n)[0] === token).length / names.length < 0.6) token = null;
      const c = dominant(names.map(n => categoryOf(splitName(n).ext)), 0.6);
      cat = c && c !== OTHER ? c : null;
    }
    // Klasörün adı doğrudan bir tür adıysa ("Videolar", "PDF Dosyaları") bu bir tür klasörüdür
    const wholeCat = categoryByName(folder.name);
    if (wholeCat) return { token: null, cat: wholeCat };
    // Tek dosyalı klasörde dosya adı klasörün adında da geçmiyorsa isme güvenme
    const nameTokens = rawTokens(folder.name).map(fold);
    if (token && names.length < 2 && !nameTokens.some(t => t.startsWith(token))) token = null;
    // Klasör adından tamamla: "Oncebak - Videolar" -> oncebak + Videolar
    const parts = folder.name.split(/\s+-\s+/);
    for (const part of parts) {
      const c = categoryByName(part);
      if (c) { if (!cat) cat = c; continue; }
      const t = rawTokens(part).map(fold)[0];
      if (!token && t && t.length >= 3) token = t;
    }
    return { token, cat };
  }

  /**
   * folders: [{ name, files: ['a.mp4', ...] }]
   * Dışarıdaki dosyalardan hangilerinin var olan bir klasöre ait olduğunu bulur.
   * Öncelik: isim + tür eşleşmesi > sadece isim > sadece tür.
   */
  function matchExisting(files, folders) {
    const best = new Map(); // dosya adı -> { folder, score }
    for (const folder of folders) {
      const { token, cat } = folderProfile(folder);
      if (!token && !cat) continue;
      for (const f of files) {
        const ft = tokens(f.name)[0];
        const fc = categoryOf(splitName(f.name).ext);
        let score = 0;
        if (token && cat) score = ft === token && fc === cat ? 3 : 0;
        else if (token) score = ft === token ? 2 : 0;
        else if (cat) score = fc === cat ? 1 : 0;
        if (!score) continue;
        const prev = best.get(f.name);
        const size = (folder.files || []).length;
        if (!prev || score > prev.score || (score === prev.score && size > prev.size)) {
          best.set(f.name, { folder, score, size, file: f });
        }
      }
    }
    const byFolder = new Map();
    for (const m of best.values()) {
      if (!byFolder.has(m.folder)) byFolder.set(m.folder, []);
      byFolder.get(m.folder).push(m.file);
    }
    let n = 0;
    return [...byFolder].map(([folder, list]) => ({
      id: 'e' + (n++), kind: 'existing', key: folder.name, folderName: folder.name,
      existingCount: (folder.files || []).length, files: sortFiles(list), color: colorFor(list),
    })).sort((a, b) => b.files.length - a.files.length);
  }

  return { buildGroups, matchExisting, categoryOf, splitName, tokens, CATEGORIES };
});
