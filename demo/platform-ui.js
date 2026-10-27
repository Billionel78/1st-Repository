'use strict';

// Ajustements de l'interface pour la version navigateur (chargé après public/app.js) :
// configuration initiale, mode démo, actualisation en direct, exports, impression, sauvegardes.
(async function platformUi() {
  const info = await (await fetch('/api/platform')).json();
  const loginCard = document.getElementById('login-form');
  const downloads = () => (window.claude?.use ? window.claude.use('downloads') : Promise.resolve(null));

  if (info.mode === 'demo') {
    document.querySelector('.brand').insertAdjacentHTML('beforeend', '<span class="demo-pill">DÉMO</span>');
    const note = document.createElement('div');
    note.className = 'demo-note';
    note.innerHTML = `
      <strong>Version de démonstration</strong>
      <span>Responsable : <code>admin</code> / <code>admin123</code></span>
      <span>Serveur : <code>awa</code> / <code>serveur1</code></span>
      <span class="muted small">Les données d'exemple et vos essais restent dans ce navigateur.</span>
      <button type="button" class="btn btn-sm" id="demo-reset">Réinitialiser la démo</button>`;
    loginCard.append(note);
    const reset = document.getElementById('demo-reset');
    reset.addEventListener('click', () => {
      if (reset.dataset.confirm) {
        window.__iceDemo.reset();
        return;
      }
      reset.dataset.confirm = '1';
      reset.textContent = 'Confirmer : effacer mes essais et recharger';
      reset.classList.add('btn-danger');
    });
  } else if (info.status === 'setup') {
    renderSetup();
  } else if (info.status === 'unavailable') {
    loginCard.innerHTML = `
      <div class="login-logo" aria-hidden="true">🧊</div>
      <h1>ICE MANAGER</h1>
      <p class="form-error">Les données de l’établissement sont inaccessibles depuis cet écran.</p>
      <p class="muted">Ouvrez le lien de la plateforme dans claude.ai, connecté avec un compte qui y a accès
        (le compte du propriétaire, ou un compte invité comme éditeur), puis rechargez la page.</p>`;
  } else {
    loginCard.insertAdjacentHTML('beforeend',
      '<p class="muted small sync-note">Les données sont partagées en direct entre tous vos appareils.</p>');
  }

  function renderSetup() {
    loginCard.hidden = true;
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
    loginCard.after(card);
    card.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(card));
      const error = card.querySelector('#setup-error');
      if (v.password !== v.confirm) {
        error.textContent = 'Les deux mots de passe ne correspondent pas.';
        return;
      }
      const btn = card.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Création en cours…';
      const res = await fetch('/api/platform/setup', { method: 'POST', body: JSON.stringify(v) });
      const data = await res.json();
      if (!res.ok && res.status !== 409) {
        error.textContent = data.error;
        btn.disabled = false;
        btn.textContent = 'Créer mon établissement';
        return;
      }
      card.remove();
      loginCard.hidden = false;
      if (res.ok) {
        // Connexion automatique avec le compte qui vient d'être créé.
        loginCard.username.value = v.username;
        loginCard.password.value = v.password;
        loginCard.requestSubmit();
      } else {
        toast(data.error);
      }
    });
  }

  // Modifications faites sur un autre appareil : on actualise les écrans « en direct ».
  let pending = null;
  window.addEventListener('ice:remote-change', () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (!state.user || modalOpen()) return;
      const active = document.activeElement;
      if (active && active.closest('#view') && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
      if (/^#\/(famille\/\d+|tables|commandes|commande\/\d+|stock)?$/.test(location.hash || '#/')) route();
    }, 300);
  });

  async function offerFile(filename, text, title) {
    const dl = await downloads();
    if (dl) {
      try {
        await dl.save({ filename, data: text });
        return;
      } catch (err) {
        if (err?.code === 'declined') return;
      }
    }
    const modal = openModal({
      title: esc(title),
      wide: true,
      body: `<p class="muted">Le téléchargement n’est pas disponible ici. Copiez le contenu puis collez-le
        dans Excel ou Google Sheets (ou dans un fichier texte pour une sauvegarde).</p>
        <textarea id="csv-text" class="csv-text" readonly rows="14">${esc(text)}</textarea>`,
      foot: '<button class="btn" data-close>Fermer</button><button class="btn btn-primary" id="csv-copy">Copier</button>',
    });
    modal.querySelector('#csv-copy').addEventListener('click', async () => {
      const area = modal.querySelector('#csv-text');
      try {
        await navigator.clipboard.writeText(area.value);
        toast('Contenu copié.', 'ok');
      } catch {
        area.focus();
        area.select();
        toast('Sélection faite : utilisez Ctrl+C (ou Cmd+C) pour copier.');
      }
    });
  }

  // Exports Excel : fichier CSV proposé au téléchargement (ou à copier si indisponible).
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a[href^="/api/reports/"]');
    if (!link) return;
    e.preventDefault();
    const res = await fetch(link.getAttribute('href'));
    const text = await res.text();
    if (!res.ok) {
      toast(JSON.parse(text).error, 'err');
      return;
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export.csv';
    await offerFile(filename, text, link.textContent.replace(/^⬇️\s*/, ''));
  }, true);

  // L'impression est indisponible dans le lecteur : le ticket s'affiche à l'écran.
  window.print = () => {
    const ticket = document.getElementById('ticket');
    if (ticket) {
      openModal({
        title: 'Ticket',
        body: `<div class="ticket-preview">${ticket.innerHTML}</div>
          <p class="muted small">L’impression directe n’est pas disponible dans cette version en ligne :
          présentez ce ticket à l’écran ou faites une capture.</p>`,
        foot: '<button class="btn btn-primary" data-close>Fermer</button>',
      });
    } else {
      toast('L’impression n’est pas disponible dans cette version en ligne.');
    }
  };

  // Gestion → Paramètres : sauvegarde et restauration de toutes les données.
  window.iceHooks = {
    settingsExtras(body) {
      body.insertAdjacentHTML('beforeend', `
        <div class="card form-grid" style="max-width:520px;margin-top:1rem">
          <h3>Sauvegarde des données</h3>
          <p class="muted small">La sauvegarde contient toutes les données : produits, commandes, paiements, stock et
            utilisateurs. Faites-en une régulièrement (par exemple chaque semaine) et conservez le fichier.</p>
          <div class="row">
            <button class="btn btn-primary" type="button" id="backup-btn">⬇️ Télécharger une sauvegarde</button>
            <label class="btn" for="restore-file">⬆️ Restaurer une sauvegarde</label>
            <input type="file" id="restore-file" accept=".json,application/json" hidden>
          </div>
          <p class="form-error" id="backup-error"></p>
        </div>`);
      body.querySelector('#backup-btn').addEventListener('click', async () => {
        const res = await fetch('/api/platform/backup');
        const data = await res.json();
        if (!res.ok) {
          body.querySelector('#backup-error').textContent = data.error;
          return;
        }
        const date = data.created_at.slice(0, 10);
        await offerFile(`sauvegarde-ice-manager_${date}.json`, JSON.stringify(data), 'Sauvegarde');
      });
      body.querySelector('#restore-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          body.querySelector('#backup-error').textContent = 'Ce fichier n’est pas une sauvegarde ICE MANAGER valide.';
          return;
        }
        const when = data.created_at ? new Date(data.created_at).toLocaleString('fr-FR') : 'date inconnue';
        const ok = await confirmModal('Restaurer une sauvegarde',
          `Toutes les données actuelles seront remplacées par la sauvegarde du <strong>${esc(when)}</strong>
          (${esc(data.bar_name || '')}), sur tous les appareils. Continuer ?`, { confirmLabel: 'Restaurer', danger: true });
        if (!ok) return;
        const res = await fetch('/api/platform/restore', { method: 'POST', body: JSON.stringify(data) });
        const out = await res.json();
        if (!res.ok) {
          body.querySelector('#backup-error').textContent = out.error;
          return;
        }
        toast('Sauvegarde restaurée. Reconnectez-vous.', 'ok');
        setTimeout(() => location.reload(), 1200);
      });
    },
  };
})();
