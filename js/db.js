// IndexedDB del dispositivo:
// - outbox: cola de escrituras pendientes hacia SharePoint (se procesan en
//   orden; si se cae el wifi de la bodega, la recepción sigue y sube sola).
// - blobs: fotos de pallet y firmas pendientes de subir.
// - kv: copias locales (órdenes, historial de proveedores, recepción en curso).
// - m_<lista>: las "listas" del modo demo.

import { CONFIG } from "./config.js";

const DB_NAME = CONFIG.useMock ? "hub-recepcion-demo" : "hub-recepcion";
// La base se abre en la versión que YA tenga el equipo (sin pedir un número
// fijo): un equipo que quedó en otra versión no falla con "VersionError".
// Solo si falta alguna tabla se sube una versión para crearla. Las tablas
// m_<lista> existen únicamente en la base del modo demo.
const TABLAS = ["outbox", "blobs", "kv", ...(CONFIG.useMock ? Object.keys(CONFIG.sp.listas).map((l) => "m_" + l) : [])];
let dbPromise = null;

function crearTablas(db) {
  if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
  if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
  if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
  for (const n of TABLAS) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: "ID" });
}

function abrir(version) {
  return new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => crearTablas(req.result);
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña necesita actualizar la base, esta cede la conexión.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      if (document.querySelector(".aviso-fijo")) return;
      const a = document.createElement("div");
      a.className = "aviso aviso-fijo";
      a.textContent = "La app está abierta en otra pestaña o ventana con una versión anterior. Ciérrala para continuar.";
      document.body.prepend(a);
    };
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let db = await abrir();
    if (TABLAS.some((t) => !db.objectStoreNames.contains(t))) {
      const v = db.version + 1;
      db.close();
      db = await abrir(v);
    }
    return db;
  })();
  dbPromise.catch(() => (dbPromise = null));
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
