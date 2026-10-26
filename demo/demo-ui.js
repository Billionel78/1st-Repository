'use strict';

// Ajustements de l'interface propres à la démo en ligne (chargé après public/app.js).
(function demoUi() {
  // Identifiants de démonstration et réinitialisation, sur l'écran de connexion.
  const form = document.getElementById('login-form');
  const note = document.createElement('div');
  note.className = 'demo-note';
  note.innerHTML = `
    <strong>Version de démonstration</strong>
    <span>Responsable : <code>admin</code> / <code>admin123</code></span>
    <span>Serveur : <code>awa</code> / <code>serveur1</code></span>
    <span class="muted small">Les données d'exemple et vos essais restent dans ce navigateur.</span>
    <button type="button" class="btn btn-sm" id="demo-reset">Réinitialiser la démo</button>`;
  form.append(note);
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
  document.querySelector('.brand').insertAdjacentHTML('beforeend', '<span class="demo-pill">DÉMO</span>');

  // Les téléchargements sont bloqués dans l'aperçu : les exports s'affichent pour être copiés dans Excel.
  document.addEventListener('click', async (e) => {
    const link = e.target.closest('a[href^="/api/reports/"]');
    if (!link) return;
    e.preventDefault();
    const res = await window.__iceDemo.handle(link.getAttribute('href'));
    const text = (await res.text()).replace(/^﻿/, '');
    if (!res.ok) {
      toast(JSON.parse(text).error, 'err');
      return;
    }
    const modal = openModal({
      title: esc(link.textContent.replace(/^⬇️\s*/, '')),
      wide: true,
      body: `<p class="muted">Dans l'application installée, ce bouton télécharge un fichier Excel (CSV).
        Ici, copiez le contenu puis collez-le dans Excel ou Google Sheets.</p>
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
  }, true);

  // L'impression est indisponible dans l'aperçu : le ticket s'affiche à l'écran.
  window.print = () => {
    const ticket = document.getElementById('ticket');
    if (ticket) {
      openModal({
        title: 'Aperçu du ticket',
        body: `<div class="ticket-preview">${ticket.innerHTML}</div>
          <p class="muted small">Dans l'application installée, ce ticket part directement à l'imprimante (format 80 mm).</p>`,
        foot: '<button class="btn btn-primary" data-close>Fermer</button>',
      });
    } else {
      toast("L'impression n'est pas disponible dans cet aperçu. Elle fonctionne dans l'application installée.");
    }
  };
})();
