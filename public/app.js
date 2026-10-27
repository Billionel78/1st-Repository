'use strict';

/* =====================================================================
 * ICE MANAGER – interface web (application monopage, sans dépendance)
 * ===================================================================== */

const state = {
  user: null,
  settings: { bar_name: 'ICE MANAGER', currency: 'FCFA' },
  activeTable: null, // { id, name } : table sur laquelle on ajoute des articles
  backdate: null, // mode rattrapage : journée passée (AAAA-MM-JJ) à laquelle les ventes sont enregistrées
  refreshTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------- Utilitaires ---------- */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = new Intl.NumberFormat('fr-FR');
const money = (n) => `${nf.format(n || 0)} ${state.settings.currency}`;
const isAdmin = () => state.user?.role === 'admin';

function pad(n) { return String(n).padStart(2, '0'); }
function isoDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(iso, n) { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return isoDate(d); }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function fmtDateTime(s) { return s ? `${fmtDate(s)} ${s.slice(11, 16)}` : ''; }
function fmtTime(s) { return s ? s.slice(11, 16) : ''; }
function longDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const STATUS = {
  open: ['En attente de paiement', 'badge-open'],
  paid: ['Payée', 'badge-paid'],
  cancelled: ['Annulée', 'badge-cancelled'],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s][1]}">${STATUS[s][0]}</span>`;
const METHOD_TYPES = { cash: 'Espèces', mobile_money: 'Mobile Money', other: 'Autre' };

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(state.backdate && isAdmin() ? { 'X-Ice-Date': state.backdate } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Connexion au serveur impossible. Vérifiez le réseau.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/auth/login') showLogin();
    throw new ApiError(res.status, data?.error || `Erreur ${res.status}`);
  }
  return data;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 3200);
}

/* ---------- Modale ---------- */
function openModal({ title, body, foot = '', wide = false, onClose }) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <h2 id="modal-title">${title}</h2>
          <button class="btn btn-ghost btn-icon" type="button" data-close aria-label="Fermer">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>
    </div>`;
  const backdrop = $('.modal-backdrop', root);
  const modal = $('.modal', root);
  modal._onClose = onClose;
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeModal(); });
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
  return modal;
}
function closeModal() {
  const modal = $('#modal-root .modal');
  if (modal?._onClose) modal._onClose();
  $('#modal-root').innerHTML = '';
}
const modalOpen = () => !!$('#modal-root .modal');
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen()) closeModal(); });

function confirmModal(title, message, { confirmLabel = 'Confirmer', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title: esc(title),
      body: `<p>${message}</p>`,
      foot: `<button class="btn" data-close>Annuler</button>
             <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    $('[data-ok]', modal).addEventListener('click', () => { answered = true; closeModal(); resolve(true); });
  });
}

/**
 * Formulaire générique dans une modale.
 * fields: [{ name, label, type: text|number|password|select|checkbox|color, value, options, required, min, hint }]
 */
/* ---------- Photos des produits : lecture, cadrage automatique, éditeur de cadrage ---------- */
const PHOTO_SIZE = 600; // photo enregistrée : carré de 600 × 600 px, comme le cadre des cartes produit
const PHOTO_MARGIN = 0.07; // marge autour du produit en mode « Ajuster »

/**
 * Lit une photo, fichier choisi ou photo déjà enregistrée (adresse du site), et la réduit à 1600 px.
 * Un fichier est lu en « data URL », autorisée par la politique de sécurité des pages.
 */
async function loadPhoto(fileOrUrl) {
  let source = fileOrUrl;
  if (typeof fileOrUrl !== 'string') {
    if (!/^image\//.test(fileOrUrl.type)) throw new Error('Choisissez un fichier image (JPEG, PNG, WebP…).');
    source = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Impossible de lire cette image.'));
      reader.readAsDataURL(fileOrUrl);
    });
  }
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Impossible de lire cette image.'));
    el.src = source;
  });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Zone utile de la photo : on retire les bords unis (fond blanc, fond uni ou transparent) pour que
 * le produit remplisse le cadre. Une photo prise dans un décor garde son cadrage d'origine.
 */
function detectContent(photo) {
  const scale = Math.min(1, 300 / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * scale));
  const h = Math.max(1, Math.round(photo.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const px = (x, y) => data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4);
  // Couleur du fond : moyenne des quatre coins.
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const bg = [0, 1, 2, 3].map((i) => corners.reduce((sum, c4) => sum + c4[i], 0) / 4);
  const isBackground = (p) => (bg[3] < 40 ? p[3] < 40
    : Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) < 60 || p[3] < 40);
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isBackground(px(x, y))) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const full = { x: 0, y: 0, w: photo.width, h: photo.height };
  if (maxX < 0) return full; // image vide ou entièrement unie
  const box = { x: minX / scale, y: minY / scale, w: (maxX - minX + 1) / scale, h: (maxY - minY + 1) / scale };
  // Presque toute l'image (photo dans un décor) : pas de recadrage.
  return box.w * box.h > photo.width * photo.height * 0.92 ? full : box;
}

/**
 * Éditeur de cadrage dans un cadre carré : « Ajuster » (produit entier, centré), « Remplir le cadre »,
 * zoom et déplacement à la souris ou au doigt. Ce qui est affiché est exactement ce qui est enregistré.
 */
function createPhotoEditor(container, photo) {
  const content = detectContent(photo);
  container.innerHTML = `
    <div class="photo-editor">
      <div class="photo-editor-frame">
        <canvas class="photo-editor-canvas" width="${PHOTO_SIZE}" height="${PHOTO_SIZE}"
          aria-label="Cadrage de la photo : faites glisser pour déplacer"></canvas>
      </div>
      <div class="photo-editor-tools">
        <div class="seg" role="group" aria-label="Disposition">
          <button type="button" data-fit="contain" class="active">Ajuster</button>
          <button type="button" data-fit="cover">Remplir le cadre</button>
        </div>
        <label class="photo-zoom">Zoom
          <input type="range" min="50" max="300" step="1" value="100" aria-label="Zoom">
        </label>
        <span class="muted small">Faites glisser la photo pour la centrer.</span>
      </div>
    </div>`;
  const canvas = $('canvas', container);
  const ctx = canvas.getContext('2d');
  const zoom = $('input[type=range]', container);
  const view = { mode: 'contain', base: 1, zoom: 1, x: 0, y: 0 };

  function frame(mode) {
    view.mode = mode;
    view.zoom = 1;
    zoom.value = 100;
    if (mode === 'contain') {
      // La zone utile tient dans le cadre, avec une petite marge, centrée.
      view.base = (PHOTO_SIZE * (1 - 2 * PHOTO_MARGIN)) / Math.max(content.w, content.h);
      view.x = PHOTO_SIZE / 2 - (content.x + content.w / 2) * view.base;
      view.y = PHOTO_SIZE / 2 - (content.y + content.h / 2) * view.base;
    } else {
      // La photo entière couvre le cadre, centrée.
      view.base = PHOTO_SIZE / Math.min(photo.width, photo.height);
      view.x = (PHOTO_SIZE - photo.width * view.base) / 2;
      view.y = (PHOTO_SIZE - photo.height * view.base) / 2;
    }
    $$('[data-fit]', container).forEach((b) => b.classList.toggle('active', b.dataset.fit === mode));
    draw();
  }

  function draw() {
    const s = view.base * view.zoom;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photo, view.x, view.y, photo.width * s, photo.height * s);
  }

  // Zoom autour du centre du cadre.
  zoom.addEventListener('input', () => {
    const before = view.base * view.zoom;
    view.zoom = Number(zoom.value) / 100;
    const after = view.base * view.zoom;
    const c = PHOTO_SIZE / 2;
    view.x = c - ((c - view.x) * after) / before;
    view.y = c - ((c - view.y) * after) / before;
    draw();
  });
  $$('[data-fit]', container).forEach((b) => b.addEventListener('click', () => frame(b.dataset.fit)));

  // Déplacement (souris, doigt, stylet).
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const ratio = PHOTO_SIZE / canvas.getBoundingClientRect().width;
    view.x = drag.ox + (e.clientX - drag.x) * ratio;
    view.y = drag.oy + (e.clientY - drag.y) * ratio;
    draw();
  });
  const stop = () => { drag = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  frame('contain');
  return {
    /** Photo cadrée : WebP (ou JPEG si le navigateur ne sait pas produire de WebP). */
    export() {
      const webp = canvas.toDataURL('image/webp', 0.85);
      return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
    },
  };
}

function formModal({ title, fields, submitLabel = 'Enregistrer', onSubmit }) {
  const fieldHtml = (f) => {
    const id = `f-${f.name}`;
    if (f.type === 'image') {
      return `<div class="image-field" data-image-field="${f.name}">
        <span class="field-label">${esc(f.label)}</span>
        <div class="image-field-row">
          <div class="image-preview" aria-live="polite">${f.value ? `<img src="${esc(f.value)}" alt="">` : '<span aria-hidden="true">📷</span>'}</div>
          <div class="image-editor-slot" hidden></div>
          <div class="image-actions">
            <label class="btn btn-sm" for="${id}">${f.value ? 'Changer la photo' : 'Choisir une photo'}</label>
            <input type="file" id="${id}" accept="image/*" hidden>
            <button type="button" class="btn btn-sm" data-image-reframe ${f.value ? '' : 'hidden'}>Recadrer</button>
            <button type="button" class="btn btn-sm btn-ghost" data-image-clear ${f.value ? '' : 'hidden'}>Retirer la photo</button>
            ${f.hint ? `<span class="muted small">${esc(f.hint)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }
    if (f.type === 'checkbox') {
      return `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    }
    if (f.type === 'select') {
      return `<label for="${id}">${esc(f.label)}
        <select id="${id}" name="${f.name}" ${f.required ? 'required' : ''}>
          ${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></label>`;
    }
    return `<label for="${id}">${esc(f.label)}
      <input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}"
        ${f.required ? 'required' : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.type === 'number' ? 'step="1" inputmode="numeric"' : ''}
        ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''} ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}>
      ${f.hint ? `<span class="muted small">${esc(f.hint)}</span>` : ''}</label>`;
  };
  const modal = openModal({
    title: esc(title),
    body: `<form class="form-grid" id="modal-form" novalidate>${fields.map(fieldHtml).join('')}<p class="form-error" id="modal-error"></p></form>`,
    foot: `<button class="btn" data-close type="button">Annuler</button>
           <button class="btn btn-primary" type="submit" form="modal-form">${esc(submitLabel)}</button>`,
  });
  const form = $('#modal-form', modal);
  // Champs photo : { url } = photo actuelle (ou null) ; { editor } = nouvelle photo en cours de cadrage.
  const images = {};
  for (const f of fields.filter((x) => x.type === 'image')) {
    const box = $(`[data-image-field="${f.name}"]`, form);
    const photo = { url: f.value || null, editor: null };
    images[f.name] = photo;
    const preview = $('.image-preview', box);
    const editorBox = $('.image-editor-slot', box);
    const clear = $('[data-image-clear]', box);
    const reframe = $('[data-image-reframe]', box);
    const label = $('label.btn', box);
    const edit = async (source) => {
      try {
        const picture = await loadPhoto(source);
        preview.hidden = true;
        editorBox.hidden = false;
        photo.editor = createPhotoEditor(editorBox, picture);
        clear.hidden = false;
        reframe.hidden = true;
        $('#modal-error', modal).textContent = '';
      } catch (err) {
        $('#modal-error', modal).textContent = err.message;
      }
    };
    const show = (src) => {
      photo.editor = null;
      reframe.hidden = !src;
      editorBox.innerHTML = '';
      editorBox.hidden = true;
      preview.hidden = false;
      preview.innerHTML = src ? `<img src="${esc(src)}" alt="">` : '<span aria-hidden="true">📷</span>';
      clear.hidden = !src;
      label.textContent = src ? 'Changer la photo' : 'Choisir une photo';
    };
    $('input[type=file]', box).addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      label.textContent = 'Choisir une autre photo';
      await edit(file);
    });
    reframe.addEventListener('click', () => edit(photo.url));
    clear.addEventListener('click', () => {
      photo.url = null;
      show(null);
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      if (f.type === 'image') {
        const photo = images[f.name];
        values[f.name] = { url: photo.url, pending: photo.editor ? photo.editor.export() : null };
        continue;
      }
      const input = form.elements[f.name];
      if (f.type === 'checkbox') values[f.name] = input.checked;
      else if (f.type === 'number') values[f.name] = input.value === '' ? undefined : Number(input.value);
      else values[f.name] = input.value.trim();
      if (f.required && (values[f.name] === '' || values[f.name] === undefined)) {
        $('#modal-error', modal).textContent = `Le champ « ${f.label} » est obligatoire.`;
        input.focus();
        return;
      }
    }
    const btn = $('button[type=submit]', modal);
    btn.disabled = true;
    try {
      await onSubmit(values);
      closeModal();
    } catch (err) {
      $('#modal-error', modal).textContent = err.message;
      btn.disabled = false;
    }
  });
  setTimeout(() => form.querySelector('input:not([type=checkbox]):not([type=file]), select')?.focus(), 30);
  return modal;
}

/* ---------- Session ---------- */
function showLogin() {
  state.user = null;
  stopRefresh();
  closeModal();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form [name=password]').value = '';
  setTimeout(() => $('#login-form [name=username]').focus(), 30);
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#bar-name').textContent = state.settings.bar_name;
  document.title = state.settings.bar_name;
  $('#user-name').textContent = state.user.full_name;
  $('#user-role').textContent = `${state.user.username} · ${state.user.role === 'admin' ? 'Responsable' : 'Serveur'}`;
  $('#menu-backdate').hidden = !isAdmin();
  try { state.backdate = isAdmin() ? sessionStorage.getItem('ice-backdate') : null; } catch { state.backdate = null; }
  if (state.backdate) historyState.date = state.backdate;
  renderBackdateBanner();
  renderNav();
  route();
}

/* ---------- Mode rattrapage (ventes passées) ---------- */
function setBackdate(date) {
  state.backdate = date;
  try {
    if (date) sessionStorage.setItem('ice-backdate', date);
    else sessionStorage.removeItem('ice-backdate');
  } catch { /* stockage indisponible : le mode reste actif jusqu'au rechargement */ }
  if (date) historyState.date = date;
  renderBackdateBanner();
  route();
}

function renderBackdateBanner() {
  const banner = $('#backdate-banner');
  document.body.classList.toggle('backdating', !!state.backdate);
  banner.hidden = !state.backdate;
  if (!state.backdate) return;
  banner.innerHTML = `
    <span>🕘 <strong>Mode rattrapage</strong> : les ventes sont enregistrées au <strong>${esc(longDate(state.backdate))}</strong>.</span>
    <span class="backdate-actions">
      <button class="btn btn-sm" type="button" data-backdate-change>Changer la date</button>
      <button class="btn btn-sm btn-primary" type="button" data-backdate-stop>Terminer le rattrapage</button>
    </span>`;
  $('[data-backdate-change]', banner).addEventListener('click', openBackdateModal);
  $('[data-backdate-stop]', banner).addEventListener('click', () => {
    setBackdate(null);
    toast('Rattrapage terminé : les ventes sont de nouveau enregistrées à la date du jour.', 'ok');
  });
}

function openBackdateModal() {
  const yesterday = addDays(isoDate(), -1);
  const oldest = addDays(isoDate(), -365);
  formModal({
    title: 'Saisir des ventes passées',
    fields: [{
      name: 'date', label: 'Journée à rattraper', type: 'date', required: true,
      value: state.backdate || yesterday, min: oldest, max: yesterday,
      hint: 'Tant que le mode rattrapage est actif, les commandes, paiements et sorties de stock sont enregistrés à cette date. Saisissez les ventes comme d’habitude, en les encaissant.',
    }],
    submitLabel: 'Commencer le rattrapage',
    onSubmit: async (v) => {
      if (!v.date || v.date > yesterday || v.date < oldest) throw new Error('Choisissez une journée passée (un an maximum).');
      setBackdate(v.date);
      toast(`Rattrapage du ${fmtDate(v.date)} : saisissez les ventes comme d’habitude.`, 'ok');
    },
  });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  $('#login-error').textContent = '';
  const btn = $('button', form);
  btn.disabled = true;
  try {
    await api('POST', '/api/auth/login', { username: form.username.value.trim(), password: form.password.value });
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    state.settings = me.settings;
    if (!location.hash || location.hash === '#') location.hash = '#/';
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#user-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#user-menu').hidden = !$('#user-menu').hidden;
});
// Un clic ailleurs ferme les menus déroulants.
document.addEventListener('click', () => { $$('.user-menu').forEach((m) => { m.hidden = true; }); });
$('#user-menu').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (action === 'backdate') {
    openBackdateModal();
  } else if (action === 'logout') {
    await api('POST', '/api/auth/logout').catch(() => {});
    state.activeTable = null;
    setBackdate(null);
    showLogin();
  } else if (action === 'password') {
    formModal({
      title: 'Changer mon mot de passe',
      fields: [
        { name: 'current_password', label: 'Mot de passe actuel', type: 'password', required: true, autocomplete: 'current-password' },
        { name: 'new_password', label: 'Nouveau mot de passe', type: 'password', required: true, autocomplete: 'new-password', hint: 'Au moins 6 caractères.' },
        { name: 'confirm', label: 'Confirmer le nouveau mot de passe', type: 'password', required: true, autocomplete: 'new-password' },
      ],
      onSubmit: async (v) => {
        if (v.new_password !== v.confirm) throw new Error('Les deux mots de passe ne correspondent pas.');
        await api('POST', '/api/auth/password', v);
        toast('Mot de passe modifié.', 'ok');
      },
    });
  }
});

setInterval(() => {
  const d = new Date();
  $('#clock').textContent = `${d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}, 1000);

/* ---------- Navigation ---------- */
const NAV = [
  { href: '#/', icon: '🏠', label: 'Accueil', match: /^#\/(famille\/\d+)?$/ },
  { href: '#/tables', icon: '🪑', label: 'Tables', match: /^#\/tables/ },
  { href: '#/commandes', icon: '🧾', label: 'Commandes', short: 'Cmdes', match: /^#\/commande/, badge: 'open-count' },
  { href: '#/historique', icon: '📅', label: 'Historique', short: 'Histo.', match: /^#\/historique/ },
  { href: '#/statistiques', icon: '📊', label: 'Statistiques', short: 'Stats', match: /^#\/statistiques/, admin: true },
  { href: '#/stock', icon: '📦', label: 'Stock', match: /^#\/stock/, admin: true, badge: 'stock-alerts' },
  { href: '#/gestion', icon: '⚙️', label: 'Gestion', match: /^#\/gestion/, admin: true },
];

function renderNav() {
  $('#nav').innerHTML = NAV.filter((n) => !n.admin || isAdmin()).map((n) => `
    <a href="${n.href}" data-match="${n.match.source}">
      <span class="ico" aria-hidden="true">${n.icon}</span><span class="nav-label">${n.label}</span>
      <span class="nav-short" aria-hidden="true">${n.short ?? n.label}</span>
      ${n.badge ? `<span class="badge badge-count" id="${n.badge}" hidden></span>` : ''}
    </a>`).join('');
}

function highlightNav() {
  const hash = location.hash || '#/';
  $$('#nav a').forEach((a) => a.classList.toggle('active', new RegExp(a.dataset.match).test(hash)));
}

function setBadge(id, n) {
  const el = $(`#${id}`);
  if (!el) return;
  el.hidden = !n;
  el.textContent = n;
}

function setOpenCount(n) {
  const el = $('#open-count');
  if (!el) return;
  el.hidden = !n;
  el.textContent = n;
}

const ROUTES = [
  [/^#\/?$/, (m, seq) => renderHome(m, seq)],
  [/^#\/famille\/(\d+)$/, (m, seq) => renderFamily(Number(m[1]), seq)],
  [/^#\/tables$/, (m, seq) => renderTables(m, seq)],
  [/^#\/commandes$/, (m, seq) => renderOrders(m, seq)],
  [/^#\/commande\/(\d+)$/, (m, seq) => renderOrder(Number(m[1]), seq)],
  [/^#\/historique$/, (m, seq) => renderHistory(m, seq)],
  [/^#\/statistiques$/, (m, seq) => renderStats(m, seq), true],
  [/^#\/stock$/, (m, seq) => renderStock(m, seq), true],
  [/^#\/gestion(?:\/(\w+))?$/, (m, seq) => renderAdmin(m[1] || 'produits', seq), true],
];

let renderSeq = 0;
async function route() {
  if (!state.user) return;
  closeModal();
  stopRefresh();
  highlightNav();
  const hash = location.hash || '#/';
  const view = $('#view');
  const seq = ++renderSeq;
  for (const [re, fn, adminOnly] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    if (adminOnly && !isAdmin()) break;
    view.innerHTML = '<div class="spinner" aria-label="Chargement"></div>';
    try {
      await fn(m, seq);
    } catch (err) {
      if (seq === renderSeq && err.status !== 401) {
        view.innerHTML = `<div class="empty">⚠️ ${esc(err.message)}<br><br><a class="btn" href="#/">Retour à l'accueil</a></div>`;
      }
    }
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

/** Rafraîchit périodiquement la vue courante (plusieurs appareils en service). */
function autoRefresh(fn, ms = 15000) {
  stopRefresh();
  state.refreshTimer = setInterval(() => {
    if (document.hidden || modalOpen()) return;
    fn().catch(() => {});
  }, ms);
}
function stopRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

/* ---------- Composants ---------- */
function activeTableBanner() {
  if (!state.activeTable) return '';
  return `<div class="banner" id="active-table-banner">
    <span>🪑 Commande en cours de saisie pour <strong>${esc(state.activeTable.name)}</strong></span>
    <span class="spacer"></span>
    ${state.activeTable.orderId ? `<a class="btn btn-sm" href="#/commande/${state.activeTable.orderId}">Voir la commande</a>` : ''}
    <button class="btn btn-sm" type="button" data-clear-table>Terminer</button>
  </div>`;
}
function bindBanner(root) {
  $('[data-clear-table]', root)?.addEventListener('click', () => {
    state.activeTable = null;
    $('#active-table-banner')?.remove();
  });
}

function familyTile(f) {
  return `<a class="tile tile-family" href="#/famille/${f.id}" style="background:${esc(f.color)}">
    <span class="tile-icon" aria-hidden="true">${esc(f.icon)}</span>
    <span><span class="tile-name">${esc(f.name)}</span><br>
    <span class="tile-meta">${f.product_count} produit${f.product_count > 1 ? 's' : ''}</span></span>
  </a>`;
}

function orderCard(o) {
  return `<a class="order-card" href="#/commande/${o.id}">
    <div class="row"><span class="table-name">${esc(o.table_name)}</span><span class="spacer"></span>${statusBadge(o.status)}</div>
    <div class="muted small">${esc(o.number)} · ouverte à ${fmtTime(o.created_at)}</div>
    <div class="small">${o.items.map((i) => `${i.quantity} × ${esc(i.product_name)}`).join(', ') || '<span class="muted">Aucun article</span>'}</div>
    <div class="row"><span class="muted small">Reste à payer</span><span class="spacer"></span><span class="amount">${money(o.remaining)}</span></div>
    ${o.paid_amount > 0 ? `<div class="muted small">Déjà payé : ${money(o.paid_amount)} sur ${money(o.total)}</div>` : ''}
  </a>`;
}

function barList(rows, { label, value, format = (v) => nf.format(v), title }) {
  if (!rows.length) return '<p class="muted">Aucune donnée pour cette période.</p>';
  const max = Math.max(...rows.map(value), 1);
  return `<div class="bars">${rows.map((r) => {
    const v = value(r);
    return `<div class="bar-row" title="${esc(title ? title(r) : `${label(r)} : ${format(v)}`)}">
      <span class="bar-label">${esc(label(r))}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(v / max) * 100}%"></span></span>
      <span class="bar-value">${format(v)}</span>
    </div>`;
  }).join('')}</div>`;
}

function kpi(label, value, sub = '', accent = false) {
  return `<div class="kpi ${accent ? 'accent' : ''}"><div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

/* =====================================================================
 * Accueil / tableau de bord
 * ===================================================================== */
async function renderHome(m, seq) {
  const [dash, families, open] = await Promise.all([
    api('GET', '/api/dashboard'),
    api('GET', '/api/families'),
    api('GET', '/api/orders?status=open'),
  ]);
  if (seq !== renderSeq) return;
  setOpenCount(open.length);
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Tableau de bord</h1><div class="muted">${esc(longDate(dash.date))}</div></div>
      <div class="actions"><a class="btn" href="#/tables">🪑 Voir les tables</a></div>
    </div>
    <div id="home-kpis"></div>
    <div class="section">
      ${activeTableBanner()}
      <h2>🍹 Prendre une commande</h2>
      ${families.length ? `<div class="tiles">${families.map(familyTile).join('')}</div>`
        : `<div class="empty">Aucune famille de produits. ${isAdmin() ? '<a href="#/gestion/familles">Créer une famille</a>' : ''}</div>`}
    </div>
    <div class="section">
      <h2>🧾 Commandes en attente de paiement <span class="badge badge-open" id="home-open-count"></span></h2>
      <div id="home-open"></div>
    </div>
    <div class="section" id="home-top"></div>`;
  view.querySelector('.section').insertAdjacentHTML('beforebegin', '<div id="home-stock"></div>');
  bindBanner(view);

  const paint = (d, orders) => {
    $('#home-kpis').innerHTML = `<div class="kpis">
      ${kpi(state.backdate ? `Encaissé le ${fmtDate(d.date)}` : 'Encaissé aujourd’hui', money(d.collected), `${d.orders_paid} commande(s) payée(s)`, true)}
      ${kpi('Espèces (Cash)', money(d.by_type.cash))}
      ${kpi('Mobile Money', money(d.by_type.mobile_money))}
      ${d.by_type.other ? kpi('Autres paiements', money(d.by_type.other)) : ''}
      ${kpi('Commandes ouvertes', d.open_orders.count, `${money(d.open_orders.remaining)} à encaisser`)}
      ${kpi('Commandes du jour', d.orders_created)}
    </div>`;
    $('#home-open-count').textContent = orders.length;
    $('#home-open').innerHTML = orders.length
      ? `<div class="orders-grid">${orders.map(orderCard).join('')}</div>`
      : '<div class="empty">Aucune commande en attente. 👍</div>';
    setBadge('stock-alerts', d.low_stock.length);
    $('#home-stock').innerHTML = d.low_stock.length ? `<div class="banner banner-warn section">
      <span>⚠️ <strong>Stock bas :</strong> ${d.low_stock.map((p) => `${esc(p.name)} (${Math.max(p.free, 0)})`).join(', ')}</span>
      ${isAdmin() ? '<span class="spacer"></span><a class="btn btn-sm" href="#/stock">Gérer le stock</a>' : ''}
    </div>` : '';
    $('#home-top').innerHTML = d.top_products.length ? `
      <h2>🏆 Produits les plus vendus ${state.backdate ? `le ${fmtDate(d.date)}` : 'aujourd’hui'}</h2>
      <div class="card">${barList(d.top_products, { label: (p) => p.product_name, value: (p) => p.quantity,
        title: (p) => `${p.product_name} : ${p.quantity} vendu(s) – ${money(p.amount)}` })}</div>` : '';
    setOpenCount(orders.length);
  };
  paint(dash, open);
  autoRefresh(async () => {
    const [d, o] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/orders?status=open')]);
    if (seq === renderSeq) paint(d, o);
  });
}

/* =====================================================================
 * Famille → produits → table → quantité → validation
 * ===================================================================== */
// Photo introuvable (supprimée, hors ligne) : on affiche une icône à la place d'une image cassée.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.closest('.product-photo, .thumb, .image-preview')) {
    img.replaceWith(Object.assign(document.createElement('span'), { className: 'product-photo-icon', textContent: '📷' }));
  }
}, true);

/** Photo d'un produit, ou l'icône de sa famille quand il n'en a pas. */
function productPhoto(p, fallbackIcon = '🍹') {
  return p.image_url
    ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">`
    : `<span class="product-photo-icon" aria-hidden="true">${esc(fallbackIcon)}</span>`;
}

async function renderFamily(familyId, seq) {
  const [families, products] = await Promise.all([
    api('GET', '/api/families'),
    api('GET', `/api/products?family_id=${familyId}`),
  ]);
  if (seq !== renderSeq) return;
  const family = families.find((f) => f.id === familyId);
  if (!family) throw new Error('Famille introuvable.');
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head">
      <div class="row"><a class="btn btn-icon" href="#/" aria-label="Retour">←</a>
        <h1><span aria-hidden="true">${esc(family.icon)}</span> ${esc(family.name)}</h1></div>
    </div>
    <nav class="family-tabs" aria-label="Familles">
      ${families.map((f) => `<a href="#/famille/${f.id}" class="${f.id === familyId ? 'active' : ''}"
        ${f.id === familyId ? `style="background:${esc(f.color)}"` : ''}>${esc(f.icon)} ${esc(f.name)}</a>`).join('')}
    </nav>
    ${activeTableBanner()}
    ${products.length ? `<div class="tiles" id="products">${products.map((p) => {
      const free = p.track_stock ? p.stock - p.reserved : null;
      const disabled = !p.available || (free !== null && free <= 0);
      return `<button class="tile tile-product ${disabled ? 'disabled' : ''}" type="button" data-id="${p.id}" ${disabled ? 'aria-disabled="true"' : ''}>
        <span class="product-photo">${productPhoto(p, family.icon)}
          ${free !== null ? `<span class="badge tile-stock ${free <= 5 ? 'badge-open' : ''}">Stock : ${free}</span>` : ''}</span>
        <span class="tile-name">${esc(p.name)}</span>
        ${p.format ? `<span class="tile-format">Format : ${esc(p.format)}</span>` : ''}
        <span class="tile-bottom">${!p.available ? '<span class="badge badge-cancelled">Indisponible</span>'
          : free !== null && free <= 0 ? '<span class="badge badge-cancelled">Rupture</span>'
          : `<span class="tile-price">${money(p.price)}</span>`}</span>
      </button>`;
    }).join('')}</div>`
    : `<div class="empty">Aucun produit dans cette famille. ${isAdmin() ? '<a href="#/gestion/produits">Ajouter des produits</a>' : ''}</div>`}`;
  bindBanner(view);
  $$('#products .tile', view).forEach((btn) => btn.addEventListener('click', () => {
    const p = products.find((x) => x.id === Number(btn.dataset.id));
    if (btn.classList.contains('disabled')) {
      toast(`« ${p.name} » n’est pas disponible.`, 'err');
      return;
    }
    openOrderModal(p);
  }));
}

async function openOrderModal(product) {
  let tables;
  try { tables = await api('GET', '/api/tables'); } catch (err) { toast(err.message, 'err'); return; }
  if (!tables.length) { toast('Aucune table configurée.', 'err'); return; }
  const free = product.track_stock ? product.stock - product.reserved : Infinity;
  let tableId = tables.some((t) => t.id === state.activeTable?.id) ? state.activeTable.id : null;
  let qty = 1;

  const modal = openModal({
    title: `${esc(product.name)} <span class="muted small">· ${money(product.price)}</span>`,
    wide: true,
    body: `
      <div>
        <div class="step-title">1. Choisir la table</div>
        <div class="tiles" id="pick-tables">${tables.map((t) => `
          <button type="button" class="tile tile-table ${t.order_id ? 'busy' : ''}" data-id="${t.id}">
            <span class="tile-name">${esc(t.name)}</span>
            <span class="tile-meta">${t.order_id ? `Ouverte · ${money(t.order_total)}` : 'Libre'}</span>
          </button>`).join('')}</div>
      </div>
      <div>
        <div class="step-title">2. Quantité</div>
        <div class="stepper">
          <button class="btn" type="button" data-step="-1" aria-label="Diminuer">−</button>
          <input id="qty" type="number" min="1" step="1" inputmode="numeric" value="1" aria-label="Quantité">
          <button class="btn" type="button" data-step="1" aria-label="Augmenter">+</button>
        </div>
        <div class="quick">${[1, 2, 3, 4, 5, 6, 10, 12, 24].map((n) => `<button class="btn btn-sm" type="button" data-qty="${n}">${n}</button>`).join('')}</div>
        ${Number.isFinite(free) ? `<p class="muted small" style="text-align:center">Stock disponible : ${free}</p>` : ''}
      </div>
      <div class="summary-line"><span id="order-summary"></span><span class="num" id="order-amount"></span></div>
      <p class="form-error" id="order-error"></p>`,
    foot: `<button class="btn" data-close>Annuler</button>
           <button class="btn btn-success btn-lg" id="order-validate">✔ Valider la commande</button>`,
  });

  const qtyInput = $('#qty', modal);
  const update = () => {
    $$('#pick-tables .tile', modal).forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === tableId));
    const table = tables.find((t) => t.id === tableId);
    $('#order-summary', modal).textContent = table
      ? `${qty} × ${product.name} → ${table.name}${table.order_id ? ' (ajout à la commande ouverte)' : ' (nouvelle commande)'}`
      : 'Sélectionnez une table';
    $('#order-amount', modal).textContent = money(qty * product.price);
    $('#order-validate', modal).disabled = !table || !(qty >= 1);
  };
  const setQty = (n) => {
    qty = Math.max(1, Math.min(1000, Math.floor(n) || 1));
    qtyInput.value = qty;
    update();
  };
  $$('#pick-tables .tile', modal).forEach((b) => b.addEventListener('click', () => { tableId = Number(b.dataset.id); update(); }));
  $$('[data-step]', modal).forEach((b) => b.addEventListener('click', () => setQty(qty + Number(b.dataset.step))));
  $$('[data-qty]', modal).forEach((b) => b.addEventListener('click', () => setQty(Number(b.dataset.qty))));
  qtyInput.addEventListener('input', () => { qty = Math.floor(Number(qtyInput.value)); update(); });
  qtyInput.addEventListener('blur', () => setQty(qty));
  update();

  $('#order-validate', modal).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await api('POST', '/api/orders', { table_id: tableId, product_id: product.id, quantity: qty });
      const o = res.order;
      state.activeTable = { id: o.table_id, name: o.table_name, orderId: o.id };
      closeModal();
      toast(`${res.created ? 'Commande créée' : 'Ajouté à la commande'} ${o.number} – ${o.table_name} : ${qty} × ${product.name}. Total ${money(o.total)}`, 'ok');
      route(); // rafraîchit stocks et bandeau
    } catch (err) {
      $('#order-error', modal).textContent = err.message;
      btn.disabled = false;
    }
  });
}

/* =====================================================================
 * Tables
 * ===================================================================== */
async function renderTables(m, seq) {
  const view = $('#view');
  const paint = (tables) => {
    const busy = tables.filter((t) => t.order_id).length;
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Tables</h1><div class="muted">${busy} occupée(s) · ${tables.length - busy} libre(s)</div></div>
        ${isAdmin() ? '<div class="actions"><a class="btn" href="#/gestion/tables">⚙️ Gérer les tables</a></div>' : ''}
      </div>
      ${tables.length ? `<div class="tiles">${tables.map((t) => `
        <button type="button" class="tile tile-table ${t.order_id ? 'busy' : ''}" data-id="${t.id}">
          <span class="tile-name">${esc(t.name)}</span>
          ${t.order_id
            ? `<span class="tile-meta">${esc(t.order_number)}<br>Total ${money(t.order_total)}<br><strong>Reste ${money(t.order_total - t.order_paid)}</strong></span>`
            : '<span class="tile-meta">Libre – toucher pour commander</span>'}
        </button>`).join('')}</div>` : '<div class="empty">Aucune table.</div>'}`;
    $$('.tile-table', view).forEach((b) => b.addEventListener('click', () => {
      const t = tables.find((x) => x.id === Number(b.dataset.id));
      if (t.order_id) {
        location.hash = `#/commande/${t.order_id}`;
      } else {
        state.activeTable = { id: t.id, name: t.name };
        location.hash = '#/';
      }
    }));
  };
  const tables = await api('GET', '/api/tables');
  if (seq !== renderSeq) return;
  paint(tables);
  autoRefresh(async () => { const t = await api('GET', '/api/tables'); if (seq === renderSeq) paint(t); });
}

/* =====================================================================
 * Commandes ouvertes
 * ===================================================================== */
async function renderOrders(m, seq) {
  const view = $('#view');
  const paint = (orders) => {
    setOpenCount(orders.length);
    const remaining = orders.reduce((s, o) => s + o.remaining, 0);
    view.innerHTML = `
      <div class="page-head">
        <div><h1>Commandes ouvertes</h1><div class="muted">${orders.length} commande(s) · ${money(remaining)} à encaisser</div></div>
        <div class="actions"><a class="btn btn-primary" href="#/">＋ Nouvelle commande</a></div>
      </div>
      ${orders.length ? `<div class="orders-grid">${orders.map(orderCard).join('')}</div>`
        : '<div class="empty">Aucune commande en attente de paiement.</div>'}`;
  };
  const orders = await api('GET', '/api/orders?status=open');
  if (seq !== renderSeq) return;
  paint(orders);
  autoRefresh(async () => { const o = await api('GET', '/api/orders?status=open'); if (seq === renderSeq) paint(o); });
}

/* =====================================================================
 * Détail d'une commande
 * ===================================================================== */
async function renderOrder(id, seq) {
  const order = await api('GET', `/api/orders/${id}`);
  if (seq !== renderSeq) return;
  const view = $('#view');
  const open = order.status === 'open';
  view.innerHTML = `
    <div class="page-head">
      <div class="row">
        <a class="btn btn-icon" href="${open ? '#/commandes' : '#/historique'}" aria-label="Retour">←</a>
        <div><h1>${esc(order.table_name)} · ${esc(order.number)}</h1>
          <div class="muted small">Ouverte le ${fmtDateTime(order.created_at)}${order.created_by_name ? ` par ${esc(order.created_by_name)}` : ''}
          ${order.closed_at ? ` · ${order.status === 'paid' ? 'Payée' : 'Annulée'} le ${fmtDateTime(order.closed_at)}` : ''}</div>
        </div>
      </div>
      <div>${statusBadge(order.status)}</div>
    </div>
    ${order.cancel_reason ? `<div class="banner">Motif d'annulation : ${esc(order.cancel_reason)}</div>` : ''}
    <div class="detail-layout">
      <div>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Produit</th><th class="right">Prix unitaire</th><th class="right">Quantité</th><th class="right">Montant</th></tr></thead>
          <tbody>${order.items.length ? order.items.map((i) => `<tr>
            <td><strong>${esc(i.product_name)}</strong><br><span class="muted small">${esc(i.family_name)}</span></td>
            <td class="right num">${money(i.unit_price)}</td>
            <td class="right">${open ? `<span class="qty-ctl">
                <button class="btn" type="button" data-item="${i.id}" data-delta="-1" aria-label="Retirer un">−</button>
                <span>${i.quantity}</span>
                <button class="btn" type="button" data-item="${i.id}" data-delta="1" aria-label="Ajouter un">+</button></span>`
              : `<span class="num">${i.quantity}</span>`}</td>
            <td class="right num"><strong>${money(i.amount)}</strong></td>
          </tr>`).join('') : '<tr><td colspan="4" class="muted">Aucun article.</td></tr>'}</tbody>
        </table></div>
        <div class="totals">
          <div class="grand"><span>Total</span><span>${money(order.total)}</span></div>
          <div><span>Déjà payé</span><span>${money(order.paid_amount)}</span></div>
          ${open ? `<div class="due"><span>Reste à payer</span><span>${money(order.remaining)}</span></div>` : ''}
        </div>
      </div>
      <div class="grid">
        ${open ? `<div class="card grid">
          <button class="btn btn-success btn-lg btn-block" id="pay-btn" ${order.total > 0 ? '' : 'disabled'}>💰 Encaisser ${money(order.remaining)}</button>
          <button class="btn btn-primary btn-block" id="add-btn">＋ Ajouter des articles</button>
          <button class="btn btn-block" id="transfer-btn">🔀 Changer de table</button>
          <button class="btn btn-block" id="print-btn" ${order.items.length ? '' : 'disabled'}>🖨️ Imprimer l’addition</button>
          ${isAdmin() && order.paid_amount === 0 ? '<button class="btn btn-danger btn-block" id="cancel-btn">Annuler la commande</button>' : ''}
        </div>` : order.status === 'paid' ? '<div class="card"><button class="btn btn-block" id="print-btn">🖨️ Imprimer le reçu</button></div>' : ''}
        <div class="card">
          <h3>Paiements</h3>
          ${order.payments.length ? `<div class="grid" style="margin-top:.7rem">${order.payments.map((p) => `
            <div class="row small">
              <div><strong>${esc(p.method_name)}</strong> <span class="muted">· ${METHOD_TYPES[p.method_type]}</span><br>
                <span class="muted">${fmtDateTime(p.created_at)}${p.created_by_name ? ` · ${esc(p.created_by_name)}` : ''}
                ${p.reference ? ` · Réf. ${esc(p.reference)}` : ''}
                ${p.change_amount ? ` · Reçu ${money(p.received_amount)}, rendu ${money(p.change_amount)}` : ''}</span></div>
              <span class="spacer"></span><strong class="num">${money(p.amount)}</strong>
            </div>`).join('')}</div>` : '<p class="muted">Aucun paiement enregistré.</p>'}
        </div>
      </div>
    </div>`;

  $$('[data-item]', view).forEach((b) => b.addEventListener('click', async () => {
    const item = order.items.find((i) => i.id === Number(b.dataset.item));
    const quantity = item.quantity + Number(b.dataset.delta);
    if (quantity === 0 && !(await confirmModal('Retirer l’article', `Retirer « ${esc(item.product_name)} » de la commande ?`, { confirmLabel: 'Retirer', danger: true }))) return;
    try {
      await api('PATCH', `/api/orders/${order.id}/items/${item.id}`, { quantity });
      route();
    } catch (err) { toast(err.message, 'err'); }
  }));
  $('#pay-btn', view)?.addEventListener('click', () => openPaymentModal(order));
  $('#add-btn', view)?.addEventListener('click', () => {
    state.activeTable = { id: order.table_id, name: order.table_name, orderId: order.id };
    location.hash = '#/';
  });
  $('#transfer-btn', view)?.addEventListener('click', () => openTransferModal(order));
  $('#print-btn', view)?.addEventListener('click', () => printTicket(order));
  $('#cancel-btn', view)?.addEventListener('click', () => formModal({
    title: `Annuler la commande ${order.number}`,
    fields: [{ name: 'reason', label: 'Motif (facultatif)', maxlength: 200 }],
    submitLabel: 'Annuler la commande',
    onSubmit: async (v) => {
      await api('POST', `/api/orders/${order.id}/cancel`, { reason: v.reason || undefined });
      if (state.activeTable?.orderId === order.id) state.activeTable = null;
      toast('Commande annulée.', 'ok');
      route();
    },
  }));
}

/** Ticket au format caisse (80 mm) : addition si la commande est ouverte, reçu si elle est payée. */
function printTicket(order) {
  const paid = order.status === 'paid';
  const ticket = document.createElement('div');
  ticket.id = 'ticket';
  ticket.innerHTML = `
    <div class="t-center t-strong t-big">${esc(state.settings.bar_name)}</div>
    <div class="t-center">${paid ? 'REÇU' : 'ADDITION'}</div>
    <hr>
    <div>Commande : ${esc(order.number)}</div>
    <div>Table : ${esc(order.table_name)}</div>
    <div>Date : ${fmtDateTime(paid ? order.closed_at : nowString())}</div>
    <hr>
    ${order.items.map((i) => `<div class="t-line"><span>${i.quantity} × ${esc(i.product_name)}</span><span>${nf.format(i.amount)}</span></div>
      <div class="t-sub">${nf.format(i.unit_price)} l’unité</div>`).join('')}
    <hr>
    <div class="t-line t-strong t-big"><span>TOTAL</span><span>${money(order.total)}</span></div>
    ${order.payments.map((p) => `<div class="t-line"><span>${esc(p.method_name)}</span><span>${nf.format(p.amount)}</span></div>
      ${p.change_amount ? `<div class="t-sub">Reçu ${nf.format(p.received_amount)} · rendu ${nf.format(p.change_amount)}</div>` : ''}`).join('')}
    ${!paid && order.paid_amount ? `<div class="t-line t-strong"><span>RESTE À PAYER</span><span>${money(order.remaining)}</span></div>` : ''}
    <hr>
    <div class="t-center">Merci de votre visite !</div>`;
  document.body.append(ticket);
  document.body.classList.add('printing-ticket');
  const cleanup = () => {
    document.body.classList.remove('printing-ticket');
    ticket.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1000); // navigateurs sans « afterprint »
}

function nowString() {
  const d = new Date();
  return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openTransferModal(order) {
  const tables = (await api('GET', '/api/tables')).filter((t) => !t.order_id);
  if (!tables.length) { toast('Aucune table libre.', 'err'); return; }
  const modal = openModal({
    title: `Déplacer la commande de ${esc(order.table_name)}`,
    body: `<p class="muted">Choisissez une table libre :</p>
      <div class="tiles">${tables.map((t) => `<button class="tile tile-table" type="button" data-id="${t.id}"><span class="tile-name">${esc(t.name)}</span></button>`).join('')}</div>`,
  });
  $$('.tile', modal).forEach((b) => b.addEventListener('click', async () => {
    try {
      const o = await api('POST', `/api/orders/${order.id}/transfer`, { table_id: Number(b.dataset.id) });
      if (state.activeTable?.orderId === o.id) state.activeTable = { id: o.table_id, name: o.table_name, orderId: o.id };
      closeModal();
      toast(`Commande déplacée vers ${o.table_name}.`, 'ok');
      route();
    } catch (err) { toast(err.message, 'err'); }
  }));
}

/* ---------- Paiement ---------- */
async function openPaymentModal(order) {
  let methods;
  try { methods = await api('GET', '/api/payment-methods'); } catch (err) { toast(err.message, 'err'); return; }
  if (!methods.length) { toast('Aucun mode de paiement configuré.', 'err'); return; }
  let method = null;
  const groups = ['cash', 'mobile_money', 'other']
    .map((type) => ({ type, items: methods.filter((x) => x.type === type) }))
    .filter((g) => g.items.length);

  const modal = openModal({
    title: `Encaisser · ${esc(order.table_name)}`,
    body: `
      <div class="summary-line"><span>Reste à payer</span><span class="num">${money(order.remaining)}</span></div>
      <div class="grid">
        <div class="step-title">Mode de paiement</div>
        ${groups.map((g) => `<div class="method-group-title">${METHOD_TYPES[g.type]}</div>
          <div class="methods">${g.items.map((x) => `<button type="button" class="method" data-id="${x.id}">
            ${x.type === 'cash' ? '💵' : x.type === 'mobile_money' ? '📱' : '💳'} ${esc(x.name)}</button>`).join('')}</div>`).join('')}
      </div>
      <div class="form-grid" id="pay-fields" hidden>
        <label>Montant à encaisser
          <input id="pay-amount" type="number" min="1" max="${order.remaining}" step="1" inputmode="numeric" value="${order.remaining}">
          <span class="muted small">Saisissez un montant inférieur pour un paiement partiel.</span>
        </label>
        <div id="cash-fields" class="form-grid" hidden>
          <label>Montant reçu du client
            <input id="pay-received" type="number" min="0" step="1" inputmode="numeric" value="${order.remaining}">
          </label>
          <div class="quick" id="bills"></div>
          <div class="change-box" id="change-box"></div>
        </div>
        <label id="ref-field" hidden>Référence de la transaction (facultatif)
          <input id="pay-ref" maxlength="60" placeholder="Ex. : numéro de transaction">
        </label>
      </div>
      <p class="form-error" id="pay-error"></p>`,
    foot: `<button class="btn" data-close>Annuler</button>
           <button class="btn btn-success btn-lg" id="pay-confirm" disabled>Confirmer le paiement</button>`,
  });

  const amountInput = $('#pay-amount', modal);
  const receivedInput = $('#pay-received', modal);
  const amount = () => Math.floor(Number(amountInput.value));
  const refresh = () => {
    $$('.method', modal).forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === method?.id));
    $('#pay-fields', modal).hidden = !method;
    const isCash = method?.type === 'cash';
    $('#cash-fields', modal).hidden = !isCash;
    $('#ref-field', modal).hidden = !method || isCash;
    const a = amount();
    const validAmount = Number.isInteger(a) && a >= 1 && a <= order.remaining;
    let ok = !!method && validAmount;
    if (isCash) {
      const received = Math.floor(Number(receivedInput.value));
      const box = $('#change-box', modal);
      if (received >= a) {
        box.className = 'change-box';
        box.textContent = `Monnaie à rendre : ${money(received - a)}`;
      } else {
        box.className = 'change-box bad';
        box.textContent = `Il manque ${money(a - received)}`;
        ok = false;
      }
      const bills = [...new Set([a, Math.ceil(a / 1000) * 1000, Math.ceil(a / 5000) * 5000, Math.ceil(a / 10000) * 10000])].filter((n) => n > 0);
      $('#bills', modal).innerHTML = bills.map((n) => `<button class="btn btn-sm" type="button" data-bill="${n}">${nf.format(n)}</button>`).join('');
      $$('[data-bill]', modal).forEach((b) => b.addEventListener('click', () => { receivedInput.value = b.dataset.bill; refresh(); }));
    }
    const btn = $('#pay-confirm', modal);
    btn.disabled = !ok;
    btn.textContent = validAmount ? `Confirmer ${money(a)}${a < order.remaining ? ' (partiel)' : ''}` : 'Confirmer le paiement';
  };
  $$('.method', modal).forEach((b) => b.addEventListener('click', () => {
    method = methods.find((x) => x.id === Number(b.dataset.id));
    refresh();
  }));
  amountInput.addEventListener('input', () => {
    if (method?.type === 'cash' && Number(receivedInput.value) < amount()) receivedInput.value = amountInput.value;
    refresh();
  });
  receivedInput.addEventListener('input', refresh);
  if (methods.length === 1) method = methods[0];
  refresh();

  $('#pay-confirm', modal).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const body = { method_id: method.id, amount: amount() };
    if (method.type === 'cash') body.received_amount = Math.floor(Number(receivedInput.value));
    else if ($('#pay-ref', modal).value.trim()) body.reference = $('#pay-ref', modal).value.trim();
    try {
      const res = await api('POST', `/api/orders/${order.id}/payments`, body);
      closeModal();
      if (res.fully_paid) {
        if (state.activeTable?.orderId === order.id) state.activeTable = null;
        toast(`✔ Commande ${res.order.number} payée et clôturée.`, 'ok');
      } else {
        toast(`Paiement partiel enregistré. Reste à payer : ${money(res.order.remaining)}`, 'ok');
      }
      await route(); // recharge le détail de la commande
      if (res.change) {
        openModal({
          title: 'Paiement enregistré',
          body: `<div class="change-box" style="font-size:1.6rem">Monnaie à rendre : ${money(res.change)}</div>`,
          foot: '<button class="btn btn-primary" data-close>OK</button>',
        });
      }
    } catch (err) {
      $('#pay-error', modal).textContent = err.message;
      btn.disabled = false;
    }
  });
}

/* =====================================================================
 * Historique
 * ===================================================================== */
const historyState = { date: null, status: '' };

async function renderHistory(m, seq) {
  historyState.date ??= isoDate();
  const params = new URLSearchParams({ date: historyState.date });
  if (historyState.status) params.set('status', historyState.status);
  const orders = await api('GET', `/api/orders?${params}`);
  if (seq !== renderSeq) return;
  const paidOrders = orders.filter((o) => o.status === 'paid');
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head"><div><h1>Historique des commandes</h1><div class="muted">${esc(longDate(historyState.date))}</div></div>
      ${isAdmin() && !state.backdate ? '<div class="actions"><button class="btn" type="button" id="start-backdate">🕘 Saisir des ventes passées</button></div>' : ''}</div>
    <div class="filters">
      <div class="row">
        <button class="btn btn-icon" type="button" id="prev-day" aria-label="Jour précédent">‹</button>
        <label>Date<input type="date" id="h-date" value="${historyState.date}" max="${isoDate()}"></label>
        <button class="btn btn-icon" type="button" id="next-day" aria-label="Jour suivant" ${historyState.date >= isoDate() ? 'disabled' : ''}>›</button>
      </div>
      <div class="seg" role="group" aria-label="Statut">
        ${[['', 'Toutes'], ['paid', 'Payées'], ['open', 'Ouvertes'], ['cancelled', 'Annulées']].map(([v, l]) =>
          `<button type="button" data-status="${v}" class="${historyState.status === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
    </div>
    <div class="kpis" style="margin-bottom:1rem">
      ${kpi('Commandes listées', orders.length)}
      ${kpi('Commandes payées', paidOrders.length)}
      ${kpi('Montant des commandes payées', money(paidOrders.reduce((s, o) => s + o.total, 0)))}
    </div>
    ${orders.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Heure</th><th>N°</th><th>Table</th><th>Produits</th><th class="right">Total</th><th>Paiement</th><th>Statut</th></tr></thead>
      <tbody>${orders.map((o) => `<tr class="clickable" data-id="${o.id}">
        <td class="num">${fmtTime(o.created_at)}</td>
        <td class="num">${esc(o.number)}</td>
        <td>${esc(o.table_name)}</td>
        <td class="small">${o.items.map((i) => `${i.quantity} × ${esc(i.product_name)}`).join('<br>')}</td>
        <td class="right num"><strong>${money(o.total)}</strong></td>
        <td class="small">${o.payment_methods.map((p) => `${esc(p.method_name)}${o.payment_methods.length > 1 ? ` (${money(p.amount)})` : ''}`).join('<br>') || '—'}</td>
        <td>${statusBadge(o.status)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">Aucune commande pour cette date.</div>'}`;

  const go = (date) => { historyState.date = date; route(); };
  $('#start-backdate', view)?.addEventListener('click', openBackdateModal);
  $('#h-date', view).addEventListener('change', (e) => { if (e.target.value) go(e.target.value); });
  $('#prev-day', view).addEventListener('click', () => go(addDays(historyState.date, -1)));
  $('#next-day', view).addEventListener('click', () => go(addDays(historyState.date, 1)));
  $$('[data-status]', view).forEach((b) => b.addEventListener('click', () => { historyState.status = b.dataset.status; route(); }));
  $$('tr[data-id]', view).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/commande/${tr.dataset.id}`; }));
}

/* =====================================================================
 * Statistiques
 * ===================================================================== */
const statsState = { preset: 'today', from: null, to: null };

function presetRange(preset) {
  const today = isoDate();
  switch (preset) {
    case 'yesterday': { const y = addDays(today, -1); return [y, y]; }
    case '7d': return [addDays(today, -6), today];
    case 'month': return [`${today.slice(0, 8)}01`, today];
    default: return [today, today];
  }
}

async function renderStats(m, seq) {
  if (statsState.preset !== 'custom') [statsState.from, statsState.to] = presetRange(statsState.preset);
  const { from, to } = statsState;
  const s = await api('GET', `/api/stats?from=${from}&to=${to}`);
  if (seq !== renderSeq) return;
  const single = from === to;
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Statistiques</h1><div class="muted">${single ? esc(longDate(from)) : `Du ${fmtDate(from)} au ${fmtDate(to)}`}</div></div>
      <div class="actions">
        <div class="export">
          <button class="btn" type="button" id="export-btn" aria-haspopup="menu">⬇️ Exporter (Excel)</button>
          <div class="user-menu" id="export-menu" role="menu" hidden>
            <a role="menuitem" href="/api/reports/sales.csv?from=${from}&to=${to}" download>Ventes par produit</a>
            <a role="menuitem" href="/api/reports/orders.csv?from=${from}&to=${to}" download>Commandes</a>
            <a role="menuitem" href="/api/reports/payments.csv?from=${from}&to=${to}" download>Encaissements</a>
          </div>
        </div>
        <button class="btn" id="print-stats">🖨️ Imprimer</button>
      </div>
    </div>
    <div class="filters">
      <div class="seg" role="group" aria-label="Période">
        ${[['today', 'Aujourd’hui'], ['yesterday', 'Hier'], ['7d', '7 derniers jours'], ['month', 'Ce mois']].map(([v, l]) =>
          `<button type="button" data-preset="${v}" class="${statsState.preset === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <label>Du<input type="date" id="s-from" value="${from}" max="${isoDate()}"></label>
      <label>Au<input type="date" id="s-to" value="${to}" max="${isoDate()}"></label>
    </div>

    <div class="kpis">
      ${kpi('Chiffre d’affaires encaissé', money(s.collected), `${s.payments_count} paiement(s)`, true)}
      ${kpi('Espèces (Cash)', money(s.by_type.cash))}
      ${kpi('Mobile Money', money(s.by_type.mobile_money))}
      ${s.by_type.other ? kpi('Autres moyens', money(s.by_type.other)) : ''}
      ${kpi('Commandes enregistrées', s.orders_created, s.orders_cancelled ? `dont ${s.orders_cancelled} annulée(s)` : '')}
      ${kpi('Commandes payées', s.orders_paid, `Ventes clôturées : ${money(s.sales_amount)}`)}
      ${kpi('Commandes ouvertes (actuellement)', s.open_orders.count, `${money(s.open_orders.remaining)} restant à encaisser`)}
    </div>

    <div class="section">
      <h2>📈 Résultat des ventes</h2>
      <div class="kpis">
        ${kpi('Ventes clôturées', money(s.sales_amount), 'Commandes payées')}
        ${kpi('Coût d’achat des produits vendus', money(s.cost_of_sales))}
        ${kpi('Marge brute', money(s.gross_margin), s.margin_rate === null ? '' : `${String(s.margin_rate).replace('.', ',')} % des ventes`, true)}
      </div>
      ${s.items_without_cost ? `<p class="muted small">⚠️ ${s.items_without_cost} article(s) vendu(s) sans prix d’achat renseigné : la marge est surestimée.
        ${isAdmin() ? 'Renseignez les prix d’achat dans <a href="#/gestion/produits">Gestion → Produits</a>.' : ''}</p>` : ''}
    </div>

    <div class="stats-grid section">
      <div class="card">
        <h2>🏆 Produits les plus vendus</h2>
        <p class="muted small">Quantités vendues (commandes payées)</p>
        ${barList(s.top_products, { label: (p) => p.product_name, value: (p) => p.quantity,
          title: (p) => `${p.product_name} : ${p.quantity} vendu(s) – ${money(p.amount)}` })}
      </div>
      <div class="card">
        <h2>💳 Répartition des paiements</h2>
        <p class="muted small">Montants encaissés par mode de paiement</p>
        ${barList(s.by_method, { label: (x) => x.name, value: (x) => x.amount, format: (v) => money(v),
          title: (x) => `${x.name} (${METHOD_TYPES[x.type]}) : ${money(x.amount)} – ${x.count} paiement(s)` })}
      </div>
      ${s.families.length ? `<div class="card">
        <h2>🍹 Ventes par famille</h2>
        <p class="muted small">Montant des commandes payées</p>
        ${barList(s.families, { label: (x) => x.family_name, value: (x) => x.amount, format: (v) => money(v),
          title: (x) => `${x.family_name} : ${x.quantity} article(s) – ${money(x.amount)}` })}
      </div>` : ''}
      ${!single ? `<div class="card">
        <h2>📅 Encaissements par jour</h2>
        <p class="muted small">Montant encaissé chaque jour</p>
        ${barList(s.daily, { label: (d) => fmtDate(d.date), value: (d) => d.collected, format: (v) => money(v),
          title: (d) => `${fmtDate(d.date)} : ${money(d.collected)} – ${d.orders} commande(s)` })}
      </div>` : ''}
    </div>

    <div class="section">
      <h2>📦 Produits vendus</h2>
      ${s.products.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>#</th><th>Produit</th><th>Famille</th><th class="right">Quantité vendue</th><th class="right">Montant généré</th>
          <th class="right">Coût d’achat</th><th class="right">Marge brute</th></tr></thead>
        <tbody>${s.products.map((p, i) => `<tr>
          <td><span class="rank">${i + 1}</span></td><td><strong>${esc(p.product_name)}</strong></td>
          <td class="muted">${esc(p.family_name)}</td><td class="right num">${nf.format(p.quantity)}</td>
          <td class="right num">${money(p.amount)}</td>
          <td class="right num">${p.qty_without_cost === p.quantity ? '<span class="muted">—</span>' : money(p.cost)}</td>
          <td class="right num">${money(p.margin)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td></td><td colspan="2">Total</td>
          <td class="right num">${nf.format(s.products.reduce((a, p) => a + p.quantity, 0))}</td>
          <td class="right num">${money(s.sales_amount)}</td>
          <td class="right num">${money(s.cost_of_sales)}</td>
          <td class="right num">${money(s.gross_margin)}</td></tr></tfoot>
      </table></div>` : '<div class="empty">Aucun produit vendu sur cette période.</div>'}
    </div>

    <div class="section">
      <h2>💰 Détail des encaissements</h2>
      ${s.by_method.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Mode de paiement</th><th>Catégorie</th><th class="right">Nombre</th><th class="right">Montant</th></tr></thead>
        <tbody>${s.by_method.map((x) => `<tr><td><strong>${esc(x.name)}</strong></td><td>${METHOD_TYPES[x.type]}</td>
          <td class="right num">${x.count}</td><td class="right num">${money(x.amount)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2">Total encaissé</td><td class="right num">${s.payments_count}</td><td class="right num">${money(s.collected)}</td></tr></tfoot>
      </table></div>` : '<div class="empty">Aucun encaissement sur cette période.</div>'}
    </div>

    ${s.by_user.length ? `<div class="section">
      <h2>👤 Encaissements par utilisateur</h2>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Utilisateur</th><th class="right">Paiements</th><th class="right">dont espèces</th><th class="right">Total encaissé</th></tr></thead>
        <tbody>${s.by_user.map((u) => `<tr><td><strong>${esc(u.name)}</strong></td><td class="right num">${u.count}</td>
          <td class="right num">${money(u.cash)}</td><td class="right num">${money(u.amount)}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">La colonne « dont espèces » indique le montant que chaque personne doit remettre en caisse.</p>
    </div>` : ''}`;

  $$('[data-preset]', view).forEach((b) => b.addEventListener('click', () => { statsState.preset = b.dataset.preset; route(); }));
  const custom = () => {
    const f = $('#s-from', view).value;
    const t = $('#s-to', view).value;
    if (!f || !t) return;
    if (f > t) { toast('La date de début doit précéder la date de fin.', 'err'); return; }
    Object.assign(statsState, { preset: 'custom', from: f, to: t });
    route();
  };
  $('#s-from', view).addEventListener('change', custom);
  $('#s-to', view).addEventListener('change', custom);
  $('#print-stats', view).addEventListener('click', () => window.print());
  bindDropdown($('#export-btn', view), $('#export-menu', view));
}

function bindDropdown(button, menu) {
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
}

/* =====================================================================
 * Stock (responsable)
 * ===================================================================== */
const MOVEMENT_TYPES = {
  entree: ['Entrée', 'badge-paid'],
  perte: ['Perte', 'badge-cancelled'],
  inventaire: ['Inventaire', ''],
  vente: ['Vente', 'badge-open'],
  ajustement: ['Ajustement', ''],
};
const STOCK_STATUS = {
  ok: ['OK', 'badge-paid'],
  alerte: ['Stock bas', 'badge-open'],
  rupture: ['Rupture', 'badge-cancelled'],
};
const movementBadge = (t) => `<span class="badge ${MOVEMENT_TYPES[t][1]}">${MOVEMENT_TYPES[t][0]}</span>`;
const signed = (n) => (n > 0 ? `+${nf.format(n)}` : nf.format(n));

function movementsTable(moves, { showProduct = true } = {}) {
  if (!moves.length) return '<div class="empty">Aucun mouvement de stock.</div>';
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Date</th>${showProduct ? '<th>Produit</th>' : ''}<th>Type</th><th class="right">Quantité</th>
      <th class="right">Stock après</th><th>Détail</th></tr></thead>
    <tbody>${moves.map((m) => `<tr>
      <td class="num">${fmtDateTime(m.created_at)}</td>
      ${showProduct ? `<td><strong>${esc(m.product_name)}</strong></td>` : ''}
      <td>${movementBadge(m.type)}</td>
      <td class="right num"><strong>${signed(m.quantity)}</strong></td>
      <td class="right num">${nf.format(m.stock_after)}</td>
      <td class="small">${[
        m.order_number ? `Commande ${esc(m.order_number)}` : '',
        m.unit_cost ? `Prix d’achat ${money(m.unit_cost)}` : '',
        m.note ? esc(m.note) : '',
        m.created_by_name ? `<span class="muted">par ${esc(m.created_by_name)}</span>` : '',
      ].filter(Boolean).join(' · ')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function renderStock(m, seq) {
  const [items, moves] = await Promise.all([api('GET', '/api/stock'), api('GET', '/api/stock/movements?limit=50')]);
  if (seq !== renderSeq) return;
  const alerts = items.filter((p) => p.status !== 'ok');
  setBadge('stock-alerts', alerts.length);
  const today = isoDate();
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Stock</h1><div class="muted">Entrées, pertes, inventaires et historique des mouvements</div></div>
      <div class="actions">
        <a class="btn" href="/api/reports/stock.csv" download>⬇️ État du stock (Excel)</a>
        <a class="btn" href="/api/reports/stock-movements.csv?from=${addDays(today, -30)}&to=${today}" download>⬇️ Mouvements 30 jours</a>
      </div>
    </div>
    <div class="kpis">
      ${kpi('Produits suivis', items.length)}
      ${kpi('Stock bas', items.filter((p) => p.status === 'alerte').length)}
      ${kpi('En rupture', items.filter((p) => p.status === 'rupture').length)}
      ${kpi('Valeur du stock (prix d’achat)', money(items.reduce((a, p) => a + p.stock_value, 0)), '', true)}
    </div>
    <div class="section">
      <div class="filters">
        <label>Rechercher<input type="search" id="stock-search" placeholder="Nom du produit"></label>
        <label class="check"><input type="checkbox" id="stock-alerts-only"> Seulement les alertes</label>
      </div>
      ${items.length ? `<div class="table-wrap"><table class="data" id="stock-table">
        <thead><tr><th>Produit</th><th class="right">En stock</th><th class="right">Sur commandes ouvertes</th>
          <th class="right">Disponible</th><th class="right">Seuil</th><th>État</th><th class="right">Actions</th></tr></thead>
        <tbody>${items.map((p) => `<tr data-name="${esc(p.name.toLowerCase())}" data-status="${p.status}">
          <td><strong>${esc(p.name)}</strong><br><span class="muted small">${esc(p.family_name)}</span></td>
          <td class="right num">${nf.format(p.stock)}</td>
          <td class="right num">${p.reserved ? nf.format(p.reserved) : '<span class="muted">0</span>'}</td>
          <td class="right num"><strong>${nf.format(p.free)}</strong></td>
          <td class="right num">${nf.format(p.alert_threshold)}</td>
          <td><span class="badge ${STOCK_STATUS[p.status][1]}">${STOCK_STATUS[p.status][0]}</span></td>
          <td class="right"><div class="row" style="justify-content:flex-end">
            <button class="btn btn-sm" data-move="entree" data-id="${p.id}">＋ Entrée</button>
            <button class="btn btn-sm" data-move="perte" data-id="${p.id}">− Perte</button>
            <button class="btn btn-sm" data-move="inventaire" data-id="${p.id}">Inventaire</button>
            <button class="btn btn-sm btn-ghost" data-history="${p.id}">Historique</button>
          </div></td>
        </tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">Aucun produit avec suivi du stock.<br>Activez « Suivi du stock » sur les produits dans
          <a href="#/gestion/produits">Gestion → Produits</a>.</div>`}
    </div>
    <div class="section">
      <h2>🕘 Derniers mouvements</h2>
      ${movementsTable(moves)}
    </div>`;

  const filter = () => {
    const q = $('#stock-search', view).value.trim().toLowerCase();
    const onlyAlerts = $('#stock-alerts-only', view).checked;
    $$('#stock-table tbody tr', view).forEach((tr) => {
      tr.hidden = (q && !tr.dataset.name.includes(q)) || (onlyAlerts && tr.dataset.status === 'ok');
    });
  };
  $('#stock-search', view).addEventListener('input', filter);
  $('#stock-alerts-only', view).addEventListener('change', filter);

  $$('[data-move]', view).forEach((b) => b.addEventListener('click', () => {
    const p = items.find((x) => x.id === Number(b.dataset.id));
    const type = b.dataset.move;
    const fields = {
      entree: [
        { name: 'quantity', label: 'Quantité reçue', type: 'number', min: 1, required: true },
        { name: 'unit_cost', label: `Prix d’achat unitaire (${state.settings.currency})`, type: 'number', min: 0, value: p.cost_price || '', hint: 'Facultatif. Met à jour le prix d’achat du produit.' },
        { name: 'note', label: 'Note (fournisseur, n° de bon…)', maxlength: 200 },
      ],
      perte: [
        { name: 'quantity', label: 'Quantité perdue', type: 'number', min: 1, required: true },
        { name: 'note', label: 'Motif (casse, offert, périmé…)', maxlength: 200 },
      ],
      inventaire: [
        { name: 'quantity', label: 'Quantité réellement comptée', type: 'number', min: 0, required: true, value: p.stock,
          hint: `Stock enregistré : ${p.stock}. L’écart sera enregistré comme mouvement d’inventaire.` },
        { name: 'note', label: 'Note', maxlength: 200 },
      ],
    }[type];
    const titles = { entree: 'Entrée de stock', perte: 'Déclarer une perte', inventaire: 'Inventaire' };
    formModal({
      title: `${titles[type]} · ${p.name}`,
      fields,
      onSubmit: async (v) => {
        const r = await api('POST', '/api/stock/movements', { product_id: p.id, type, ...v, note: v.note || undefined });
        toast(r.delta === 0 ? 'Aucun écart : stock inchangé.' : `Stock de « ${p.name} » : ${nf.format(r.stock)} (${signed(r.delta)}).`, 'ok');
        route();
      },
    });
  }));
  $$('[data-history]', view).forEach((b) => b.addEventListener('click', async () => {
    const p = items.find((x) => x.id === Number(b.dataset.history));
    try {
      const list = await api('GET', `/api/stock/movements?product_id=${p.id}&limit=200`);
      openModal({ title: `Historique du stock · ${esc(p.name)}`, wide: true, body: movementsTable(list, { showProduct: false }) });
    } catch (err) { toast(err.message, 'err'); }
  }));
}

/* =====================================================================
 * Gestion (responsable)
 * ===================================================================== */
const ADMIN_TABS = [
  ['produits', '📦 Produits'],
  ['familles', '🗂️ Familles'],
  ['tables', '🪑 Tables'],
  ['paiements', '💳 Moyens de paiement'],
  ['utilisateurs', '👤 Utilisateurs'],
  ['parametres', '🔧 Paramètres'],
];

async function renderAdmin(tab, seq) {
  if (!ADMIN_TABS.some(([k]) => k === tab)) tab = 'produits';
  const view = $('#view');
  view.innerHTML = `
    <div class="page-head"><h1>Gestion</h1></div>
    <div class="tabs" role="tablist">${ADMIN_TABS.map(([k, l]) =>
      `<button type="button" role="tab" data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="admin-body"><div class="spinner"></div></div>`;
  $$('[data-tab]', view).forEach((b) => b.addEventListener('click', () => { location.hash = `#/gestion/${b.dataset.tab}`; }));
  const body = $('#admin-body', view);
  const renderers = {
    produits: adminProducts, familles: adminFamilies, tables: adminTables,
    paiements: adminMethods, utilisateurs: adminUsers, parametres: adminSettings,
  };
  await renderers[tab](body, seq);
}

function onActions(root, handlers) {
  $$('[data-act]', root).forEach((b) => b.addEventListener('click', () => handlers[b.dataset.act]?.(Number(b.dataset.id))));
}
async function del(url, label) {
  if (!(await confirmModal('Supprimer', `Supprimer ${label} ?`, { confirmLabel: 'Supprimer', danger: true }))) return;
  try {
    await api('DELETE', url);
    toast('Supprimé.', 'ok');
    route();
  } catch (err) { toast(err.message, 'err'); }
}

const productFilter = { family: '' };

async function adminProducts(body, seq) {
  const [families, products] = await Promise.all([api('GET', '/api/families'), api('GET', '/api/products')]);
  if (seq !== renderSeq) return;
  const list = productFilter.family ? products.filter((p) => p.family_id === Number(productFilter.family)) : products;
  body.innerHTML = `
    <div class="filters">
      <label>Famille<select id="pf">
        <option value="">Toutes les familles</option>
        ${families.map((f) => `<option value="${f.id}" ${String(f.id) === productFilter.family ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
      </select></label>
      <span class="spacer"></span>
      <button class="btn btn-primary" data-act="add" ${families.length ? '' : 'disabled'}>＋ Nouveau produit</button>
    </div>
    ${list.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Produit</th><th>Famille</th><th class="right">Prix de vente</th><th class="right">Prix d’achat</th><th class="right">Stock</th><th>Disponibilité</th><th class="right">Actions</th></tr></thead>
      <tbody>${list.map((p) => `<tr>
        <td><div class="product-cell"><span class="thumb">${productPhoto(p, '📦')}</span>
          <span><strong>${esc(p.name)}</strong>${p.format ? `<br><span class="muted small">${esc(p.format)}</span>` : ''}</span></div></td>
        <td>${esc(p.family_name)}</td>
        <td class="right num">${money(p.price)}</td>
        <td class="right num">${p.cost_price ? money(p.cost_price) : '<span class="muted">—</span>'}</td>
        <td class="right num">${p.track_stock ? `${p.stock}${p.reserved ? ` <span class="muted small">(${p.reserved} réservé)</span>` : ''}` : '<span class="muted">Non suivi</span>'}</td>
        <td><button class="btn btn-sm" data-act="toggle" data-id="${p.id}">${p.available ? '✅ Disponible' : '⛔ Indisponible'}</button></td>
        <td class="right"><div class="row" style="justify-content:flex-end">
          <button class="btn btn-sm" data-act="edit" data-id="${p.id}">Modifier</button>
          <button class="btn btn-sm" data-act="duplicate" data-id="${p.id}" title="Créer un nouveau produit à partir de celui-ci">Dupliquer</button>
          <button class="btn btn-sm btn-danger" data-act="remove" data-id="${p.id}">Supprimer</button></div></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${families.length ? 'Aucun produit.' : 'Créez d’abord une famille de produits.'}</div>`}`;

  $('#pf', body).addEventListener('change', (e) => { productFilter.family = e.target.value; route(); });
  const familyOptions = families.map((f) => ({ value: f.id, label: f.name }));
  // `p` : produit à modifier. `model` : produit dupliqué, qui pré-remplit un nouveau produit.
  const form = (p, model = p) => withStockTracking(formModal({
    title: p ? `Modifier « ${p.name} »` : model ? `Dupliquer « ${model.name} »` : 'Nouveau produit',
    fields: [
      { name: 'image', label: 'Photo', type: 'image', value: model?.image_url, hint: 'Le produit est recadré et centré automatiquement dans le cadre ; ajustez si besoin. Un fond clair donne le meilleur rendu.' },
      { name: 'name', label: 'Nom du produit', required: true, value: p ? p.name : model ? `${model.name} (copie)` : '', maxlength: 80 },
      { name: 'format', label: 'Format / contenance (facultatif)', value: model?.format, placeholder: 'Ex. : 65 cl', maxlength: 30 },
      { name: 'family_id', label: 'Famille', type: 'select', options: familyOptions, value: model?.family_id ?? (productFilter.family || families[0]?.id) },
      { name: 'price', label: `Prix de vente unitaire (${state.settings.currency})`, type: 'number', min: 0, required: true, value: model?.price },
      { name: 'cost_price', label: `Prix d’achat unitaire (${state.settings.currency})`, type: 'number', min: 0, value: model?.cost_price ?? 0, hint: 'Sert au calcul de la marge brute dans les statistiques.' },
      { name: 'available', label: 'Disponible à la vente', type: 'checkbox', value: model ? !!model.available : true },
      { name: 'track_stock', label: 'Activer le suivi du stock', type: 'checkbox', value: !!model?.track_stock },
      p
        ? { name: 'stock', label: 'Stock actuel (quantité en réserve)', type: 'number', min: 0, value: p.stock,
          hint: 'Une modification est enregistrée comme « ajustement » dans l’historique du stock. Pour une livraison, une perte ou un inventaire, l’écran Stock garde le détail.' }
        : { name: 'stock', label: 'Stock initial', type: 'number', min: 0, value: 0, hint: 'Ensuite, utilisez l’écran Stock pour les entrées, pertes et inventaires.' },
      { name: 'alert_threshold', label: 'Seuil d’alerte de stock bas', type: 'number', min: 0, value: model?.alert_threshold ?? 0, hint: 'Une alerte s’affiche quand le stock disponible atteint ce niveau.' },
    ],
    submitLabel: p ? 'Enregistrer' : 'Créer le produit',
    onSubmit: async (v) => {
      const { image, ...fields } = v;
      const payload = { ...fields, family_id: Number(v.family_id) };
      payload.image_url = image.pending ? (await api('POST', '/api/images', { data: image.pending })).url : image.url;
      // Stock : envoyé seulement s'il a changé (la correction est tracée côté serveur).
      if (!p) payload.stock = v.stock ?? 0;
      else if (v.stock === undefined || v.stock === p.stock) delete payload.stock;
      for (const k of ['cost_price', 'alert_threshold']) if (payload[k] === undefined) payload[k] = 0;
      if (p) await api('PUT', `/api/products/${p.id}`, payload);
      else await api('POST', '/api/products', payload);
      toast(p ? 'Produit modifié.' : `Produit « ${v.name} » ajouté.`, 'ok');
      route();
    },
  }));
  // Saisir un stock active le suivi du stock (sinon il ne diminuerait pas à chaque vente).
  function withStockTracking(modal) {
    const stock = $('[name=stock]', modal);
    const tracking = $('[name=track_stock]', modal);
    stock?.addEventListener('input', () => { if (stock.value !== '' && tracking) tracking.checked = true; });
    return modal;
  }
  onActions(body, {
    add: () => form(null),
    edit: (id) => form(products.find((p) => p.id === id)),
    duplicate: (id) => form(null, products.find((p) => p.id === id)),
    toggle: async (id) => {
      const p = products.find((x) => x.id === id);
      try { await api('PUT', `/api/products/${id}`, { available: !p.available }); route(); } catch (err) { toast(err.message, 'err'); }
    },
    remove: (id) => del(`/api/products/${id}`, `le produit « ${esc(products.find((p) => p.id === id).name)} »`),
  });
}

const FAMILY_ICONS = ['🍺', '🍷', '🥃', '🍸', '🍹', '🧃', '🥤', '💧', '☕', '🍾', '🍔', '🥜', '🚬', '🛒'];

async function adminFamilies(body, seq) {
  const families = await api('GET', '/api/families');
  if (seq !== renderSeq) return;
  body.innerHTML = `
    <div class="filters"><span class="spacer"></span><button class="btn btn-primary" data-act="add">＋ Nouvelle famille</button></div>
    ${families.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Ordre</th><th>Famille</th><th class="right">Produits</th><th class="right">Actions</th></tr></thead>
      <tbody>${families.map((f) => `<tr>
        <td class="num">${f.position}</td>
        <td><span class="swatch" style="background:${esc(f.color)}"></span>${esc(f.icon)} <strong>${esc(f.name)}</strong></td>
        <td class="right num">${f.product_count}</td>
        <td class="right"><div class="row" style="justify-content:flex-end">
          <button class="btn btn-sm" data-act="edit" data-id="${f.id}">Modifier</button>
          <button class="btn btn-sm btn-danger" data-act="remove" data-id="${f.id}">Supprimer</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune famille.</div>'}`;
  const form = (f) => formModal({
    title: f ? `Modifier « ${f.name} »` : 'Nouvelle famille',
    fields: [
      { name: 'name', label: 'Nom de la famille', required: true, value: f?.name, maxlength: 60 },
      { name: 'icon', label: 'Icône', type: 'select', options: FAMILY_ICONS.map((i) => ({ value: i, label: i })), value: f?.icon ?? '🍹' },
      { name: 'color', label: 'Couleur du panneau', type: 'color', value: f?.color ?? '#0b6bcb' },
      { name: 'position', label: 'Ordre d’affichage', type: 'number', min: 0, value: f?.position },
    ],
    onSubmit: async (v) => {
      if (f) await api('PUT', `/api/families/${f.id}`, v);
      else await api('POST', '/api/families', v);
      toast(f ? 'Famille modifiée.' : 'Famille ajoutée.', 'ok');
      route();
    },
  });
  onActions(body, {
    add: () => form(null),
    edit: (id) => form(families.find((f) => f.id === id)),
    remove: (id) => del(`/api/families/${id}`, `la famille « ${esc(families.find((f) => f.id === id).name)} »`),
  });
}

async function adminTables(body, seq) {
  const tables = await api('GET', '/api/tables');
  if (seq !== renderSeq) return;
  body.innerHTML = `
    <div class="filters"><span class="spacer"></span><button class="btn btn-primary" data-act="add">＋ Nouvelle table</button></div>
    ${tables.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Ordre</th><th>Table</th><th>État</th><th class="right">Actions</th></tr></thead>
      <tbody>${tables.map((t) => `<tr>
        <td class="num">${t.position}</td><td><strong>${esc(t.name)}</strong></td>
        <td>${t.order_id ? `<span class="badge badge-open">Occupée · ${esc(t.order_number)}</span>` : '<span class="badge">Libre</span>'}</td>
        <td class="right"><div class="row" style="justify-content:flex-end">
          <button class="btn btn-sm" data-act="edit" data-id="${t.id}">Modifier</button>
          <button class="btn btn-sm btn-danger" data-act="remove" data-id="${t.id}">Supprimer</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucune table.</div>'}`;
  const form = (t) => formModal({
    title: t ? `Modifier « ${t.name} »` : 'Nouvelle table',
    fields: [
      { name: 'name', label: 'Numéro ou nom de la table', required: true, value: t?.name ?? `Table ${tables.length + 1}`, maxlength: 40 },
      { name: 'position', label: 'Ordre d’affichage', type: 'number', min: 0, value: t?.position },
    ],
    onSubmit: async (v) => {
      if (t) await api('PUT', `/api/tables/${t.id}`, v);
      else await api('POST', '/api/tables', v);
      toast(t ? 'Table modifiée.' : 'Table ajoutée.', 'ok');
      route();
    },
  });
  onActions(body, {
    add: () => form(null),
    edit: (id) => form(tables.find((t) => t.id === id)),
    remove: (id) => del(`/api/tables/${id}`, `« ${esc(tables.find((t) => t.id === id).name)} »`),
  });
}

async function adminMethods(body, seq) {
  const methods = await api('GET', '/api/payment-methods');
  if (seq !== renderSeq) return;
  body.innerHTML = `
    <div class="filters"><p class="muted" style="margin:0">Ajoutez ici les opérateurs Mobile Money acceptés (Orange Money, MTN, Wave…) ou d’autres moyens.</p>
      <span class="spacer"></span><button class="btn btn-primary" data-act="add">＋ Nouveau moyen de paiement</button></div>
    ${methods.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>Nom</th><th>Catégorie</th><th class="right">Actions</th></tr></thead>
      <tbody>${methods.map((x) => `<tr>
        <td><strong>${esc(x.name)}</strong></td><td>${METHOD_TYPES[x.type]}</td>
        <td class="right"><div class="row" style="justify-content:flex-end">
          <button class="btn btn-sm" data-act="edit" data-id="${x.id}">Modifier</button>
          <button class="btn btn-sm btn-danger" data-act="remove" data-id="${x.id}">Supprimer</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">Aucun moyen de paiement.</div>'}`;
  const form = (x) => formModal({
    title: x ? `Modifier « ${x.name} »` : 'Nouveau moyen de paiement',
    fields: [
      { name: 'name', label: 'Nom', required: true, value: x?.name, placeholder: 'Ex. : Moov Money', maxlength: 40 },
      { name: 'type', label: 'Catégorie', type: 'select', value: x?.type ?? 'mobile_money',
        options: Object.entries(METHOD_TYPES).map(([value, label]) => ({ value, label })) },
    ],
    onSubmit: async (v) => {
      if (x) await api('PUT', `/api/payment-methods/${x.id}`, v);
      else await api('POST', '/api/payment-methods', v);
      toast('Enregistré.', 'ok');
      route();
    },
  });
  onActions(body, {
    add: () => form(null),
    edit: (id) => form(methods.find((x) => x.id === id)),
    remove: (id) => del(`/api/payment-methods/${id}`, `« ${esc(methods.find((x) => x.id === id).name)} »`),
  });
}

async function adminUsers(body, seq) {
  const users = await api('GET', '/api/users');
  if (seq !== renderSeq) return;
  const roleLabel = (r) => (r === 'admin' ? 'Responsable' : 'Serveur');
  body.innerHTML = `
    <div class="filters"><span class="spacer"></span><button class="btn btn-primary" data-act="add">＋ Nouvel utilisateur</button></div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Nom</th><th>Identifiant</th><th>Rôle</th><th>État</th><th class="right">Actions</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td><strong>${esc(u.full_name)}</strong>${u.id === state.user.id ? ' <span class="muted small">(vous)</span>' : ''}</td>
        <td class="num">${esc(u.username)}</td><td>${roleLabel(u.role)}</td>
        <td>${u.active ? '<span class="badge badge-paid">Actif</span>' : '<span class="badge badge-cancelled">Désactivé</span>'}</td>
        <td class="right"><button class="btn btn-sm" data-act="edit" data-id="${u.id}">Modifier</button></td>
      </tr>`).join('')}</tbody></table></div>
    <p class="muted small">Le responsable a accès à la gestion, aux statistiques et peut annuler des commandes. Le serveur prend les commandes et encaisse.</p>`;
  const roles = [{ value: 'serveur', label: 'Serveur' }, { value: 'admin', label: 'Responsable' }];
  onActions(body, {
    add: () => formModal({
      title: 'Nouvel utilisateur',
      fields: [
        { name: 'full_name', label: 'Nom complet', required: true, maxlength: 80 },
        { name: 'username', label: 'Identifiant de connexion', required: true, maxlength: 50, autocomplete: 'off', hint: 'Lettres, chiffres, « . », « - » ou « _ ».' },
        { name: 'role', label: 'Rôle', type: 'select', options: roles, value: 'serveur' },
        { name: 'password', label: 'Mot de passe', type: 'password', required: true, autocomplete: 'new-password', hint: 'Au moins 6 caractères.' },
      ],
      onSubmit: async (v) => { await api('POST', '/api/users', v); toast('Utilisateur créé.', 'ok'); route(); },
    }),
    edit: (id) => {
      const u = users.find((x) => x.id === id);
      formModal({
        title: `Modifier « ${u.full_name} »`,
        fields: [
          { name: 'full_name', label: 'Nom complet', required: true, value: u.full_name, maxlength: 80 },
          { name: 'role', label: 'Rôle', type: 'select', options: roles, value: u.role },
          { name: 'active', label: 'Compte actif', type: 'checkbox', value: !!u.active },
          { name: 'password', label: 'Nouveau mot de passe (laisser vide pour ne pas changer)', type: 'password', autocomplete: 'new-password' },
        ],
        onSubmit: async (v) => {
          if (!v.password) delete v.password;
          await api('PUT', `/api/users/${id}`, v);
          toast('Utilisateur modifié.', 'ok');
          route();
        },
      });
    },
  });
}

async function adminSettings(body) {
  body.innerHTML = `
    <form class="card form-grid" id="settings-form" style="max-width:520px">
      <label>Nom de l’établissement<input name="bar_name" maxlength="60" required value="${esc(state.settings.bar_name)}"></label>
      <label>Devise<input name="currency" maxlength="10" required value="${esc(state.settings.currency)}"></label>
      <p class="form-error" id="settings-error"></p>
      <div><button class="btn btn-primary" type="submit">Enregistrer</button></div>
    </form>`;
  $('#settings-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      state.settings = await api('PUT', '/api/settings', { bar_name: f.bar_name.value, currency: f.currency.value });
      $('#bar-name').textContent = state.settings.bar_name;
      document.title = state.settings.bar_name;
      toast('Paramètres enregistrés.', 'ok');
    } catch (err) { $('#settings-error', body).textContent = err.message; }
  });
  // Point d'extension : la version navigateur y ajoute la sauvegarde / restauration.
  window.iceHooks?.settingsExtras?.(body);
}

/* ---------- Démarrage ---------- */
/** Première ouverture : création de l'établissement et du compte du responsable. */
function showSetup() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  const loginForm = $('#login-form');
  loginForm.hidden = true;
  const card = document.createElement('form');
  card.className = 'login-card setup-card';
  card.id = 'setup-form';
  card.noValidate = true;
  card.innerHTML = `
    <div class="login-logo" aria-hidden="true">🧊</div>
    <h1>Bienvenue sur ICE MANAGER</h1>
    <p class="muted">Première ouverture : configurez votre établissement et créez le compte du responsable.
      Vous pourrez ensuite créer les comptes des serveurs dans Gestion → Utilisateurs.</p>
    <label>Nom de l’établissement<input id="setup-bar" name="bar_name" maxlength="60" required placeholder="Ex. : Bar Le Glacier"></label>
    <label>Votre nom<input id="setup-name" name="full_name" maxlength="80" required autocomplete="name"></label>
    <label>Identifiant de connexion<input id="setup-user" name="username" maxlength="50" required autocomplete="username" placeholder="Ex. : patron"></label>
    <label>Mot de passe<input id="setup-pass" name="password" type="password" required autocomplete="new-password"></label>
    <label>Confirmer le mot de passe<input id="setup-pass2" name="confirm" type="password" required autocomplete="new-password"></label>
    <p class="form-error" id="setup-error" role="alert"></p>
    <button class="btn btn-primary btn-lg btn-block" type="submit">Créer mon établissement</button>
    <p class="muted small">Un catalogue de départ (bières, vins, sucreries…), 8 tables et les paiements Espèces,
      Orange Money, MTN Mobile Money et Wave sont créés : modifiez-les dans Gestion.</p>`;
  loginForm.after(card);
  setTimeout(() => $('#setup-bar').focus(), 30);
  card.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(card));
    const error = $('#setup-error');
    if (Object.values(v).some((x) => !String(x).trim())) {
      error.textContent = 'Remplissez tous les champs.';
      return;
    }
    if (v.password !== v.confirm) {
      error.textContent = 'Les deux mots de passe ne correspondent pas.';
      return;
    }
    const btn = $('button[type=submit]', card);
    btn.disabled = true;
    btn.textContent = 'Création en cours…';
    try {
      await api('POST', '/api/platform/setup', v);
    } catch (err) {
      if (err.status !== 409) {
        error.textContent = err.message;
        btn.disabled = false;
        btn.textContent = 'Créer mon établissement';
        return;
      }
      toast(err.message);
    }
    card.remove();
    loginForm.hidden = false;
    // Connexion automatique avec le compte qui vient d'être créé.
    loginForm.username.value = v.username;
    loginForm.password.value = v.password;
    loginForm.requestSubmit();
  });
}

(async function init() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    state.settings = me.settings;
    showApp();
  } catch {
    const platform = await api('GET', '/api/platform').catch(() => null);
    if (platform?.status === 'setup') showSetup();
    else showLogin();
  }
})();
