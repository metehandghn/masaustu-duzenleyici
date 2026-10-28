// Arayüz mantığı
const $ = (s) => document.querySelector(s);
const PREVIEW = 6; // kartta ilk kaç dosya görünsün
const KIND_LABEL = { name: 'Benzer isim', type: 'Dosya türü', nametype: 'Tür + isim', custom: 'Senin grubun', existing: 'Var olan klasör', rule: 'Kural', dup: 'Kopya', old: 'Eski dosya', rest: 'Gruplanmamış' };
let customCounter = 0;

const state = {
  dir: null,
  files: [],
  groups: [],
  ungrouped: [],
  enabled: new Set(),    // tiklenen grup id'leri (tiklenme sırasıyla)
  unchecked: new Map(),  // grupId -> tiki kaldırılmış dosya adları
  expanded: new Set(),
  filter: 'all',
  drag: null,            // sürüklenen dosya: { gid, name }
  focusId: null,         // render sonrası adına odaklanılacak grup
  desktop: null,         // masaüstü klasörünün yolu
  rules: { autoApply: false, folders: [] },
  dups: [],              // [{ keep, copies }]
  firstLoad: true,       // otomatik kural uygulaması sadece açılışta
};

// Kullanıcı tercihleri (sıralama biçimi vb.) — sadece bu bilgisayarda saklanır
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('pref:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pref:' + k, JSON.stringify(v)); } catch { /* yoksay */ } },
};
const SORT_MODES = [
  ['type', 'Türe göre', 'Klasörler önce, sonra aynı türdeki dosyalar yan yana'],
  ['name', 'Ada göre', 'Alfabetik sıra'],
  ['added', 'Eklenme tarihine göre', 'Masaüstüne en son gelenler önce (indirilen/kopyalanan dosyalarda tam doğru)'],
  ['date', 'Değiştirme tarihine göre', 'En son düzenlenenler önce'],
  ['size', 'Boyuta göre', 'En büyükler önce'],
];
const isDesktop = () => state.desktop && state.dir && state.dir.toLowerCase() === state.desktop.toLowerCase();

function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style') n.style.cssText = v;
    else n[k] = v;
  }
  for (const c of [].concat(children)) if (c) n.append(c);
  return n;
}

function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(1) + ' GB';
}

const groupById = (id) => state.groups.find(g => g.id === id);

function isChecked(g, name) {
  const off = state.unchecked.get(g.id);
  return !(off && off.has(name));
}

// Bir dosya birden çok seçili grupta olabilir. İlk tiklenen grup kazanır.
function assignment() {
  const owner = new Map(); // dosya adı -> grup id
  for (const id of state.enabled) {
    const g = groupById(id);
    if (!g || g.kind === 'rest') continue;
    for (const f of g.files) if (isChecked(g, f.name) && !owner.has(f.name)) owner.set(f.name, g.id);
  }
  return owner;
}

function filesGoingTo(g, owner) {
  return g.files.filter(f => owner.get(f.name) === g.id);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function confirmBox(title, body, okText = 'Onayla') {
  return new Promise(resolve => {
    $('#modalTitle').textContent = title;
    const b = $('#modalBody');
    b.innerHTML = '';
    b.append(body);
    $('#modalOk').textContent = okText;
    $('#modalCancel').classList.toggle('hidden', okText === 'Tamam');
    $('#modal').classList.remove('hidden');
    const done = (v) => {
      $('#modal').classList.add('hidden');
      $('#modalOk').onclick = $('#modalCancel').onclick = null;
      resolve(v);
    };
    $('#modalOk').onclick = () => done(true);
    $('#modalCancel').onclick = () => done(false);
  });
}

// ---------- Sürükle-bırak ----------
function groupColor(files) {
  const cats = new Set(files.map(f => Grouping.categoryOf(Grouping.splitName(f.name).ext)));
  return cats.size === 1 ? [...cats][0].color : '#4c6ef5';
}

function takeFile(srcId, name) {
  const src = groupById(srcId);
  const f = src && src.files.find(x => x.name === name);
  if (!f) return null;
  src.files = src.files.filter(x => x.name !== name);
  if (state.unchecked.has(srcId)) state.unchecked.get(srcId).delete(name);
  if (!src.files.length) {
    state.groups = state.groups.filter(g => g !== src);
    state.enabled.delete(srcId);
  } else {
    src.color = groupColor(src.files);
  }
  return f;
}

function moveFile(srcId, dstId, name) {
  const dst = groupById(dstId);
  if (!dst) return;
  if (dst.files.some(x => x.name === name)) {
    // Zaten o grupta: kaynaktan çıkar, hedefte tikli olsun
    if (state.unchecked.has(dstId)) state.unchecked.get(dstId).delete(name);
    takeFile(srcId, name);
  } else {
    const f = takeFile(srcId, name);
    if (!f) return;
    dst.files.push(f);
    dst.files.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    dst.color = groupColor(dst.files);
  }
  toast(`${name} → ${dst.folderName}`);
  render();
}

function newGroupFrom(srcId, name) {
  const f = takeFile(srcId, name);
  if (!f) return;
  const g = { id: 'c' + (customCounter++), kind: 'custom', key: '', folderName: 'Yeni Klasör', files: [f], color: groupColor([f]) };
  state.groups.unshift(g);
  state.enabled.add(g.id);
  state.focusId = g.id;
  render();
}

// Bir karta (veya yeni klasör alanına) bırakılabilir özelliği ekler
function makeDropTarget(node, accept, onDrop) {
  node.addEventListener('dragover', (e) => {
    if (!state.drag || !accept()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('drop');
  });
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop');
    const d = state.drag;
    state.drag = null;
    if (d && accept(d)) onDrop(d);
  });
}

// ---------- Kart ----------
// Kalan dosyalar: tiki ve klasörü yok, sadece sürükleme kaynağı
function renderRestCard(g) {
  const list = el('ul', { class: 'file-list' });
  const showAll = state.expanded.has(g.id);
  for (const f of (showAll ? g.files : g.files.slice(0, PREVIEW))) {
    const { ext } = Grouping.splitName(f.name);
    const li = el('li', {
      draggable: true, title: f.name + '\nBir karta ya da Yeni klasör alanına sürükle',
      ondragstart: (e) => {
        state.drag = { gid: g.id, name: f.name };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.name);
        requestAnimationFrame(() => li.classList.add('dragging'));
        document.body.classList.add('is-dragging');
      },
      ondragend: () => {
        li.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        document.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'));
        state.drag = null;
      },
    }, [
      el('span', { class: 'grip', text: '⠿' }),
      el('span', { class: 'ext', text: ext ? ext.slice(0, 4) : '—', style: `background:${Grouping.categoryOf(ext).color}` }),
      el('span', { class: 'fname', text: f.name }),
      el('span', { class: 'fsize', text: formatSize(f.size) }),
    ]);
    list.append(li);
  }
  const card = el('article', { class: 'card rest' }, [
    el('div', { class: 'card-head' }, [
      el('div', { class: 'bar', style: `background:${g.color}` }),
      el('div', { class: 'title' }, [
        el('div', { class: 'rest-title', text: 'Kalan dosyalar' }),
        el('div', { class: 'meta' }, [
          el('span', { class: 'badge rest', text: KIND_LABEL.rest }),
          el('span', { text: `${g.files.length} dosya · bir karta sürükle` }),
        ]),
      ]),
    ]),
    list,
  ]);
  if (g.files.length > PREVIEW) {
    card.append(el('button', {
      class: 'more', text: showAll ? 'Daha az göster' : `+${g.files.length - PREVIEW} dosya daha`,
      onclick: () => { showAll ? state.expanded.delete(g.id) : state.expanded.add(g.id); render(); },
    }));
  }
  return card;
}

function renderCard(g, owner) {
  if (g.kind === 'rest') return renderRestCard(g);
  const on = state.enabled.has(g.id);
  const going = on ? filesGoingTo(g, owner).length : g.files.filter(f => isChecked(g, f.name)).length;

  const head = el('div', { class: 'card-head' }, [
    el('input', {
      type: 'checkbox', class: 'check', checked: on, title: 'Bu grubu klasörle',
      onchange: (e) => {
        e.target.checked ? state.enabled.add(g.id) : state.enabled.delete(g.id);
        render();
      },
    }),
    el('div', { class: 'bar', style: `background:${g.color}` }),
    el('div', { class: 'title' }, [
      el('input', {
        class: 'folder-input', value: g.folderName, spellcheck: false,
        readOnly: g.kind === 'existing' || g.kind === 'rule',
        title: g.kind === 'rule' ? `Kurala göre hedef: ${g.target}`
          : g.kind === 'existing' ? 'Bu klasör zaten var, dosyalar içine eklenecek' : 'Klasör adını değiştirmek için tıkla',
        oninput: (e) => { g.folderName = e.target.value; },
        onchange: () => render(), // diğer kartlardaki "→ klasör" yazıları güncellensin
      }),
      el('div', { class: 'meta' }, [
        el('span', { class: 'badge ' + g.kind, text: KIND_LABEL[g.kind] }),
        el('span', { text: g.kind === 'existing' ? `+${going} yeni` : `${going}/${g.files.length} dosya` }),
        g.kind === 'existing' ? el('span', { class: 'in-folder', title: `Klasörde şu an ${g.existingCount} dosya var`, text: `📁 ${g.existingCount} dosya` }) : null,
        g.kind === 'old' ? el('select', { class: 'age-select', title: 'Bu süredir değişmemiş dosyalar',
          onchange: (e) => setArchiveDays(Number(e.target.value)) },
          AGE_OPTIONS.map(([d, t]) => el('option', { value: d, text: t + ' eski', selected: d === g.days }))) : null,
      ]),
    ]),
    ['custom', 'dup', 'old'].includes(g.kind) ? null : el('button', {
      class: 'rule-btn',
      title: g.kind === 'rule' ? 'Bu kuralı düzenle' : 'Bu grup için kalıcı kural yap',
      text: g.kind === 'rule' ? '✎' : '⭐',
      onclick: (e) => { e.stopPropagation(); g.kind === 'rule' ? openRules(null, g.ruleFolderId) : openRules(Grouping.suggestRule(g)); },
    }),
  ]);

  const list = el('ul', { class: 'file-list' });
  const showAll = state.expanded.has(g.id);
  for (const f of (showAll ? g.files : g.files.slice(0, PREVIEW))) {
    const { ext } = Grouping.splitName(f.name);
    const checked = isChecked(g, f.name);
    const takenBy = owner.has(f.name) && owner.get(f.name) !== g.id ? groupById(owner.get(f.name)) : null;
    const li = el('li', {
      draggable: true,
      ondragstart: (e) => {
        state.drag = { gid: g.id, name: f.name };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', f.name);
        requestAnimationFrame(() => li.classList.add('dragging'));
        document.body.classList.add('is-dragging');
      },
      ondragend: () => {
        li.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        document.querySelectorAll('.drop').forEach(n => n.classList.remove('drop'));
        state.drag = null;
      },
      class: !checked ? 'off' : takenBy ? 'taken' : '',
      title: takenBy ? `${f.name}\nBu dosya "${takenBy.folderName}" klasörüne gidecek` : f.name,
    });
    li.append(
      el('input', {
        type: 'checkbox', class: 'check', checked,
        onchange: (e) => {
          if (!state.unchecked.has(g.id)) state.unchecked.set(g.id, new Set());
          const set = state.unchecked.get(g.id);
          e.target.checked ? set.delete(f.name) : set.add(f.name);
          render();
        },
      }),
      el('span', { class: 'ext', text: ext ? ext.slice(0, 4) : '—', style: `background:${Grouping.categoryOf(ext).color}` }),
      el('span', { class: 'fname', text: f.name }),
      takenBy && checked
        ? el('span', { class: 'taken-note', text: '→ ' + takenBy.folderName })
        : g.notes && g.notes[f.name]
          ? el('span', { class: 'dup-note', title: 'Bununla birebir aynı: ' + g.notes[f.name], text: '= ' + g.notes[f.name] })
          : g.kind === 'old'
            ? el('span', { class: 'fsize', title: 'Son değişiklik', text: formatAge(f.mtime) })
            : el('span', { class: 'fsize', text: formatSize(f.size) }),
    );
    list.append(li);
  }

  const card = el('article', { class: 'card' + (on ? ' on' : '') }, [head, list]);
  makeDropTarget(card, (d = state.drag) => d && d.gid !== g.id, (d) => moveFile(d.gid, g.id, d.name));
  if (g.files.length > PREVIEW) {
    card.append(el('button', {
      class: 'more',
      text: showAll ? 'Daha az göster' : `+${g.files.length - PREVIEW} dosya daha`,
      onclick: () => { showAll ? state.expanded.delete(g.id) : state.expanded.add(g.id); render(); },
    }));
  }
  return card;
}

// ---------- Ekran ----------
function visibleGroups() {
  return state.groups.filter(g => g.kind === 'rest' ? state.filter === 'all' : (state.filter === 'all' || g.kind === state.filter || g.kind === 'custom'));
}

function render() {
  const box = $('#groups');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const vis = visibleGroups();
  const owner = assignment();

  const count = (k) => state.groups.filter(g => g.kind === k).length;
  $('#cAll').textContent = state.groups.filter(g => g.kind !== 'rest').length;
  $('#cName').textContent = count('name');
  $('#cType').textContent = count('type');
  $('#cNameType').textContent = count('nametype');
  $('#cExisting').textContent = count('existing');
  $('#cRule').textContent = count('rule');
  for (const [k, tab, c] of [['dup', '#tabDup', '#cDup'], ['old', '#tabOld', '#cOld']]) {
    const g = state.groups.find(x => x.kind === k);
    $(c).textContent = g ? g.files.length : 0;
    $(tab).classList.toggle('hidden', !g);
  }
  $('#tabRule').classList.toggle('hidden', !count('rule'));

  if (!state.files.length) {
    box.append(el('div', { class: 'empty' }, [el('h3', { text: 'Burası zaten tertemiz ✨' }), el('p', { text: 'Bu klasörde düzenlenecek dosya bulunamadı.' })]));
  } else if (!vis.length) {
    box.append(el('div', { class: 'empty' }, [el('h3', { text: 'Bu sekmede grup yok' }), el('p', { text: 'Gruplanacak en az 2 benzer dosya bulunamadı.' })]));
  } else {
    vis.forEach(g => box.append(renderCard(g, owner)));
  }
  if (state.files.length) {
    const zone = el('div', { class: 'new-drop' }, [
      el('div', { class: 'plus', text: '+' }),
      el('strong', { text: 'Yeni klasör' }),
      el('span', { text: 'Bir dosyayı buraya sürükle, kendi grubunu oluştur' }),
    ]);
    makeDropTarget(zone, () => true, (d) => newGroupFrom(d.gid, d.name));
    box.append(zone);
  }
  if (state.focusId) {
    const idx = vis.findIndex(g => g.id === state.focusId);
    const input = idx >= 0 && box.querySelectorAll('.card')[idx]?.querySelector('.folder-input');
    if (input) { input.focus(); input.select(); }
    state.focusId = null;
  }
  box.scrollTop = scroll;

  $('#stats').textContent = state.files.length
    ? `${state.files.length} dosya bulundu · ${state.groups.length} grup önerildi · ${state.ungrouped.length} dosya hiçbir gruba uymadı`
    : '';
  updateFooter(owner);
}

function chosenGroups(owner) {
  return state.groups.filter(g => state.enabled.has(g.id) && filesGoingTo(g, owner).length);
}

function updateFooter(owner = assignment()) {
  const chosen = chosenGroups(owner);
  $('#summary').innerHTML = chosen.length
    ? `<b>${chosen.length}</b> klasör, <b>${owner.size}</b> dosya taşınacak`
    : 'Düzenlemek istediğin grupları tikle.';
  $('#btnApply').disabled = !chosen.length;
}

async function refreshUndo() {
  $('#btnUndo').disabled = (await window.api.historyCount()) === 0;
}

async function load(dir, opts = {}) {
  state.dir = dir;
  $('#btnArrange').classList.toggle('hidden', !isDesktop());
  $('#dirLabel').textContent = dir;
  $('#dirLabel').title = dir;
  let folders = [];
  try {
    state.files = await window.api.scan(dir);
    folders = await window.api.scanFolders(dir);
  } catch (e) {
    state.files = [];
    toast('Klasör okunamadı: ' + e.message);
  }
  try { state.rules = await window.api.getRules(); } catch { /* kural yoksa boş */ }
  const { groups } = Grouping.buildGroups(state.files);
  const existing = Grouping.matchExisting(state.files, folders);
  const ruleGroups = Grouping.matchRules(state.files, state.rules);
  try { state.dups = await window.api.findDuplicates(dir); } catch { state.dups = []; }
  state.groups = [...ruleGroups, ...existing, ...suggestionGroups(), ...groups];

  // Açılışta otomatik uygula
  const first = state.firstLoad;
  state.firstLoad = false;
  if (first && state.rules.autoApply && ruleGroups.length) {
    const res = await window.api.apply(dir, ruleGroups.map(g => ({ folderName: g.folderName, target: g.target, files: g.files.map(f => f.name) })));
    await load(dir, { quiet: true });
    if (res.moved) toast(`⚙ Kurallara göre ${res.moved} dosya taşındı. Geçmiş'ten geri alabilirsin.`);
    if (res.errors.length) showErrors(`${res.errors.length} dosya taşınamadı`, res.errors);
    if (res.moved && isDesktop() && prefs.get('arrangeAfter', true)) runArrange(prefs.get('sortMode', 'type'), -1, true);
    return;
  }
  const inAny = new Set(state.groups.flatMap(g => g.files.map(f => f.name)));
  state.ungrouped = state.files.filter(f => !inAny.has(f.name));
  // Hiçbir gruba girmeyenler tek bir kartta: oradan sürüklenip istenen karta bırakılabilir
  if (state.ungrouped.length) {
    state.groups.push({ id: 'u0', kind: 'rest', key: 'rest', folderName: 'Kalan dosyalar',
      files: [...state.ungrouped].sort((a, b) => a.name.localeCompare(b.name, 'tr')), color: '#adb5bd' });
  }
  if (existing.length && !opts.quiet) {
    const n = existing.reduce((t, g) => t + g.files.length, 0);
    setTimeout(() => toast(`${n} dosya, var olan ${existing.length} klasöre eklenebilir`), 300);
  }
  state.enabled.clear();
  state.unchecked.clear();
  state.expanded.clear();
  ruleGroups.forEach(g => state.enabled.add(g.id)); // kural grupları tikli gelir
  render();
  refreshUndo();
}

// ---------- İşlemler ----------
async function applySelected() {
  const owner = assignment();
  const chosen = chosenGroups(owner);
  if (chosen.some(g => !g.folderName.trim())) { toast('Klasör adı boş olamaz.'); return; }

  const ul = el('ul');
  chosen.forEach(g => ul.append(el('li', {}, [
    el('strong', { text: '📁 ' + g.folderName.trim() }),
    el('span', { text: g.kind === 'existing' ? `var olan klasöre +${filesGoingTo(g, owner).length} dosya` : filesGoingTo(g, owner).length + ' dosya' }),
  ])));
  const body = el('div', {}, [
    el('p', { text: `${owner.size} dosya aşağıdaki klasörlere taşınacak. Aynı isimde klasör varsa dosyalar onun içine eklenir.` }),
    ul,
    el('p', { text: 'İstersen sonra “Son işlemi geri al” ile her şeyi eski yerine döndürebilirsin.' }),
  ]);
  let arrangeBox = null;
  if (isDesktop()) {
    arrangeBox = el('input', { type: 'checkbox', class: 'check', checked: prefs.get('arrangeAfter', true) });
    body.append(el('label', { class: 'opt-row' }, [arrangeBox, el('span', { text: 'Ardından masaüstü simgelerini düzenli sırala' })]));
  }
  if (!(await confirmBox('Klasörleme yapılsın mı?', body, 'Klasörle'))) return;
  const arrangeAfter = arrangeBox ? arrangeBox.checked : false;
  if (arrangeBox) prefs.set('arrangeAfter', arrangeAfter);

  $('#btnApply').disabled = true;
  const res = await window.api.apply(state.dir, chosen.map(g => ({
    folderName: g.folderName.trim(),
    target: g.target,
    files: filesGoingTo(g, owner).map(f => f.name),
  })));
  await load(state.dir);
  if (res.errors.length) showErrors(`${res.moved} dosya taşındı, ${res.errors.length} dosyada sorun çıktı`, res.errors);
  else toast(`✓ ${res.moved} dosya ${chosen.length} klasöre yerleştirildi`);
  if (arrangeAfter && res.moved) await runArrange(prefs.get('sortMode', 'type'), -1, true);
}

function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'Bugün ' + time;
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }) + ' ' + time;
}

// Geçmiş penceresi: hangi işlemleri / klasörleri geri alacağını seç
async function openHistory() {
  const list = await window.api.listHistory();
  if (!list.length) { toast('Geri alınacak işlem yok.'); refreshUndo(); return; }

  const picks = []; // { id, folder, cb } — aynı klasör farklı işlemlerde tekrar edebilir
  const body = el('div', { class: 'history' }, [
    el('p', { text: 'Geri almak istediğin işlemleri ya da tek tek klasörleri seç. Seçtiğin klasörlerdeki dosyalar eski yerine döner, klasör silinir.' }),
  ]);

  list.forEach((h, idx) => {
    const total = h.folders.reduce((n, f) => n + f.files.length, 0);
    const children = [];
    const headCheck = el('input', { type: 'checkbox', class: 'check' });
    const folderRows = h.folders.map(f => {
      const cb = el('input', {
        type: 'checkbox', class: 'check',
        onchange: () => { headCheck.checked = children.every(c => c.checked); headCheck.indeterminate = !headCheck.checked && children.some(c => c.checked); updateOk(); },
      });
      children.push(cb);
      picks.push({ id: h.id, folder: f.path, cb });
      return el('label', { class: 'h-folder', title: f.files.join('\n') }, [
        cb,
        el('span', { class: 'h-name', text: '📁 ' + f.name }),
        el('span', { class: 'h-count', text: f.files.length + ' dosya' }),
      ]);
    });
    headCheck.addEventListener('change', () => {
      children.forEach(c => { c.checked = headCheck.checked; });
      headCheck.indeterminate = false;
      updateOk();
    });
    body.append(el('div', { class: 'h-entry' }, [
      el('label', { class: 'h-head' }, [
        headCheck,
        el('span', { class: 'h-name' }, [
          el('strong', { text: formatDate(h.date) }),
          idx === 0 ? el('span', { class: 'badge custom', text: 'En son' }) : null,
        ]),
        el('span', { class: 'h-count', text: `${h.folders.length} klasör · ${total} dosya` }),
      ]),
      el('div', { class: 'h-dir', text: h.dir }),
      ...folderRows,
    ]));
  });

  const ok = $('#modalOk');
  function updateOk() {
    const n = picks.filter(p => p.cb.checked).length;
    ok.disabled = n === 0;
    ok.textContent = n ? `${n} klasörü geri al` : 'Geri al';
  }
  const promise = confirmBox('Geçmiş', body, 'Geri al');
  $('#modal').classList.add('wide');
  updateOk();
  const confirmed = await promise;
  $('#modal').classList.remove('wide');
  ok.disabled = false;
  if (!confirmed) return;

  const byId = {};
  for (const p of picks) if (p.cb.checked) (byId[p.id] = byId[p.id] || []).push(p.folder);
  if (!Object.keys(byId).length) return;

  toast('Geri alınıyor…');
  const res = await window.api.undoSelected(byId);
  await load(state.dir);
  if (res.errors.length) showErrors(`${res.restored} dosya geri taşındı, ${res.errors.length} dosyada sorun çıktı`, res.errors);
  else if (res.leftDirs && res.leftDirs.length) toast(`↶ ${res.restored} dosya döndü. İçinde başka dosya olduğu için silinmeyen klasör: ${res.leftDirs.join(', ')}`);
  else toast(`↶ ${res.restored} dosya eski yerine döndü`);
}

// ---------- Öneriler: kopyalar ve eski dosyalar ----------
const AGE_OPTIONS = [[30, '1 aydan'], [90, '3 aydan'], [180, '6 aydan'], [365, '1 yıldan']];
const NO_ARCHIVE = new Set(['lnk', 'url', 'website']); // kısayollar masaüstünde kalsın

function formatAge(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 864e5);
  if (days < 30) return days + ' gün önce';
  if (days < 365) return Math.floor(days / 30) + ' ay önce';
  return Math.floor(days / 365) + ' yıl önce';
}

function oldGroup() {
  const days = prefs.get('archiveDays', 90);
  const cutoff = Date.now() - days * 864e5;
  const files = state.files
    .filter(f => f.mtime && f.mtime < cutoff && !NO_ARCHIVE.has(Grouping.splitName(f.name).ext))
    .sort((a, b) => a.mtime - b.mtime);
  return files.length ? { id: 'o0', kind: 'old', key: 'old', folderName: 'Arşiv', files, days, color: '#868e96' } : null;
}

function suggestionGroups() {
  const out = [];
  const byName = new Map(state.files.map(f => [f.name, f]));
  const notes = {};
  const copies = [];
  for (const set of state.dups || []) {
    for (const c of set.copies) {
      if (!byName.has(c)) continue;
      notes[c] = set.keep;
      copies.push(byName.get(c));
    }
  }
  if (copies.length) out.push({ id: 'd0', kind: 'dup', key: 'dup', folderName: 'Kopyalar', files: copies, notes, color: '#e03131' });
  const old = oldGroup();
  if (old) out.push(old);
  return out;
}

function setArchiveDays(days) {
  prefs.set('archiveDays', days);
  const i = state.groups.findIndex(g => g.kind === 'old');
  const g = oldGroup();
  if (i >= 0) { g ? (state.groups[i] = g) : state.groups.splice(i, 1); }
  else if (g) state.groups.push(g);
  if (!g) state.enabled.delete('o0');
  if (state.unchecked.has('o0')) state.unchecked.delete('o0');
  render();
}

// ---------- Kurallar ----------
const TYPE_NAMES = Grouping.CATEGORIES.map(c => c.name).concat('Diğer Dosyalar');
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));

// prefill: { target, rules } (karttan öneri) · focusId: düzenlenecek klasörün id'si
async function openRules(prefill, focusId) {
  const cfg = clone(state.rules || { autoApply: false, folders: [] });
  cfg.folders = cfg.folders || [];
  let focus = focusId || null;
  if (prefill) {
    const same = cfg.folders.find(f => String(f.target).toLowerCase() === String(prefill.target).toLowerCase());
    if (same) { same.rules.push(...prefill.rules); focus = same.id; }
    else { const f = { id: newId(), target: prefill.target, enabled: true, rules: prefill.rules }; cfg.folders.unshift(f); focus = f.id; }
  }

  const box = el('div', { class: 'rules-editor' });

  function condRow(rule, c, ri, ci) {
    const field = el('select', { class: 'r-field', onchange: (e) => { c.field = e.target.value; if (c.field === 'type') c.value = TYPE_NAMES[0]; draw(); } },
      Object.entries(Grouping.FIELDS).map(([k, label]) => el('option', { value: k, text: label, selected: c.field === k })));
    const value = c.field === 'type'
      ? el('select', { class: 'r-value', onchange: (e) => { c.value = e.target.value; } },
          TYPE_NAMES.map(n => el('option', { value: n, text: n, selected: c.value === n })))
      : el('input', { class: 'r-value', value: c.value || '', spellcheck: false,
          placeholder: c.field === 'ext' ? 'ör. zip' : 'ör. fatura', oninput: (e) => { c.value = e.target.value; } });
    return el('div', { class: 'r-cond' }, [
      el('span', { class: 'r-join', text: ci === 0 ? (ri === 0 ? 'Eğer' : 'veya') : 've' }),
      field, value,
      el('button', { class: 'r-x', title: 'Koşulu sil', text: '×', onclick: () => {
        rule.conds.splice(ci, 1);
        if (!rule.conds.length) rule._remove = true;
        draw();
      } }),
    ]);
  }

  function folderCard(f, i) {
    f.rules = (f.rules || []).filter(r => !r._remove);
    const target = el('input', { class: 'r-target', value: f.target || '', spellcheck: false,
      placeholder: 'Klasör adı (ör. Faturalar) ya da tam yol', oninput: (e) => { f.target = e.target.value; } });
    const card = el('div', { class: 'r-folder' + (f.enabled === false ? ' off' : '') + (f.id === focus ? ' focus' : '') }, [
      el('div', { class: 'r-head' }, [
        el('input', { type: 'checkbox', class: 'check', checked: f.enabled !== false, title: 'Kuralı aç/kapat',
          onchange: (e) => { f.enabled = e.target.checked; card.classList.toggle('off', !f.enabled); } }),
        el('span', { class: 'r-icon', text: '📁' }),
        target,
        el('button', { class: 'ghost sm', text: 'Gözat', onclick: async () => { const d = await window.api.chooseFolder(); if (d) { f.target = d; target.value = d; } } }),
        el('button', { class: 'r-icon-btn', title: 'Yukarı (öncelik)', text: '↑', disabled: i === 0, onclick: () => { [cfg.folders[i - 1], cfg.folders[i]] = [cfg.folders[i], cfg.folders[i - 1]]; draw(); } }),
        el('button', { class: 'r-icon-btn', title: 'Aşağı', text: '↓', disabled: i === cfg.folders.length - 1, onclick: () => { [cfg.folders[i + 1], cfg.folders[i]] = [cfg.folders[i], cfg.folders[i + 1]]; draw(); } }),
        el('button', { class: 'r-icon-btn danger', title: 'Bu klasörün kurallarını sil', text: '🗑', onclick: () => { cfg.folders.splice(i, 1); draw(); } }),
      ]),
      el('div', { class: 'r-hint', text: 'Bu klasöre gelsin:' }),
    ]);
    f.rules.forEach((rule, ri) => {
      const r = el('div', { class: 'r-rule' }, rule.conds.map((c, ci) => condRow(rule, c, ri, ci)));
      r.append(el('button', { class: 'link sm', text: '+ ve koşulu', onclick: () => { rule.conds.push({ field: 'type', value: TYPE_NAMES[0] }); draw(); } }));
      card.append(r);
    });
    card.append(el('button', { class: 'link sm', text: f.rules.length ? '+ veya başka kural' : '+ Kural ekle',
      onclick: () => { f.rules.push({ conds: [{ field: 'start', value: '' }] }); draw(); } }));
    return card;
  }

  function draw() {
    box.innerHTML = '';
    const auto = el('input', { type: 'checkbox', class: 'check', checked: !!cfg.autoApply, onchange: (e) => { cfg.autoApply = e.target.checked; } });
    box.append(
      el('label', { class: 'opt-row auto' }, [auto, el('span', {}, [
        el('strong', { text: 'Kuralları otomatik uygula' }),
        el('small', { text: 'Uygulama açılınca ve arka planda masaüstüne yeni dosya gelince, kurala uyan dosyalar sormadan taşınır. Kapalıysa sadece tikli gelir, sen onaylarsın. Her durumda Geçmiş\'ten geri alınabilir.' }),
      ])]),
    );
    if (!cfg.folders.length) box.append(el('p', { class: 'r-empty', text: 'Henüz kural yok. Bir grup kartındaki ⭐ ile ya da aşağıdan ekleyebilirsin.' }));
    cfg.folders.forEach((f, i) => box.append(folderCard(f, i)));
    box.append(el('button', { class: 'ghost r-add', text: '+ Yeni klasör için kural tanımla', onclick: () => {
      const f = { id: newId(), target: '', enabled: true, rules: [{ conds: [{ field: 'start', value: '' }] }] };
      cfg.folders.push(f); focus = f.id; draw();
      const inputs = box.querySelectorAll('.r-target'); inputs[inputs.length - 1].focus();
    } }));
    const fc = box.querySelector('.r-folder.focus');
    if (fc) requestAnimationFrame(() => fc.scrollIntoView({ block: 'nearest' }));
  }

  draw();
  const promise = confirmBox('Kurallar', box, 'Kaydet');
  $('#modal').classList.add('wide', 'xwide');
  const ok = await promise;
  $('#modal').classList.remove('wide', 'xwide');
  if (!ok) return;

  // Temizle: boş koşulları, koşulsuz kuralları ve hedefsiz klasörleri at
  cfg.folders = cfg.folders.map(f => ({
    id: f.id || newId(), target: String(f.target || '').trim(), enabled: f.enabled !== false,
    rules: (f.rules || []).filter(r => !r._remove)
      .map(r => ({ conds: r.conds.filter(c => String(c.value || '').trim()).map(c => ({ field: c.field, value: String(c.value).trim() })) }))
      .filter(r => r.conds.length),
  })).filter(f => f.target && f.rules.length);
  cfg.autoApply = !!cfg.autoApply;

  await window.api.saveRules(cfg);
  state.rules = cfg;
  toast(`⚙ ${cfg.folders.length} klasör için kurallar kaydedildi`);
  await load(state.dir);
}

// ---------- İlk açılış rehberi ----------
const TOUR = [
  { icon: '👋', title: 'Hoş geldin!',
    text: 'Masaüstü Düzenleyici, masaüstündeki dosyalara bakıp onları gruplar halinde önerir. Hangi grubun klasöre gideceğine sen karar verirsin, hiçbir şey sormadan taşınmaz.' },
  { icon: '☑️', title: 'Tikle ve klasörle',
    text: 'Kartın başlığındaki tik bütün grubu seçer, dosyaların yanındaki tiklerle tek tek çıkarabilirsin. Klasör adına tıklayıp değiştirebilir, dosyaları sürükleyip başka bir karta taşıyabilirsin. Sonra sağ alttaki “Seçilenleri klasörle”ye bas.' },
  { icon: '⭐', title: 'Kurallar ve öneriler',
    text: 'Bir kartın köşesindeki ⭐ ile o grubu kalıcı kural yaparsın; bir dahaki sefere kendiliğinden tikli gelir. “Kopyalar” ve “Eski dosyalar” sekmeleri, aynı içerikteki dosyaları ve uzun süredir dokunulmamış dosyaları önerir.' },
  { icon: '↶', title: 'Her şey geri alınabilir',
    text: '“Geçmiş / Geri al” ile istediğin işlemi, hatta tek bir klasörü eski haline döndürebilirsin. Klasörledikten sonra “Masaüstünü sırala” simgeleri düzenli dizer.' },
];

function openTour() {
  let i = 0;
  const overlay = el('div', { class: 'tour' });
  const card = el('div', { class: 'tour-card' });
  overlay.append(card);
  const close = () => { prefs.set('tourDone', true); overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && i < TOUR.length - 1) { i++; draw(); }
    else if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
  };
  function draw() {
    const s = TOUR[i];
    card.innerHTML = '';
    card.append(
      el('div', { class: 'tour-icon', text: s.icon }),
      el('h2', { text: s.title }),
      el('p', { text: s.text }),
      el('div', { class: 'tour-dots' }, TOUR.map((_, k) => el('span', { class: k === i ? 'on' : '', onclick: () => { i = k; draw(); } }))),
      el('div', { class: 'tour-actions' }, [
        el('button', { class: 'link', text: 'Geç', onclick: close }),
        el('div', { class: 'tour-nav' }, [
          i > 0 ? el('button', { class: 'ghost', text: 'Geri', onclick: () => { i--; draw(); } }) : null,
          el('button', { class: 'primary', text: i === TOUR.length - 1 ? 'Başlayalım' : 'İleri',
            onclick: () => { if (i === TOUR.length - 1) close(); else { i++; draw(); } } }),
        ]),
      ]),
    );
  }
  draw();
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

// ---------- Ayarlar ----------
async function openSettings() {
  let st = {};
  try { st = await window.api.getSettings(); } catch { /* tarayıcı önizlemesi */ }
  const row = (key, title, desc, disabled) => {
    const cb = el('input', { type: 'checkbox', class: 'check', checked: !!st[key], disabled: !!disabled,
      onchange: async (e) => { st = await window.api.setSettings({ [key]: e.target.checked }); } });
    return el('label', { class: 'opt-row' + (disabled ? ' disabled' : '') }, [cb, el('span', {}, [el('strong', { text: title }), el('small', { text: desc })])]);
  };
  const themeBtns = [['system', '🖥 Sistem'], ['light', '☀ Açık'], ['dark', '🌙 Koyu']].map(([id, label]) =>
    el('button', { class: 'seg' + ((st.theme || 'system') === id ? ' on' : ''), text: label, onclick: async (e) => {
      st = await window.api.setSettings({ theme: id });
      e.target.parentNode.querySelectorAll('.seg').forEach(b => b.classList.toggle('on', b === e.target));
    } }));
  const body = el('div', { class: 'settings' }, [
    el('h3', { text: 'Görünüm' }),
    el('div', { class: 'segmented' }, themeBtns),
    el('p', { class: 'muted small', text: 'Sistem seçiliyse Windows açık/karanlık moduna göre otomatik değişir.' }),
    el('h3', { text: 'Arka plan' }),
    row('background', 'Arka planda çalış', 'Pencereyi kapatınca uygulama saatin yanındaki simgede çalışmaya devam eder ve masaüstünü izler.'),
    row('notifyNew', 'Her yeni dosya için bildirim', 'Kapalıyken sadece kurallara göre otomatik taşıma olunca bildirim gelir. Açarsan masaüstüne gelen her yeni dosya için de haber verir.'),
    row('startWithWindows', 'Windows açılınca başlat', st.canAutostart === false
      ? 'Sadece kurulu uygulamada çalışır (npm start ile açıldığında kullanılamaz).'
      : 'Bilgisayar açılınca pencere açmadan arka planda başlar.', st.canAutostart === false),
    el('h3', { text: 'Yardım' }),
    el('button', { class: 'ghost', text: '▶ Tanıtımı tekrar göster', onclick: () => { $('#modalCancel').click(); openTour(); } }),
    el('p', { class: 'muted small', text: 'Masaüstü Düzenleyici · github.com/metehandghn/masaustu-duzenleyici' }),
  ]);
  await confirmBox('Ayarlar', body, 'Tamam');
}

// ---------- Masaüstünü sırala ----------
async function runArrange(mode, auto, quiet) {
  const label = (SORT_MODES.find(m => m[0] === mode) || SORT_MODES[0])[1].toLowerCase();
  if (!quiet) toast('Masaüstü sıralanıyor…');
  const btn = $('#btnArrange');
  btn.disabled = true;
  const res = await window.api.arrangeDesktop(mode, auto);
  btn.disabled = false;
  if (res.ok) toast(`▦ Masaüstü ${label} sıralandı`);
  else confirmBox('Masaüstü sıralanamadı', el('div', {}, [
    el('p', { text: 'Windows masaüstü simgelerine ulaşılamadı. Masaüstünde sağ tık → Sıralama ölçütü ile elle de sıralayabilirsin.' }),
    el('p', { class: 'err', text: res.error || '' }),
  ]), 'Tamam');
  return res.ok;
}

async function openArrange() {
  const current = prefs.get('sortMode', 'type');
  const radios = SORT_MODES.map(([id, title, desc]) => {
    const r = el('input', { type: 'radio', name: 'sortMode', value: id, checked: id === current });
    return { id, r, row: el('label', { class: 'opt-row radio' }, [r, el('span', {}, [el('strong', { text: title }), el('small', { text: desc })])]) };
  });
  // Kutunun ilk hali Windows'taki gerçek ayardan gelir; sen değiştirmezsen ayara dokunulmaz
  let winAuto;
  try { winAuto = await window.api.getAutoArrange(); } catch { winAuto = undefined; }
  let touched = false;
  const auto = el('input', { type: 'checkbox', class: 'check', checked: winAuto === true, onchange: () => { touched = true; } });
  const body = el('div', { class: 'arrange' }, [
    el('p', { text: 'Masaüstündeki simgeler, Windows\'un “Sıralama ölçütü” özelliğiyle düzenli dizilir. Dosyalara dokunulmaz, sadece yerleri değişir.' }),
    ...radios.map(x => x.row),
    el('label', { class: 'opt-row' }, [auto, el('span', {}, [el('strong', { text: 'Otomatik düzenle' }),
      el('small', { text: 'Windows\'un “Simgeleri otomatik düzenle” ayarı. Açıkken simgeler hep sıralı kalır ve yeni dosyalar her zaman görünür yerde çıkar; elle sürüklenemez.' })])]),
  ]);
  if (!(await confirmBox('Masaüstünü sırala', body, 'Sırala'))) return;
  const mode = (radios.find(x => x.r.checked) || radios[0]).id;
  const autoVal = touched ? (auto.checked ? 1 : 0) : -1; // dokunulmadıysa ayarı değiştirme
  prefs.set('sortMode', mode);
  await runArrange(mode, autoVal);
}

function showErrors(title, errors) {
  const ul = el('ul');
  errors.slice(0, 30).forEach(e => ul.append(el('li', {}, [el('strong', { text: e.file }), el('span', { class: 'err', text: e.message })])));
  confirmBox(title, el('div', {}, [el('p', { text: 'Açık olan veya erişim izni olmayan dosyalar taşınamamış olabilir.' }), ul]), 'Tamam');
}

// ---------- Olaylar ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  state.filter = t.dataset.filter;
  render();
}));
$('#selAll').addEventListener('click', () => { visibleGroups().filter(g => g.kind !== 'rest').forEach(g => state.enabled.add(g.id)); render(); });
$('#selNone').addEventListener('click', () => { state.enabled.clear(); render(); });
$('#btnApply').addEventListener('click', applySelected);
$('#btnHelp').addEventListener('click', openSettings);
$('#btnRules').addEventListener('click', () => openRules());
$('#btnArrange').addEventListener('click', openArrange);
$('#btnUndo').addEventListener('click', openHistory);
$('#btnScan').addEventListener('click', () => load(state.dir));
$('#btnFolder').addEventListener('click', async () => {
  const d = await window.api.chooseFolder();
  if (d) load(d);
});
$('#dirLabel').addEventListener('dblclick', () => window.api.openFolder(state.dir));

// Pencereye dışarıdan dosya bırakılırsa sayfa değişmesin
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

if (window.api.onRescan) window.api.onRescan(() => state.dir && load(state.dir, { quiet: true }));
if (window.api.onDesktopChanged) window.api.onDesktopChanged((n) => {
  if (!isDesktop()) return;
  if (!state.enabled.size || [...state.enabled].every(id => id.startsWith('r'))) load(state.dir, { quiet: true });
  else toast(`Masaüstüne ${n} yeni dosya geldi. Listeye eklemek için “Yeniden tara”ya bas.`);
});

window.api.getDesktop().then(async d => {
  state.desktop = d;
  await load(d);
  if (!prefs.get('tourDone', false)) openTour();
});
