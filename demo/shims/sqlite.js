'use strict';

// Équivalent de `node:sqlite` (DatabaseSync) au-dessus de sql.js (SQLite compilé en WebAssembly).
// Chaque requête prépare puis libère sa propre instruction : sql.js libère toutes les instructions
// ouvertes lors d'un export de la base (sauvegarde dans le navigateur).

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

class DatabaseSync {
  constructor() {
    const SQL = globalThis.__SQL;
    this.raw = globalThis.__ICE_DB_BYTES ? new SQL.Database(globalThis.__ICE_DB_BYTES) : new SQL.Database();
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    const raw = () => this.raw;
    const execute = (params, mode) => {
      const st = raw().prepare(sql);
      try {
        st.bind(params.map(norm));
        if (mode === 'get') return st.step() ? st.getAsObject() : undefined;
        if (mode === 'all') {
          const rows = [];
          while (st.step()) rows.push(st.getAsObject());
          return rows;
        }
        st.step();
        return undefined;
      } finally {
        st.free();
      }
    };
    return {
      get: (...params) => execute(params, 'get'),
      all: (...params) => execute(params, 'all'),
      run: (...params) => {
        execute(params, 'run');
        const changes = raw().getRowsModified();
        const lastInsertRowid = raw().exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid };
      },
    };
  }

  /** Contenu binaire de la base, pour la sauvegarde locale. */
  export() {
    const bytes = this.raw.export();
    this.raw.exec('PRAGMA foreign_keys = ON;'); // export() réinitialise les PRAGMA
    return bytes;
  }

  close() {
    this.raw.close();
  }
}

module.exports = { DatabaseSync };
