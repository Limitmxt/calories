/* Tiny IndexedDB wrapper for meals (with photos). Everything else is in localStorage. */
const DB = (() => {
  const NAME = 'calphoto';
  const VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meals')) {
          const s = db.createObjectStore('meals', { keyPath: 'id' });
          s.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('meals', mode);
      const store = t.objectStore('meals');
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    put: (meal) => tx('readwrite', s => s.put(meal)),
    del: (id) => tx('readwrite', s => s.delete(id)),
    get: (id) => tx('readonly', s => s.get(id)),
    byDate: (date) => tx('readonly', s => s.index('date').getAll(date)),
    all: () => tx('readonly', s => s.getAll()),
    clear: () => tx('readwrite', s => s.clear()),
    // meals between two YYYY-MM-DD strings, inclusive
    range: (from, to) => tx('readonly', s => s.index('date').getAll(IDBKeyRange.bound(from, to))),
  };
})();
