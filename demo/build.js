'use strict';

// Construit deux pages autonomes qui contiennent l'interface (public/), le code serveur (server/)
// et SQLite en WebAssembly, et fonctionnent sans serveur :
//   demo/dist/ice-manager.html       la plateforme : données partagées entre appareils (stockage de l'artefact)
//   demo/dist/ice-manager-demo.html  la démo : données d'exemple, conservées dans le navigateur
//
//   npm run build:web

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Modules CommonJS embarqués. Les modules Node indisponibles dans le navigateur sont remplacés.
const MODULES = [
  'server/app.js', 'server/db.js', 'server/database.js', 'server/http.js', 'server/time.js', 'server/stock.js',
  'server/routes/catalog.js', 'server/routes/orders.js', 'server/routes/stats.js', 'server/routes/users.js',
  'server/routes/stock.js', 'server/routes/reports.js', 'server/routes/customers.js', 'server/routes/suppliers.js',
  'demo/main.js', 'demo/seed-demo.js', 'demo/shared-store.js',
  'demo/shims/express.js', 'demo/shims/sqlite.js', 'demo/shims/security.js',
];
const ALIASES = {
  express: 'demo/shims/express.js',
  'node:sqlite': 'demo/shims/sqlite.js',
  'server/security.js': 'demo/shims/security.js',
};
const BUILTINS = {
  'node:fs': '{ mkdirSync() {} }',
  'node:path': '{ dirname: (p) => p.replace(/\\/[^/]*$/, ""), join: (...p) => p.join("/") }',
};

function bundle() {
  const defs = MODULES.map((file) =>
    `${JSON.stringify(file)}: function (module, exports, require, __filename, __dirname) {\n${read(file)}\n}`);
  return `(function () {
  const defs = {\n${defs.join(',\n')}\n};
  const aliases = ${JSON.stringify(ALIASES)};
  const builtins = { ${Object.entries(BUILTINS).map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')} };
  const cache = {};
  function resolve(from, request) {
    if (builtins[request]) return request;
    if (aliases[request]) return aliases[request];
    const parts = from.split('/').slice(0, -1);
    for (const seg of request.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    const file = parts.join('/') + (request.endsWith('.js') ? '' : '.js');
    return aliases[file] || file;
  }
  function load(id) {
    if (builtins[id]) return builtins[id];
    if (cache[id]) return cache[id].exports;
    if (!defs[id]) throw new Error('Module introuvable : ' + id);
    const module = { exports: {} };
    cache[id] = module;
    defs[id](module, module.exports, (request) => load(resolve(id, request)), id, id.slice(0, id.lastIndexOf('/')));
    return module.exports;
  }
  load('demo/main.js');
})();`;
}

const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`;

function build(mode, title, filename) {
  const index = read('public/index.html');
  const body = index
    .slice(index.indexOf('<body>') + '<body>'.length, index.indexOf('</body>'))
    .replace(/\s*<script src="app\.js"><\/script>/, '');
  const sqlJs = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.js'), 'utf8');
  const wasm = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')).toString('base64');

  const html = [
    `<title>${title}</title>`,
    `<style>\n${read('public/style.css')}\n${read('demo/demo.css')}\n</style>`,
    body.trim(),
    inlineScript(sqlJs),
    inlineScript(`window.__SQL_WASM_B64 = "${wasm}";\nwindow.__ICE_MODE = ${JSON.stringify(mode)};`),
    inlineScript(bundle()),
    inlineScript(read('public/app.js')),
    inlineScript(read('demo/platform-ui.js')),
  ].join('\n');

  const out = path.join(__dirname, 'dist', filename);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`Page générée : ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} Ko)`);
}

build('shared', 'ICE MANAGER', 'ice-manager.html');
build('demo', 'ICE MANAGER Démo', 'ice-manager-demo.html');
