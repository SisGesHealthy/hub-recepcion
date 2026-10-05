// IndexedDB del dispositivo:
// - outbox: cola de escrituras pendientes hacia SharePoint (se procesan en
//   orden; si se cae el wifi de la bodega, la recepción sigue y sube sola).
// - blobs: fotos de pallet y firmas pendientes de subir.
// - kv: copias locales (órdenes, historial de proveedores, recepción en curso).
// - m_<lista>: las "listas" del modo demo.

import { CONFIG } from "./config.js";

const DB_NAME = "hub-recepcion";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
      for (const lista of Object.keys(CONFIG.sp.listas)) {
        const n = "m_" + lista;
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: "ID" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const r = fn(t.objectStore(storeName));
        t.oncomplete = () => resolve(r?.result);
        t.onerror = () => reject(t.error);
      })
  );
}

export const idb = {
  put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
  get: (store, key) => run(store, "readonly", (s) => s.get(key)).then((v) => v ?? null),
  getAll: (store) => run(store, "readonly", (s) => s.getAll()).then((v) => v || []),
  delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  clear: (store) => run(store, "readwrite", (s) => s.clear()),
};

export const kv = {
  async get(k, def = null) {
    const r = await idb.get("kv", k);
    return r ? r.v : def;
  },
  set: (k, v) => idb.put("kv", { k, v }),
  del: (k) => idb.delete("kv", k),
};
