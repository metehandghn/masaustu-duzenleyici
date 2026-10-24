// Arayüz mantığı
const $ = (s) => document.querySelector(s);
const PREVIEW = 6; // kartta ilk kaç dosya görünsün
const KIND_LABEL = { name: 'Benzer isim', type: 'Dosya türü', nametype: 'Tür + isim', custom: 'Senin grubun', existing: 'Var olan klasör' };
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
};

// Kullanıcı tercihleri (sıralama biçimi vb.) — sadece bu bilgisayarda saklanır
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('pref:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pref:' + k, JSON.stringify(v)); } catch { /* yoksay */ } },
};
const SORT_MODES = [
  ['type', 'Türe göre', 'Klasörler önce, sonra aynı türdeki dosyalar yan yana'],
  ['name', 'Ada göre', 'Alfabetik sıra'],
  ['date', 'Tarihe göre', 'En son değişenler önce'],
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
    if (!g) continue;
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
function renderCard(g, owner) {
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
        readOnly: g.kind === 'existing',
        title: g.kind === 'existing' ? 'Bu klasör zaten var, dosyalar içine eklenecek' : 'Klasör adını değiştirmek için tıkla',
        oninput: (e) => { g.folderName = e.target.value; },
        onchange: () => render(), // diğer kartlardaki "→ klasör" yazıları güncellensin
      }),
      el('div', { class: 'meta' }, [
        el('span', { class: 'badge ' + g.kind, text: KIND_LABEL[g.kind] }),
        el('span', { text: g.kind === 'existing' ? `+${going} yeni` : `${going}/${g.files.length} dosya` }),
        g.kind === 'existing' ? el('span', { class: 'in-folder', title: `Klasörde şu an ${g.existingCount} dosya var`, text: `📁 ${g.existingCount} dosya` }) : null,
      ]),
    ]),
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
  return state.groups.filter(g => state.filter === 'all' || g.kind === state.filter || g.kind === 'custom');
}

function render() {
  const box = $('#groups');
  const scroll = box.scrollTop;
  box.innerHTML = '';
  const vis = visibleGroups();
  const owner = assignment();

  const count = (k) => state.groups.filter(g => g.kind === k).length;
  $('#cAll').textContent = state.groups.length;
  $('#cName').textContent = count('name');
  $('#cType').textContent = count('type');
  $('#cNameType').textContent = count('nametype');
  $('#cExisting').textContent = count('existing');

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

async function load(dir) {
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
  const { groups } = Grouping.buildGroups(state.files);
  const existing = Grouping.matchExisting(state.files, folders);
  state.groups = [...existing, ...groups];
  const inAny = new Set(state.groups.flatMap(g => g.files.map(f => f.name)));
  state.ungrouped = state.files.filter(f => !inAny.has(f.name));
  if (existing.length) {
    const n = existing.reduce((t, g) => t + g.files.length, 0);
    setTimeout(() => toast(`${n} dosya, var olan ${existing.length} klasöre eklenebilir`), 300);
  }
  state.enabled.clear();
  state.unchecked.clear();
  state.expanded.clear();
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
    files: filesGoingTo(g, owner).map(f => f.name),
  })));
  await load(state.dir);
  if (res.errors.length) showErrors(`${res.moved} dosya taşındı, ${res.errors.length} dosyada sorun çıktı`, res.errors);
  else toast(`✓ ${res.moved} dosya ${chosen.length} klasöre yerleştirildi`);
  if (arrangeAfter && res.moved) await runArrange(prefs.get('sortMode', 'type'), prefs.get('autoArrange', -1), true);
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

  const picks = new Map(); // klasör yolu -> { id, checkbox }
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
      picks.set(f.path, { id: h.id, cb });
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
    const n = [...picks.values()].filter(p => p.cb.checked).length;
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
  for (const [folder, p] of picks) if (p.cb.checked) (byId[p.id] = byId[p.id] || []).push(folder);
  if (!Object.keys(byId).length) return;

  toast('Geri alınıyor…');
  const res = await window.api.undoSelected(byId);
  await load(state.dir);
  if (res.errors.length) showErrors(`${res.restored} dosya geri taşındı, ${res.errors.length} dosyada sorun çıktı`, res.errors);
  else if (res.leftDirs && res.leftDirs.length) toast(`↶ ${res.restored} dosya döndü. İçinde başka dosya olduğu için silinmeyen klasör: ${res.leftDirs.join(', ')}`);
  else toast(`↶ ${res.restored} dosya eski yerine döndü`);
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
  const auto = el('input', { type: 'checkbox', class: 'check', checked: prefs.get('autoArrange', -1) === 1 });
  const body = el('div', { class: 'arrange' }, [
    el('p', { text: 'Masaüstündeki simgeler, Windows\'un “Sıralama ölçütü” özelliğiyle düzenli dizilir. Dosyalara dokunulmaz, sadece yerleri değişir.' }),
    ...radios.map(x => x.row),
    el('label', { class: 'opt-row' }, [auto, el('span', {}, [el('strong', { text: 'Otomatik düzenle' }), el('small', { text: 'Simgeler hep sıralı kalsın, elle sürüklenemesin' })])]),
  ]);
  if (!(await confirmBox('Masaüstünü sırala', body, 'Sırala'))) return;
  const mode = (radios.find(x => x.r.checked) || radios[0]).id;
  const autoVal = auto.checked ? 1 : 0;
  prefs.set('sortMode', mode);
  prefs.set('autoArrange', autoVal);
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
$('#selAll').addEventListener('click', () => { visibleGroups().forEach(g => state.enabled.add(g.id)); render(); });
$('#selNone').addEventListener('click', () => { state.enabled.clear(); render(); });
$('#btnApply').addEventListener('click', applySelected);
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

window.api.getDesktop().then(d => { state.desktop = d; load(d); });
