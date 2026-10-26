'use strict';

// Version minimale d'Express pour la démo dans le navigateur : juste ce qu'utilise server/app.js
// (middlewares, routes avec paramètres, gestion des erreurs). Les gestionnaires sont synchrones.

function compile(path) {
  const keys = [];
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${source}$`), keys };
}

function express() {
  const layers = [];
  const app = {
    disable() {},
    set() {},
    use(path, fn) {
      if (typeof path === 'function') layers.push({ fn: path });
      else layers.push({ prefix: path, fn });
    },
    handle(req, res) {
      let i = 0;
      let error = null;
      const next = (err) => {
        if (err) error = err;
        while (i < layers.length && !res.finished) {
          const layer = layers[i++];
          if (layer.method && layer.method !== req.method) continue;
          if (layer.prefix && !(req.path === layer.prefix || req.path.startsWith(`${layer.prefix}/`))) continue;
          if (layer.route) {
            const m = req.path.match(layer.route.re);
            if (!m) continue;
            req.params = Object.fromEntries(layer.route.keys.map((k, j) => [k, decodeURIComponent(m[j + 1])]));
          }
          const isErrorHandler = layer.fn.length === 4;
          if (Boolean(error) !== isErrorHandler) continue;
          let called = false;
          const step = (e) => { called = true; next(e); };
          try {
            if (isErrorHandler) {
              const e = error;
              error = null;
              layer.fn(e, req, res, step);
            } else {
              layer.fn(req, res, step);
            }
          } catch (e) {
            if (!called) next(e);
          }
          return;
        }
      };
      next();
    },
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, ...fns) => {
      for (const fn of fns) layers.push({ method: method.toUpperCase(), route: compile(path), fn });
    };
  }
  return app;
}

express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

module.exports = express;
