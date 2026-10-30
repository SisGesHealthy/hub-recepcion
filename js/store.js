// Lógica de negocio sobre las listas existentes de la Power App.
//
// Enlace entre listas (igual que la Power App): el número ID_N de la orden
// (propiedad OData__x0049_D2, ej. 20510 = orden 2 del 05/10) se copia en
//   Liberaciones.ID_1 · PalletsRecepcion.RecepcionID · Recepciones.ID_1
//
// Toda escritura pasa por una cola (outbox) en IndexedDB y se sube en orden:
// si el wifi de la bodega se cae, el bodeguero sigue pesando pallets y todo
// sube solo al volver la señal. Cada operación es idempotente (antes de
// crear, busca si ya existe por su clave) para que un reintento no duplique.

import { CONFIG } from "./config.js";
import { idb, kv } from "./db.js";

let api = null;
let usuario = null;
const oyentes = new Set();
let estadoSync = { pendientes: 0, error: null, sincronizando: false };

export async function initStore() {
  api = CONFIG.useMock ? (await import("./mock.js")).api : (await import("./sp.js")).api;
  if (CONFIG.useMock) await (await import("./mock.js")).sembrarDemo();
  await refrescarEstadoSync();
  window.addEventListener("online", () => sincronizar());
  setInterval(() => sincronizar(), 30000);
  sincronizar();
}

export function getApi() {
  return api;
}

// ---------------- usuario y accesos ----------------

export const MODULOS = ["bodega", "calidad", "planta", "pesos", "temp", "averias", "config"];
const accesosDe = (c) => (c === CONFIG.administrador ? [...MODULOS] : CONFIG.accesos[c] || []);

export function setUsuario(nombre, correo) {
  const c = (correo || "").toLowerCase();
  usuario = { nombre, correo: c, accesos: accesosDe(c) };
  return usuario;
}
export const getUsuario = () => usuario;

// ---------------- utilidades ----------------

const TZ = "America/Guayaquil";
export function fmtFecha(iso, conHora = true) {
  if (!iso) return "";
  const o = { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" };
  if (conHora) Object.assign(o, { hour: "2-digit", minute: "2-digit", hour12: false });
  return new Date(iso).toLocaleString("es-EC", o).replace(",", "");
}
export function fmtHora(iso) {
  return iso ? new Date(iso).toLocaleTimeString("es-EC", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}
export function fmtKg(n) {
  return (Math.round((n || 0) * 10) / 10).toLocaleString("es-EC", { maximumFractionDigits: 1 });
}
export const norm = (s) => (s || "").trim().replace(/\s+/g, " ").toLowerCase();
const r2 = (n) => Math.round(n * 100) / 100;
export const idnDe = (orden) => orden.OData__x0049_D2;

// ---------------- outbox ----------------

export function onSync(fn) {
  oyentes.add(fn);
  fn(estadoSync);
  return () => oyentes.delete(fn);
}
async function refrescarEstadoSync(extra = {}) {
  const ops = await idb.getAll("outbox");
  estadoSync = { ...estadoSync, ...extra, pendientes: ops.length };
  oyentes.forEach((f) => f(estadoSync));
}

async function encolar(op, blob) {
  if (blob) {
    op.blobId = crypto.randomUUID();
    await idb.put("blobs", { id: op.blobId, blob });
  }
  op.creado = Date.now();
  await idb.put("outbox", op);
  await refrescarEstadoSync();
  sincronizar();
}

async function buscarUno(lista, where) {
  const r = await api.items(lista, { where, top: 1, orderby: "ID desc" });
  return r[0] || null;
}

async function ejecutar(op) {
  const blob = op.blobId ? (await idb.get("blobs", op.blobId))?.blob : null;
  if (op.tipo === "add") {
    let item = op.clave ? await buscarUno(op.lista, op.clave) : null;
    if (!item) item = await api.add(op.lista, op.campos);
    if (op.foto && blob) await api.attachImage(op.lista, item.ID, op.foto.campo, blob, op.foto.ext);
    if (op.camposFinales) await api.update(op.lista, item.ID, op.camposFinales);
  } else if (op.tipo === "update" || op.tipo === "updateWhere") {
    const id = op.tipo === "update" ? op.id : (await buscarUno(op.lista, op.where))?.ID;
    if (!id) throw Object.assign(new Error(`No se encontró en ${op.lista} el registro a actualizar.`), { status: 404 });
    // Imagen primero y luego UNA sola escritura con todos los campos: cada
    // escritura dispara un aviso al flujo de Power Automate, y varias seguidas
    // en el mismo segundo pueden hacer que el correo salga dos veces.
    if (op.foto && blob) await api.attachImage(op.lista, id, op.foto.campo, blob, op.foto.ext);
    const todos = { ...(op.campos || {}), ...(op.camposFinales || {}) };
    if (Object.keys(todos).length) await api.update(op.lista, id, todos);
  } else if (op.tipo === "removeWhere") {
    const it = await buscarUno(op.lista, op.where);
    if (it) await api.remove(op.lista, it.ID);
  }
  if (op.blobId) await idb.delete("blobs", op.blobId);
}

let corriendo = null;
let repetir = false;
export function sincronizar() {
  if (corriendo) {
    // Lo encolado mientras se sube se procesa al terminar esta vuelta.
    repetir = true;
    return corriendo;
  }
  corriendo = (async () => {
    if (!navigator.onLine && !CONFIG.useMock) return;
    const ops = (await idb.getAll("outbox")).sort((a, b) => a.seq - b.seq);
    if (!ops.length) return refrescarEstadoSync({ error: null });
    await refrescarEstadoSync({ sincronizando: true });
    for (const op of ops) {
      try {
        await ejecutar(op);
        await idb.delete("outbox", op.seq);
        await refrescarEstadoSync({ error: null });
      } catch (e) {
        // Se detiene para no subir algo fuera de orden (ej. un pallet antes
        // que su recepción). Reintenta en el próximo ciclo.
        console.warn("Sync detenido:", e);
        await refrescarEstadoSync({ error: e.message || String(e) });
        break;
      }
    }
  })().finally(async () => {
    corriendo = null;
    await refrescarEstadoSync({ sincronizando: false });
    if (repetir && !estadoSync.error) {
      repetir = false;
      sincronizar();
    }
    repetir = false;
  });
  return corriendo;
}

export async function descartarPrimeraOperacion() {
  const ops = (await idb.getAll("outbox")).sort((a, b) => a.seq - b.seq);
  if (ops[0]) await idb.delete("outbox", ops[0].seq);
  await refrescarEstadoSync({ error: null });
  sincronizar();
}

// ---------------- órdenes ----------------

// Lee de SharePoint y deja copia local; sin red devuelve la copia.
export async function listarOrdenes() {
  try {
    const rows = await api.items("ordenes", { where: [["Estado", "eq", "Programada"]], orderby: "FechaProgramada asc", top: 500 });
    await kv.set("cache:ordenes", rows);
    return { rows: await conPendientes(rows), offline: false };
  } catch (e) {
    console.warn(e);
    return { rows: await kv.get("cache:ordenes", []), offline: true };
  }
}

// Lo que SharePoint todavía no tiene (cambios en cola) se superpone a lo
// leído, para que una orden liberada/completada sin señal no "vuelva".
async function conPendientes(rows) {
  const ops = (await idb.getAll("outbox")).filter((o) => o.lista === "ordenes" && o.tipo === "update");
  if (!ops.length) return rows;
  return rows.map((r) => ops.filter((o) => o.id === r.ID).reduce((acc, o) => ({ ...acc, ...o.campos }), r));
}

// Paradas de un lote registradas pero aún en cola.
export async function paradasPendientes(loteTitle) {
  return (await idb.getAll("outbox")).filter((o) => o.lista === "registros" && o.campos?.Title === loteTitle).map((o) => ({ ...o.campos, pendiente: true }));
}

// Aplica en la copia local un cambio que todavía está en la cola.
async function parcharOrdenLocal(id, campos) {
  const rows = await kv.get("cache:ordenes", []);
  await kv.set("cache:ordenes", rows.map((o) => (o.ID === id ? { ...o, ...campos } : o)));
}

export function clasificarOrdenes(rows) {
  const limite = Date.now() - CONFIG.diasAtraso * 86400000;
  const finHoy = new Date();
  finHoy.setHours(23, 59, 59, 999);
  const g = { atrasadas: [], hoy: [], proximas: [] };
  for (const o of rows) {
    const t = new Date(o.FechaProgramada).getTime();
    if (t < limite) g.atrasadas.push(o);
    else if (t <= finHoy.getTime()) g.hoy.push(o);
    else g.proximas.push(o);
  }
  return g;
}

export async function cancelarOrden(orden) {
  await parcharOrdenLocal(orden.ID, { Estado: "Cancelada" });
  await encolar({ tipo: "update", lista: "ordenes", id: orden.ID, campos: { Estado: "Cancelada" } });
}

// ---------------- recepción (bodega) ----------------

// Recepciones "En Proceso" en SharePoint → botón "Continuar" en vez de crear
// una segunda recepción para la misma orden (la Power App dejaba 6 colgadas).
export async function recepcionesEnProceso() {
  try {
    const rows = await api.items("recepciones", { where: [["Estado", "eq", "En Proceso"]], top: 200 });
    const set = rows.map((r) => r.ID_1);
    await kv.set("cache:enproceso", set);
    // Una recepción cancelada cuyo cambio aún está en la cola ya no cuenta
    // como "en proceso" (si no, la orden mostraría "Continuar" unos segundos).
    const cerrandose = new Set(
      (await idb.getAll("outbox"))
        .filter((o) => o.lista === "recepciones" && (o.tipo === "removeWhere" || o.campos?.Estado === "Finalizada" || o.camposFinales?.Estado === "Finalizada"))
        .map((o) => o.where?.find((w) => w[0] === "ID_1")?.[2])
    );
    return new Set(set.filter((idn) => !cerrandose.has(idn)));
  } catch {
    return new Set(await kv.get("cache:enproceso", []));
  }
}

const kRec = (idn) => `rec:${idn}`;

export async function getRecepcionLocal(idn) {
  return kv.get(kRec(idn));
}

// Copia local de una recepción que ya no está abierta en SharePoint (se
// finalizó o borró desde otro equipo): se descarta para no retomarla. Sin
// red, o con cambios aún en cola, se conserva.
export async function recepcionLocalVigente(idn) {
  const rec = await kv.get(kRec(idn));
  if (!rec) return null;
  const enCola = (await idb.getAll("outbox")).some((o) =>
    [...(o.where || []), ...(o.clave || [])].some((w) => (w[0] === "ID_1" || w[0] === "RecepcionID_Num_x002c_") && w[2] === idn) ||
    o.campos?.RecepcionID_Num_x002c_ === idn
  );
  if (enCola) return rec;
  try {
    const abierta = await buscarUno("recepciones", [["ID_1", "eq", idn], ["Estado", "eq", "En Proceso"]]);
    if (abierta) return rec;
  } catch {
    return rec;
  }
  for (const p of rec.pallets) if (p.fotoLocal) await idb.delete("blobs", p.fotoLocal);
  await kv.del(kRec(idn));
  return null;
}

export async function listarRecepcionesLocales() {
  const all = await idb.getAll("kv");
  return all.filter((x) => x.k.startsWith("rec:")).map((x) => x.v);
}

// Recepción ya FINALIZADA de esta misma orden. Pasa cuando Bodega devuelve la
// orden a "Programada" para agregar pallets (llegó otro viaje, faltó pesar
// algo). Solo cuenta si empezó después de creada la orden: el mismo ID_N del
// año anterior no se confunde.
export async function recepcionPrevia(orden) {
  const idn = idnDe(orden);
  await esperarColaDe(idn);
  const desde = new Date(new Date(orden.Created || 0).getTime() - 86400000);
  let previa = null;
  try {
    previa = await buscarUno("recepciones", [["ID_1", "eq", idn], ["Estado", "eq", "Finalizada"], ["HoraLlegada", "ge", desde]]);
  } catch {
    return null;
  }
  if (!previa) return null;
  const pallets = await palletsDelServidor(idn, previa.HoraLlegada);
  return { item: previa, pallets, neto: r2(pallets.reduce((a, p) => a + (+p.neto || 0), 0)) };
}

// Antes de buscar en SharePoint qué recepción tiene esta orden, se deja subir
// lo que esté en cola para ella (ej. una cancelación recién hecha); si no,
// se podría retomar la fila que se está borrando. Sin red se sigue igual.
async function esperarColaDe(idn, maxMs = 15000) {
  const t0 = Date.now();
  const pendiente = async () =>
    (await idb.getAll("outbox")).some((o) => o.lista === "recepciones" && o.where?.some((w) => w[0] === "ID_1" && w[2] === idn));
  while ((await pendiente()) && Date.now() - t0 < maxMs && (navigator.onLine || CONFIG.useMock)) {
    await sincronizar();
    if (estadoSync.error) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// previa: resultado de recepcionPrevia() si el usuario eligió continuarla.
export async function iniciarRecepcion(orden, previa = null) {
  const idn = idnDe(orden);
  const existente = await recepcionLocalVigente(idn);
  if (existente) return existente;
  await esperarColaDe(idn);
  const ahora = new Date().toISOString();
  const rec = { idn, orden, inicio: ahora, pallets: [] };

  // ¿Ya se había empezado en otro dispositivo / en la Power App?
  let enServidor = null;
  try {
    enServidor = await buscarUno("recepciones", [["ID_1", "eq", idn], ["Estado", "eq", "En Proceso"]]);
  } catch {}
  if (enServidor) {
    rec.inicio = enServidor.HoraLlegada || ahora;
    rec.pallets = await palletsDelServidor(idn, rec.inicio);
    if (enServidor.EstadoAnterior === "Reabierta") {
      rec.reabierta = true;
      rec.nPrevios = rec.pallets.length;
    }
  } else if (previa) {
    // Reabrir: misma fila de Recepciones, mismos pallets, numeración sigue.
    // Al finalizar se reescriben totales/firma y el flujo reenvía el resumen
    // completo (su filtro HoraLlegada–HoraCierre abarca todos los pallets).
    rec.inicio = previa.item.HoraLlegada;
    rec.pallets = previa.pallets;
    rec.reabierta = true;
    rec.nPrevios = previa.pallets.length;
    await encolar({ tipo: "update", lista: "recepciones", id: previa.item.ID, campos: { Estado: "En Proceso", EstadoAnterior: "Reabierta" } });
  } else {
    await encolar({
      tipo: "add",
      lista: "recepciones",
      clave: [["ID_1", "eq", idn], ["Estado", "eq", "En Proceso"]],
      campos: {
        Title: `Recepción ${fmtFecha(ahora)}`,
        ID_1: idn,
        Proveedor: orden.Proveedor,
        Fruta: orden.Fruta,
        HoraLlegada: ahora,
        Estado: "En Proceso",
        Operario: usuario?.nombre || "",
      },
    });
  }
  await kv.set(kRec(idn), rec);
  return rec;
}

// El ID_N no es único en el tiempo: una orden recibida dos veces, o el mismo
// número al año siguiente (n + día + mes), comparten RecepcionID. Por eso se
// toman solo los pallets registrados desde que empezó ESTA recepción.
async function palletsDelServidor(idn, desde) {
  const inicio = new Date(new Date(desde).getTime() - 60000); // 1 min de margen por reloj
  const rows = await api.items("pallets", {
    where: [["RecepcionID_Num_x002c_", "eq", idn], ["HoraRegistro", "ge", inicio]],
    orderby: "NumeroPallet asc",
  });
  return rows.map((p) => ({
    idLocal: p.Title || `sp-${p.ID}`,
    spId: p.ID,
    numero: p.NumeroPallet,
    bruto: p.PesoBruto || 0,
    taraPallet: p.PesoTara || 0,
    envases: p.Envases || 0,
    pUnit: p.P_unitario || 0,
    neto: p.PesoNeto || 0,
    obs: p.Observaciones || "",
    hora: p.HoraRegistro,
    fotoRemota: p.FotoPallet ? { lista: "pallets", id: p.ID, valor: p.FotoPallet } : null,
  }));
}

export function calcNeto({ bruto = 0, taraPallet = 0, envases = 0, pUnit = 0 }) {
  return r2((+bruto || 0) - (+taraPallet || 0) - (+envases || 0) * (+pUnit || 0));
}

export function totales(rec) {
  const t = { bruto: 0, tara: 0, neto: 0, envases: 0, n: rec.pallets.length };
  for (const p of rec.pallets) {
    t.bruto += +p.bruto || 0;
    t.tara += (+p.taraPallet || 0) + (+p.envases || 0) * (+p.pUnit || 0);
    t.neto += +p.neto || 0;
    t.envases += +p.envases || 0;
  }
  t.bruto = r2(t.bruto);
  t.tara = r2(t.tara);
  // El neto TOTAL se trunca al kilo inferior (366,5 → 366): así lo procesa
  // producción/Odoo. Cada pallet conserva su neto exacto; netoPesado es la
  // suma sin truncar, solo para mostrar.
  t.netoPesado = r2(t.neto);
  t.neto = Math.floor(t.netoPesado + 1e-9);
  const prog = +rec.orden.CantidadProgramada || 0;
  t.programado = prog;
  t.restante = r2(prog - t.neto);
  t.desvio = prog ? (t.neto - prog) / prog : 0;
  return t;
}

// Recuerda tara/peso de envase por proveedor+fruta: el siguiente pallet (y
// la siguiente recepción del mismo proveedor) los trae precargados.
const kTara = (orden) => `tara:${norm(orden.Proveedor)}|${orden.Fruta}`;
export async function getTaraRecordada(orden) {
  return kv.get(kTara(orden), { taraPallet: 0, pUnit: 0 });
}

export async function guardarPallet(rec, datos, fotoBlob) {
  const editando = datos.idLocal && rec.pallets.find((p) => p.idLocal === datos.idLocal);
  const neto = calcNeto(datos);
  const ahora = new Date().toISOString();
  const pallet = editando
    ? { ...editando, ...datos, neto }
    : { ...datos, idLocal: crypto.randomUUID(), numero: Math.max(0, ...rec.pallets.map((p) => p.numero || 0)) + 1, neto, hora: ahora };
  if (fotoBlob) {
    pallet.fotoLocal = crypto.randomUUID();
    await idb.put("blobs", { id: pallet.fotoLocal, blob: fotoBlob });
  }
  rec.pallets = editando ? rec.pallets.map((p) => (p.idLocal === pallet.idLocal ? pallet : p)) : [...rec.pallets, pallet];
  rec.modificada = true;
  await kv.set(kRec(rec.idn), rec);
  await kv.set(kTara(rec.orden), { taraPallet: +datos.taraPallet || 0, pUnit: +datos.pUnit || 0 });

  const campos = {
    NumeroPallet: pallet.numero,
    PesoBruto: +pallet.bruto || 0,
    PesoTara: +pallet.taraPallet || 0,
    Envases: +pallet.envases || 0,
    P_unitario: +pallet.pUnit || 0,
    PesoNeto: neto,
    Observaciones: pallet.obs || null,
  };
  const foto = fotoBlob ? { campo: "FotoPallet", ext: "jpg" } : null;
  if (editando) {
    const where = pallet.spId ? [["ID", "eq", pallet.spId]] : [["Title", "eq", pallet.idLocal]];
    await encolar({ tipo: "updateWhere", lista: "pallets", where, campos, foto }, fotoBlob);
  } else {
    await encolar(
      {
        tipo: "add",
        lista: "pallets",
        clave: [["Title", "eq", pallet.idLocal]],
        campos: { ...campos, Title: pallet.idLocal, RecepcionID_Num_x002c_: rec.idn, HoraRegistro: ahora, Operario: usuario?.nombre || "" },
        foto,
      },
      fotoBlob
    );
  }
  return pallet;
}

export async function eliminarPallet(rec, idLocal) {
  const p = rec.pallets.find((x) => x.idLocal === idLocal);
  if (!p) return;
  rec.pallets = rec.pallets.filter((x) => x.idLocal !== idLocal);
  rec.modificada = true;
  await kv.set(kRec(rec.idn), rec);
  const where = p.spId ? [["ID", "eq", p.spId]] : [["Title", "eq", p.idLocal]];
  await encolar({ tipo: "removeWhere", lista: "pallets", where });
}

// Último correo/conductor/placa usados con cada proveedor. Hoy el correo se
// escribe a mano en cada recepción y el historial tiene decenas de errores
// (gmaio.com, yahooo.com, "Jp"...).
export async function historialProveedores() {
  try {
    const rows = await api.items("recepciones", {
      where: [["Estado", "eq", "Finalizada"]],
      orderby: "ID desc",
      top: 800,
      select: ["Proveedor", "Correo", "Conductor", "Placa", "ID"],
    });
    const mapa = {};
    for (const r of rows) {
      const k = norm(r.Proveedor);
      if (!k) continue;
      const m = (mapa[k] ||= {});
      const correo = (r.Correo || "").trim().toLowerCase();
      if (!m.correo && correoValido(correo) && !CONFIG.correosRelleno.includes(correo)) m.correo = correo;
      if (!m.conductor && r.Conductor) m.conductor = r.Conductor.trim();
      if (!m.placa && r.Placa) m.placa = r.Placa.trim().toUpperCase();
    }
    await kv.set("cache:proveedores", mapa);
    return mapa;
  } catch {
    return kv.get("cache:proveedores", {});
  }
}

export function correoValido(c) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(c || "");
}

const DOMINIOS = ["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "live.com", "icloud.com", "healthyfood.com.ec", "yahoo.es", "hotmail.es"];
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// "juan@gmaio.com" → "juan@gmail.com"
export function sugerirCorreo(c) {
  const m = (c || "").trim().toLowerCase().match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  let dom = m[2].replace(/\.con$/, ".com").replace(/\.comm$/, ".com");
  if (DOMINIOS.includes(dom)) return dom === m[2] ? null : `${m[1]}@${dom}`;
  let mejor = null;
  for (const d of DOMINIOS) {
    const dist = distancia(dom, d);
    if (dist <= 2 && (!mejor || dist < mejor.dist)) mejor = { d, dist };
  }
  return mejor ? `${m[1]}@${mejor.d}` : null;
}

export async function finalizarRecepcion(rec, datos, firmaBlob) {
  const t = totales(rec);
  const ahora = new Date().toISOString();
  await encolar(
    {
      tipo: "updateWhere",
      lista: "recepciones",
      where: [["ID_1", "eq", rec.idn], ["Estado", "eq", "En Proceso"]],
      campos: {
        TotalBruto: t.bruto,
        TotalTara: t.tara, // la Power App lo dejaba siempre en 0
        TotalNeto: t.neto, // truncado al kilo inferior (ver totales())
        HoraCierre: ahora,
        Correo: datos.correo,
        Conductor: datos.conductor,
        Placa: datos.placa,
        Bodeguero: datos.bodeguero,
        ObservacionesProveedor: datos.observaciones || null,
        Operario: usuario?.nombre || "",
      },
      foto: firmaBlob ? { campo: "FirmaProveedor", ext: "png" } : null,
      // Al final y por separado: el flujo de correo se dispara con este
      // cambio, cuando la firma y los totales ya están guardados.
      camposFinales: { Estado: "Finalizada", EstadoAnterior: "En Proceso" },
    },
    firmaBlob
  );
  await encolar({ tipo: "update", lista: "ordenes", id: rec.orden.ID, campos: { Estado: "Completada" } });
  await parcharOrdenLocal(rec.orden.ID, { Estado: "Completada" });
  const prov = await kv.get("cache:proveedores", {});
  prov[norm(rec.orden.Proveedor)] = { correo: datos.correo, conductor: datos.conductor, placa: datos.placa };
  await kv.set("cache:proveedores", prov);
  await kv.set("ultimoBodeguero", datos.bodeguero);
  for (const p of rec.pallets) if (p.fotoLocal) await idb.delete("blobs", p.fotoLocal);
  await kv.del(kRec(rec.idn));
  return t;
}

// Se puede cancelar solo si no se tocó ningún pallet (nueva: 0 pallets;
// reabierta: los mismos que tenía y sin cambios pendientes en la cola).
export function puedeCancelar(rec) {
  if (!rec.reabierta) return rec.pallets.length === 0;
  return rec.pallets.length === (rec.nPrevios || 0) && !rec.modificada;
}

// "Cancelar" una recepción abierta por error y sin pallets: quita la fila
// vacía de Recepciones (va a la papelera del sitio) y la orden vuelve a
// mostrar "Iniciar recepción".
export async function cancelarRecepcionVacia(rec) {
  if (!puedeCancelar(rec)) throw new Error("La recepción ya tiene cambios en sus pallets: finalízala.");
  if (rec.reabierta) {
    // Vuelve a quedar como estaba (EstadoAnterior Finalizada: no reenvía correo)
    // y la orden, que Bodega había devuelto a "Programada", vuelve a Completada.
    await encolar({ tipo: "updateWhere", lista: "recepciones", where: [["ID_1", "eq", rec.idn], ["Estado", "eq", "En Proceso"]], campos: { Estado: "Finalizada", EstadoAnterior: "Finalizada" } });
    await encolar({ tipo: "update", lista: "ordenes", id: rec.orden.ID, campos: { Estado: "Completada" } });
    await parcharOrdenLocal(rec.orden.ID, { Estado: "Completada" });
  } else {
    await encolar({ tipo: "removeWhere", lista: "recepciones", where: [["ID_1", "eq", rec.idn], ["Estado", "eq", "En Proceso"]] });
  }
  await kv.del(kRec(rec.idn));
}

// ---------------- consulta de recepciones cerradas ----------------

export async function listarRecepcionesCerradas(dias = 7) {
  const desde = new Date(Date.now() - dias * 86400000);
  desde.setHours(0, 0, 0, 0);
  return api.items("recepciones", {
    where: [["Estado", "eq", "Finalizada"], ["HoraCierre", "ge", desde]],
    orderby: "HoraCierre desc",
    top: 300,
    select: ["ID", "ID_1", "Proveedor", "Fruta", "TotalNeto", "HoraLlegada", "HoraCierre", "Bodeguero", "Correo", "EstadoAnterior"],
  });
}

// Todo lo que el operador pasa a papel: recepción + orden + liberación +
// pallets (los de ESTA recepción: mismo ID_N y pesados entre llegada y cierre).
export async function detalleRecepcion(id) {
  const rec = (await api.items("recepciones", { where: [["ID", "eq", id]], top: 1 }))[0];
  if (!rec) return null;
  const idn = rec.ID_1;
  const [ordenes, libs, pallets] = await Promise.all([
    api.items("ordenes", { where: [["OData__x0049_D2", "eq", idn]], orderby: "ID desc", top: 1 }),
    api.items("liberaciones", { where: [["ID_1", "eq", idn]], orderby: "ID desc", top: 5 }),
    palletsDelServidor(idn, rec.HoraLlegada),
  ]);
  const fin = rec.HoraCierre ? new Date(rec.HoraCierre).getTime() + 60000 : Infinity;
  const enRango = pallets.filter((p) => !p.hora || new Date(p.hora).getTime() <= fin);
  const pendiente = (await idb.getAll("outbox")).some((o) => o.lista === "recepciones" && o.where?.some((w) => w[0] === "ID_1" && w[2] === idn));
  return { rec, orden: ordenes[0] || null, liberacion: libs[0] || null, liberaciones: libs, pallets: enRango, pendiente };
}

// Vuelve a disparar el flujo de correo de una recepción ya cerrada: el
// disparador se activa con Estado = Finalizada y EstadoAnterior = En Proceso.
export async function reenviarResumen(rec) {
  await encolar({ tipo: "update", lista: "recepciones", id: rec.ID, campos: { EstadoAnterior: "En Proceso" } });
}

// ---------------- calidad: liberación de MP ----------------

// PUNTO DE CONTROL del procedimiento: Bodega solo recibe si existe el análisis
// de Calidad (registro "Liberado" en Liberaciones). No basta con que la orden
// diga Estado_calidad = Liberado: la Power App a veces lo marca sin crear el
// registro (orden 30610, 06/10) y el resumen salía sin °Brix/pH/acidez.
// Devuelve { ID_N: fecha de la última liberación }. Sin red usa la última
// copia; si nunca se descargó queda vacío → no se habilita nada.
export async function ordenesLiberadas() {
  try {
    const rows = await api.items("liberaciones", { where: [["Estado", "eq", "Liberado"]], orderby: "ID desc", top: 400, select: ["ID_1", "Created"] });
    const mapa = {};
    for (const r of rows) if (!mapa[r.ID_1]) mapa[r.ID_1] = r.Created;
    // Liberaciones hechas en este equipo y aún en cola también cuentan.
    for (const o of await idb.getAll("outbox"))
      if (o.lista === "liberaciones" && o.campos?.Estado === "Liberado") mapa[o.campos.ID_1] = new Date(o.creado).toISOString();
    await kv.set("cache:liberadas", mapa);
    return mapa;
  } catch {
    return kv.get("cache:liberadas", {});
  }
}

// El ID_N se repite cada año: solo vale una liberación posterior a la orden.
export function liberadaSegun(mapa, orden) {
  const f = mapa[idnDe(orden)];
  if (!f) return false;
  return new Date(f).getTime() >= new Date(orden.Created || 0).getTime() - 86400000;
}

export async function tieneLiberacion(orden) {
  return liberadaSegun(await ordenesLiberadas(), orden);
}

export async function ultimasLiberaciones(fruta, n = 3) {
  try {
    return await api.items("liberaciones", { where: [["Fruta", "eq", fruta], ["Estado", "eq", "Liberado"]], orderby: "ID desc", top: n });
  } catch {
    return [];
  }
}

export async function registrarLiberacion(orden, { brix, ph, acidez, obs, inicio }, decision) {
  const ahora = new Date().toISOString();
  const titulo = `Liberación ${fmtFecha(ahora)}`;
  await encolar({
    tipo: "add",
    lista: "liberaciones",
    clave: [["ID_1", "eq", idnDe(orden)], ["Title", "eq", titulo]],
    campos: {
      Title: titulo,
      ID_1: idnDe(orden),
      Proveedor: orden.Proveedor,
      Fruta: orden.Fruta,
      HoraLlegada: inicio || ahora,
      HoraCierre: ahora,
      Estado: decision,
      Operario: usuario?.nombre || "",
      OData__x00b0_Brix: brix,
      PH: ph,
      Acidez: acidez,
      Observaciones: obs || null,
    },
  });
  await encolar({ tipo: "update", lista: "ordenes", id: orden.ID, campos: { Estado_calidad: decision } });
  await parcharOrdenLocal(orden.ID, { Estado_calidad: decision });
}

// Historial para Calidad: cada liberación con lo que Bodega recibió después
// (trazabilidad). Se lee por ID desc y se filtra en el equipo: así no depende
// de columnas indexadas aunque las listas pasen los 5.000 ítems.
// Enlace liberación → recepción: mismo ID_N y llegada desde 1 día antes de
// la liberación (el ID_N se repite cada año). Pallets: mismo ID_N y pesados
// entre la llegada y el cierre de esa recepción (igual que detalleRecepcion).
// Solo cuentan recepciones hasta 30 días después de la liberación.
export async function historialLiberaciones(dias = 30) {
  const desde = new Date(Date.now() - dias * 86400000);
  desde.setHours(0, 0, 0, 0);
  const t0 = desde.getTime();
  const fechaLib = (l) => new Date(l.HoraCierre || l.Created).getTime();
  const libs = (await api.items("liberaciones", { orderby: "ID desc", top: Math.max(600, dias * 15) })).filter((l) => fechaLib(l) >= t0);
  if (!libs.length) return [];
  const margen = new Date(t0 - 2 * 86400000);
  const [recs, ordenes, pallets] = await Promise.all([
    api.items("recepciones", {
      where: [["HoraLlegada", "ge", margen]],
      orderby: "HoraLlegada asc",
      top: 3000,
      select: ["ID", "ID_1", "Estado", "TotalNeto", "TotalBruto", "TotalTara", "HoraLlegada", "HoraCierre", "Bodeguero", "Conductor", "Placa", "ObservacionesProveedor"],
    }),
    api.items("ordenes", { orderby: "ID desc", top: Math.max(800, dias * 20), select: ["ID", "OData__x0049_D2", "Created", "FechaProgramada", "CantidadProgramada", "Unidad", "Estado"] }),
    api.items("pallets", {
      where: [["HoraRegistro", "ge", margen]],
      orderby: "HoraRegistro asc",
      top: 5000,
      select: ["ID", "RecepcionID_Num_x002c_", "HoraRegistro", "PesoBruto", "PesoNeto", "Envases", "P_unitario"],
    }),
  ]);
  const por = (rows, k) => rows.reduce((m, r) => ((m[r[k]] ??= []).push(r), m), {});
  const recsDe = por(recs, "ID_1"), ordDe = por(ordenes, "OData__x0049_D2"), palDe = por(pallets, "RecepcionID_Num_x002c_");
  libs.sort((a, b) => fechaLib(b) - fechaLib(a));
  return libs.map((l) => {
    const tl = fechaLib(l);
    const ords = ordDe[l.ID_1] || [];
    const orden = ords.find((o) => new Date(o.Created).getTime() <= tl + 3600000) || ords.find((o) => Math.abs(new Date(o.Created).getTime() - tl) < 30 * 86400000) || null;
    const recepciones = (recsDe[l.ID_1] || []).filter((r) => {
      const t = new Date(r.HoraLlegada).getTime();
      return t >= tl - 86400000 && t <= tl + 30 * 86400000;
    });
    const pals = recepciones.flatMap((r) => {
      const a = new Date(r.HoraLlegada).getTime() - 60000;
      const b = r.HoraCierre ? new Date(r.HoraCierre).getTime() + 60000 : Infinity;
      return (palDe[l.ID_1] || []).filter((p) => {
        const t = new Date(p.HoraRegistro).getTime();
        return t >= a && t <= b;
      });
    });
    const fin = recepciones.filter((r) => r.Estado === "Finalizada");
    const pesosEnv = [...new Set(pals.map((p) => +p.P_unitario || 0).filter(Boolean))];
    return {
      lib: l,
      orden,
      recepciones,
      estadoRecepcion: !recepciones.length ? "Sin recibir" : fin.length === recepciones.length ? "Recibida" : "En proceso",
      netoRecibido: fin.length ? fin.reduce((s, r) => s + (+r.TotalNeto || 0), 0) : null,
      bruto: pals.reduce((s, p) => s + (+p.PesoBruto || 0), 0),
      pallets: pals.length,
      envases: pals.reduce((s, p) => s + (+p.Envases || 0), 0),
      pesoEnvase: pesosEnv.map((x) => x.toLocaleString("es-EC", { maximumFractionDigits: 3 })).join(" / "),
      llegada: recepciones[0]?.HoraLlegada || null,
      cierre: fin.at(-1)?.HoraCierre || null,
      bodeguero: [...new Set(recepciones.map((r) => r.Bodeguero).filter(Boolean))].join(", "),
      conductor: [...new Set(recepciones.map((r) => r.Conductor).filter(Boolean))].join(", "),
      placa: [...new Set(recepciones.map((r) => r.Placa).filter(Boolean))].join(", "),
    };
  });
}

// ---------------- calidad - planta ----------------

export async function catalogo() {
  try {
    const rows = await api.items("catalogo", { top: 1000 });
    await kv.set("cache:catalogo", rows);
    return rows;
  } catch {
    return kv.get("cache:catalogo", []);
  }
}

// ---- Órdenes de fabricación de Odoo (archivo cifrado junto a la app) ----

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function descifrar(sobre, claveB64) {
  const key = await crypto.subtle.importKey("raw", b64(claveB64), "AES-GCM", false, ["decrypt"]);
  const plano = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(sobre.iv) }, key, b64(sobre.data));
  return JSON.parse(new TextDecoder().decode(plano));
}

// { generado, ofs:[{of, fecha, codigo, producto, cantidad, unidad, estado, lote_odoo}], error? }
export async function cargarOF() {
  if (CONFIG.useMock) return (await import("./mock.js")).ofsDemo();
  try {
    const leer = async (u) => {
      const r = await fetch(`${u}?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      return r.json();
    };
    // Se leen las dos copias (repositorio directo y Pages) y se usa la más
    // reciente: cada una tiene su propia caché (raw ~5 min, Pages ~10 min) y
    // cualquiera de las dos puede ir atrasada.
    const sobres = (await Promise.allSettled([leer(CONFIG.of.datosDirecto), leer(CONFIG.of.datos)])).filter((r) => r.status === "fulfilled").map((r) => r.value);
    if (!sobres.length) throw new Error("No se pudo descargar el archivo de órdenes");
    let clave = await kv.get("of:clave");
    const abrir = async (k) => (await Promise.all(sobres.map((sb) => descifrar(sb, k)))).sort((a, b) => String(b.generado).localeCompare(String(a.generado)))[0];
    let datos;
    try {
      if (!clave) throw new Error("sin clave");
      datos = await abrir(clave);
    } catch {
      // Clave nueva o aún no descargada: se pide a SharePoint (solo con sesión).
      clave = await api.leerTexto(CONFIG.of.clave);
      datos = await abrir(clave);
      await kv.set("of:clave", clave);
    }
    await kv.set("cache:of", datos);
    return datos;
  } catch (e) {
    console.warn("OF de Odoo:", e);
    const cache = await kv.get("cache:of");
    const msg = e.status === 404 ? "No se encontró la clave en SharePoint (Documentos compartidos/HubRecepcion/clave_of.txt)." : "No se pudieron leer las órdenes de Odoo.";
    return cache ? { ...cache, error: msg + " Se muestra la última copia." } : { ofs: [], error: msg };
  }
}

// ---- fechas "solo día" (Ecuador, UTC-5; SharePoint guarda medianoche local = 05:00Z) ----

export const hoyISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
export const diaISO = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : "");
export const diaASP = (d) => new Date(`${d}T00:00:00-05:00`).toISOString();
export function sumarDias(d, n) {
  const x = new Date(`${d}T12:00:00-05:00`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toLocaleDateString("en-CA", { timeZone: TZ });
}
export function diaDelAnio(d) {
  const [y, m, dd] = d.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(y, 0, 1)) / 86400000) + 1;
}
export const fmtDia = (d) => (d ? d.split("-").reverse().join("/") : "");

let propOF = null;
async function campoOF() {
  if (propOF === null) propOF = (await api.propiedadDeCampo("lotes", CONFIG.of.columnaLotes)) || "";
  return propOF;
}

// Lotes con fecha de producción = ese día (cualquier estado) + nombre de la
// propiedad de la columna OF, para agrupar por orden.
export async function lotesDelDia(d) {
  const prop = await campoOF();
  try {
    const rows = await api.items("lotes", {
      where: [["Fechadeproducci_x00f3_n", "ge", new Date(diaASP(d))], ["Fechadeproducci_x00f3_n", "lt", new Date(diaASP(sumarDias(d, 1)))]],
      orderby: "ID asc",
      top: 500,
    });
    const pend = (await idb.getAll("outbox")).filter((o) => o.lista === "lotes" && o.tipo === "add" && diaISO(o.campos.Fechadeproducci_x00f3_n) === d).map((o) => ({ ...o.campos, ID: null, pendiente: true }));
    const todos = [...rows, ...pend.filter((p) => !rows.some((r) => r.Title === p.Title && (r[prop] || "") === (p[prop] || "")))];
    await kv.set(`cache:lotes:${d}`, todos);
    return { lotes: todos, prop };
  } catch {
    return { lotes: await kv.get(`cache:lotes:${d}`, []), prop };
  }
}

export async function getLote(id) {
  const r = await api.items("lotes", { where: [["ID", "eq", id]], top: 1 });
  return r[0] || null;
}

// Último lote del mismo producto (para sugerir código y mostrar su vida útil).
export async function ultimoLoteDeProducto(catId) {
  if (!catId) return null;
  try {
    return (await api.items("lotes", { where: [["Producto_x002d_CODId", "eq", catId]], orderby: "ID desc", top: 1 }))[0] || null;
  } catch {
    return null;
  }
}

// Regla del código: el último lote del producto con su día del año y año
// cambiados por los de la nueva fecha de elaboración.
//   L2642615 (elab. 21/09 = día 264) → L2782615 para el 05/10 (día 278)
//   HF PB 265 26 → HF PB 278 26
export function sugerirCodigoLote(prev, fechaElab) {
  if (!prev?.Title || !prev.field_2) return null;
  const pd = diaISO(prev.field_2);
  const viejo = [String(diaDelAnio(pd)).padStart(3, "0"), pd.slice(2, 4)];
  const nuevo = [String(diaDelAnio(fechaElab)).padStart(3, "0"), fechaElab.slice(2, 4)];
  const re = new RegExp(`${viejo[0]}(\\s?)${viejo[1]}`);
  if (!re.test(prev.Title)) return null;
  return prev.Title.replace(re, `${nuevo[0]}$1${nuevo[1]}`);
}

export async function crearLote({ codigo, of, fechaProduccion, fechaElab, fechaCad, catId }) {
  const prop = await campoOF();
  const campos = {
    Title: codigo,
    field_2: diaASP(fechaElab),
    field_3: diaASP(fechaCad),
    field_4: "Programado",
    Fechadeproducci_x00f3_n: diaASP(fechaProduccion),
    ...(catId ? { Producto_x002d_CODId: catId } : {}),
    ...(prop && of ? { [prop]: of } : {}),
  };
  const clave = [["Title", "eq", codigo], ["Fechadeproducci_x00f3_n", "eq", new Date(diaASP(fechaProduccion))]];
  if (prop && of) clave.push([prop, "eq", of]);
  await encolar({ tipo: "add", lista: "lotes", clave, campos });
  return campos;
}

export async function editarLote(lote, { codigo, fechaElab, fechaCad }) {
  await encolar({ tipo: "update", lista: "lotes", id: lote.ID, campos: { Title: codigo, field_2: diaASP(fechaElab), field_3: diaASP(fechaCad) } });
}

export async function listarLotes() {
  const desde = new Date(Date.now() - CONFIG.diasLotes * 86400000);
  desde.setHours(0, 0, 0, 0);
  try {
    const rows = await api.items("lotes", {
      where: [["field_4", "eq", "Programado"], ["Fechadeproducci_x00f3_n", "ge", desde]],
      orderby: "ID desc",
      top: 300,
    });
    await kv.set("cache:lotes", rows);
    return rows;
  } catch {
    return kv.get("cache:lotes", []);
  }
}

// Paradas del lote: mismo código de lote Y misma fecha de producción (un mismo
// código puede repetirse en otro día, ej. "HF PB 265 26").
export async function registrosDeLote(lote) {
  try {
    const where = [["Title", "eq", lote.Title]];
    const f = lote.Fechadeproducci_x00f3_n;
    if (f) where.push(["Fecha_produccion", "ge", new Date(diaASP(diaISO(f)))], ["Fecha_produccion", "lt", new Date(diaASP(sumarDias(diaISO(f), 1)))]);
    return await api.items("registros", { where, orderby: "ID asc", top: 500 });
  } catch {
    return [];
  }
}

// Columnas agregadas a Registros (config.registrosExtra) → nombre de
// propiedad REST, o null si todavía no existe la columna en SharePoint.
let colsReg = null;
export async function columnasRegistros() {
  if (!colsReg) {
    colsReg = {};
    for (const [k, nombre] of Object.entries(CONFIG.registrosExtra)) {
      try {
        colsReg[k] = await api.propiedadDeCampo("registros", nombre);
      } catch {
        colsReg[k] = null;
      }
    }
  }
  return colsReg;
}

// Lee las columnas extra de un registro con claves lógicas.
export async function extrasDe(registro) {
  const cols = await columnasRegistros();
  const out = {};
  for (const [k, prop] of Object.entries(cols)) out[k] = prop ? registro[prop] ?? null : null;
  return out;
}

// Última parada registrada de este producto (para precargar sensorial y
// controles PPRO/PCC, que el analista debe CONFIRMAR o corregir).
export async function ultimoRegistroDeProducto(prod) {
  if (!prod?.Ordenamiento) return null;
  try {
    return (await api.items("registros", { where: [["COD_Producto", "eq", prod.Ordenamiento]], orderby: "ID desc", top: 1 }))[0] || null;
  } catch {
    return null;
  }
}

// Etiqueta de parada como en el Excel: 3 · repetición → 3.1, 3.2…
export function etiquetaParada(r, numRep) {
  const n = r.field_1 ?? "";
  if (!r.Repeticion) return String(n);
  return `${n}.${numRep || 1}`;
}

export function evaluarRango(prod, v) {
  // devuelve { campo: "ok" | "bajo" | "alto" | null }
  const chk = (val, min, max) => {
    if (val === null || val === undefined || val === "" || isNaN(val)) return null;
    if (min !== null && min !== undefined && val < min) return "bajo";
    if (max !== null && max !== undefined && val > max) return "alto";
    return min === null && max === null ? null : "ok";
  };
  if (!prod) return {};
  return {
    brix: chk(v.brix, prod.field_3, prod.field_4),
    ph: chk(v.ph, prod.field_5, prod.field_6),
    acidez: chk(v.acidez, prod.field_7, prod.field_8),
    ratio: chk(v.ratio, prod.field_9, prod.field_10),
  };
}

// v.extra = { color, olor, sabor, pproDesinf, pproFiltrado, pcc1, pcc2,
// liberacion, incidente, correcciones, numRep }. Las columnas que aún no
// existen en SharePoint se omiten y se devuelven en "faltan".
export async function registrarParada(lote, prod, v) {
  const cols = await columnasRegistros();
  const campos = {
    Title: lote.Title,
    field_1: v.parada,
    field_2: v.brix,
    field_3: v.ph,
    field_4: v.acidez,
    field_5: v.recorrido ?? null,
    field_6: v.viscosidad ?? null,
    field_7: v.fruta ?? null,
    field_8: v.ratio ?? null,
    field_9: v.responsable,
    Observaciones: v.obs || null,
    Repeticion: !!v.repeticion,
    Fecha_produccion: lote.Fechadeproducci_x00f3_n,
    COD_Producto: prod?.Ordenamiento || null,
  };
  const faltan = [];
  for (const [k, val] of Object.entries(v.extra || {})) {
    if (val === undefined || val === null || val === "") continue;
    if (cols[k]) campos[cols[k]] = val;
    else faltan.push(CONFIG.registrosExtra[k]);
  }
  const clave = [["Title", "eq", lote.Title], ["field_1", "eq", v.parada], ["Repeticion", "eq", !!v.repeticion], ["Fecha_produccion", "eq", new Date(lote.Fechadeproducci_x00f3_n)]];
  if (cols.numRep && v.extra?.numRep) clave.push([cols.numRep, "eq", v.extra.numRep]);
  await encolar({ tipo: "add", lista: "registros", clave, campos });
  await kv.set("ultimoResponsablePlanta", v.responsable);
  return { campos, faltan };
}

// Microbiología: llega del laboratorio días después y en el 92 % de los lotes
// es igual en todas las paradas (Excel 2026) → se carga una vez por lote y se
// escribe en todas sus paradas.
export async function guardarMicroLote(registros, valores) {
  const cols = await columnasRegistros();
  const campos = {};
  for (const k of ["aerobios", "mohos", "coliformes", "ecoli", "salmonella"]) if (cols[k] && valores[k] !== null && valores[k] !== undefined && valores[k] !== "") campos[cols[k]] = valores[k];
  if (!Object.keys(campos).length) return 0;
  let n = 0;
  for (const r of registros) {
    if (!r.ID) continue;
    await encolar({ tipo: "update", lista: "registros", id: r.ID, campos });
    n++;
  }
  return n;
}

export async function cerrarLote(lote) {
  await encolar({ tipo: "update", lista: "lotes", id: lote.ID, campos: { field_4: "Finalizado" } });
  const rows = await kv.get("cache:lotes", []);
  await kv.set("cache:lotes", rows.filter((l) => l.ID !== lote.ID));
}

// ---------------- configuración editable (SharePoint) ----------------

// Responsables de liberación y bodegueros viven en un JSON en SharePoint
// (Documentos compartidos/HubRecepcion/configuracion.json) que Sistemas edita
// desde la app. Si no existe o no hay red, se usa lo de config.js / la copia.
function aplicarConfig(cfg) {
  if (cfg?.accesos && Object.keys(cfg.accesos).length) {
    // La lista guardada reemplaza a la de config.js (así se pueden quitar cuentas).
    CONFIG.accesos = Object.fromEntries(
      Object.entries(cfg.accesos).map(([k, v]) => {
        let mods = v.filter((m) => MODULOS.includes(m));
        if (!(cfg.accesosVersion >= 2) && mods.includes("bodega") && !mods.includes("temp")) mods = [...mods, "temp"];
        // v3: Averías para todas las cuentas que ya tenían acceso (bodega reporta, Calidad libera).
        if (!(cfg.accesosVersion >= 3) && mods.length && !mods.includes("averias")) mods = [...mods, "averias"];
        return [k.trim().toLowerCase(), mods];
      })
    );
    if (usuario) usuario.accesos = accesosDe(usuario.correo);
  }
  if (cfg?.responsablesPlanta?.length) CONFIG.responsablesPlanta = cfg.responsablesPlanta;
  if (cfg?.bodegueros?.length) CONFIG.bodegueros = cfg.bodegueros;
  if (cfg?.contenedores?.length) CONFIG.contenedores = cfg.contenedores;
  if (cfg?.turnosTemperatura?.length) CONFIG.turnosTemperatura = cfg.turnosTemperatura;
  if (cfg?.ventanasTemperatura) CONFIG.ventanasTemperatura = cfg.ventanasTemperatura;
  if (cfg?.inicialesHistoricas) CONFIG.inicialesHistoricas = { ...CONFIG.inicialesHistoricas, ...cfg.inicialesHistoricas };
}

// Al abrir la app NO se espera a SharePoint: se aplica al instante la última
// copia guardada y la versión actual se descarga en segundo plano (con mala
// señal, esperar el archivo dejaba la pantalla en blanco hasta 20 s).
// La pantalla de Configuración sí espera ({ esperar: true }).
// Error al leer configuracion.json (ej. 403: la cuenta no tiene permiso en el sitio).
export let errorConfig = null;

export async function cargarConfig({ esperar = false } = {}) {
  const cache = await kv.get("cache:config");
  // Primera vez en este equipo (sin copia): hay que esperar, porque de ahí
  // salen los accesos de las cuentas agregadas en Configuración.
  if (!cache) esperar = true;
  aplicarConfig(cache);
  // Accesos con los que se va a pintar (los de la copia, no los de config.js).
  const antes = usuario ? JSON.stringify(accesosDe(usuario.correo)) : null;
  const { carpeta, nombre } = CONFIG.archivoConfig;
  const descarga = api
    .leerTexto(`${carpeta}/${nombre}`)
    .then(async (txt) => {
      const cfg = JSON.parse(txt);
      await kv.set("cache:config", cfg);
      aplicarConfig(cfg);
      errorConfig = null;
      // Se pintó con la copia vieja y a esta cuenta le cambiaron los accesos: recargar.
      // Una sola vez por minuto, por si algo no cuadra (nunca en bucle).
      if (!esperar && usuario && antes !== JSON.stringify(accesosDe(usuario.correo))) {
        let ultima = 0;
        try { ultima = Number(sessionStorage.getItem("hub-recepcion:recargaAccesos")) || 0; } catch {}
        if (Date.now() - ultima > 60000) {
          try { sessionStorage.setItem("hub-recepcion:recargaAccesos", String(Date.now())); } catch {}
          location.reload();
        }
      }
      return cfg;
    })
    .catch((e) => {
      console.warn("configuracion.json:", e.message);
      errorConfig = e;
      return cache;
    });
  return esperar ? descarga : cache;
}

export async function guardarConfig(cfg) {
  const { carpeta, nombre } = CONFIG.archivoConfig;
  const datos = { ...cfg, accesosVersion: 3, actualizado: new Date().toISOString(), por: usuario?.correo || "" };
  await api.escribirArchivo(carpeta, nombre, JSON.stringify(datos, null, 2));
  await kv.set("cache:config", datos);
  await cargarConfig();
}

// "ET" → "Edwin Tulcán" para registros viejos.
export const nombreResponsable = (r) => CONFIG.inicialesHistoricas[(r || "").trim().toUpperCase()] || r || "";

// ---------------- reporte con las columnas del Excel ----------------

// Encabezados EXACTOS de "MODELO LIBERACIONES 2026" (A…AQ), para pegar con
// Ctrl+V sin mover nada. B y C (sistema anterior) quedan vacías.
export const COLUMNAS_EXCEL = [
  "No.", "CODIGO SISTEMA", "NOMBRE SISTEMA", "CÓDIGO OODO", "NUEVO NOMBRE", "CLIENTE ", "LOTE", "PARADA", "F. ELAB", "F. CAD",
  "ALERTA CONTRAMUESTRA", "RESPONSABLE DE LIBERACIÓN ", "BRIX", "pH", "ACIDEZ", "RATIO", "VISCOSIDAD ", "RECORRIDO ", "% FRUTA",
  "BRIX2", "pH3", "ACIDEZ4", "VISCOSIDAD 5", "RECORRIDO 6", "% FRUTA7", "COLOR", "OLOR", "SABOR", "Columna8", "AEROBIOS",
  "MOHOS Y LEVADURAS", "COLIFORMES", "E. COLI", "SALMONELLA", "PPROP (DESINFECCIÓN) ", "PPROP (FILTRADO) ", "PCC 1 (PASTEURIZADO) ",
  "PPC 2 (CONTROL DE PERNOS Y TUERCAS) ", "LIBERACIÓN", "DETALLE INCIDENTE", "CORRECCIONES", "OBSERVACIONES", "FECHA DE PRODUCCIÓN",
];

// Filas del reporte entre dos fechas de producción (inclusive). Cada valor
// queda tipado: { t: "n" número | "d" fecha YYYY-MM-DD | "s" texto, v }.
export async function reporteLiberaciones(desde, hasta) {
  const ini = new Date(diaASP(desde));
  const fin = new Date(diaASP(sumarDias(hasta, 1)));
  const [regs, lotes, cat, cols] = await Promise.all([
    api.items("registros", { where: [["Fecha_produccion", "ge", ini], ["Fecha_produccion", "lt", fin]], orderby: "ID asc", top: 5000 }),
    api.items("lotes", { where: [["Fechadeproducci_x00f3_n", "ge", ini], ["Fechadeproducci_x00f3_n", "lt", fin]], top: 2000 }),
    catalogo(),
    columnasRegistros(),
  ]);
  const ex = (r, k) => (cols[k] ? r[cols[k]] ?? null : null);
  const loteDe = (r) => lotes.find((l) => l.Title === r.Title && diaISO(l.Fechadeproducci_x00f3_n) === diaISO(r.Fecha_produccion)) || null;
  const prodDe = (r) => cat.find((c) => (c.Ordenamiento || "").trim() === (r.COD_Producto || "").trim()) || null;

  // Orden: fecha de producción, lote, parada, repetición.
  regs.sort((a, b) =>
    (diaISO(a.Fecha_produccion) || "").localeCompare(diaISO(b.Fecha_produccion) || "") ||
    (a.Title || "").localeCompare(b.Title || "") ||
    (a.field_1 || 0) - (b.field_1 || 0) ||
    (a.Repeticion ? 1 : 0) - (b.Repeticion ? 1 : 0) ||
    (ex(a, "numRep") || 0) - (ex(b, "numRep") || 0) ||
    a.ID - b.ID
  );

  // T–Y "mediciones no liberadas": en la última medición de cada parada, cuántas
  // anteriores de esa misma parada salieron fuera de rango en cada parámetro.
  const grupos = {};
  for (const r of regs) (grupos[`${r.Title}|${diaISO(r.Fecha_produccion)}|${r.field_1}`] ||= []).push(r);
  const noLib = new Map();
  for (const g of Object.values(grupos)) {
    if (g.length < 2) continue;
    const prod = prodDe(g[0]);
    const cuenta = { brix: 0, ph: 0, acidez: 0 };
    for (const r of g.slice(0, -1)) {
      const ev = evaluarRango(prod, { brix: r.field_2, ph: r.field_3, acidez: r.field_4 });
      for (const k of Object.keys(cuenta)) if (ev[k] === "bajo" || ev[k] === "alto") cuenta[k]++;
    }
    noLib.set(g[g.length - 1], cuenta);
  }

  const hoy = new Date(diaASP(hoyISO()));
  const N = (v) => ({ t: "n", v: v === null || v === undefined || v === "" ? null : Number(v) });
  const S = (v) => ({ t: "s", v: v === null || v === undefined ? "" : String(v) });
  const D = (iso) => ({ t: "d", v: iso ? diaISO(iso) : "" });
  return regs.map((r, i) => {
    const lote = loteDe(r);
    const prod = prodDe(r);
    const cad = lote?.field_3 || null;
    const alerta = cad ? (new Date(cad) < new Date(hoy.getTime() - 30 * 86400000) ? "ALERTA" : "PRODUCTO DENTRO DE VU") : "";
    const nl = noLib.get(r) || {};
    const cnt = (k) => N(nl[k] || null);
    return [
      N(i + 1), S(""), S(""), S(prod?.Title || ""), S(prod?.field_1 || ""), S(prod?.field_2 || ""), S(r.Title),
      S(etiquetaParada(r, ex(r, "numRep"))), D(lote?.field_2), D(cad), S(alerta), S(nombreResponsable(r.field_9)),
      N(r.field_2), N(r.field_3), N(r.field_4), N(r.field_8 != null ? Math.round(r.field_8 * 100) / 100 : null), N(r.field_6), N(r.field_5), N(r.field_7),
      cnt("brix"), cnt("ph"), cnt("acidez"), N(null), N(null), N(null),
      S(ex(r, "color")), S(ex(r, "olor")), S(ex(r, "sabor")), S(""),
      N(ex(r, "aerobios")), N(ex(r, "mohos")), N(ex(r, "coliformes")), N(ex(r, "ecoli")), S(ex(r, "salmonella")),
      S(ex(r, "pproDesinf")), S(ex(r, "pproFiltrado")), S(ex(r, "pcc1")), S(ex(r, "pcc2")),
      S(ex(r, "liberacion")), S(ex(r, "incidente")), S(ex(r, "correcciones")), S(r.Observaciones), D(r.Fecha_produccion),
    ];
  });
}

// Texto separado por tabulaciones para pegar en Excel. Decimales con coma
// (Excel en español de Ecuador) salvo que se pida punto; fechas dd/mm/aaaa.
export function filasATexto(filas, { encabezados = false, decimal = "," } = {}) {
  const cel = (c) => {
    if (c.t === "n") return c.v === null || isNaN(c.v) ? "" : String(c.v).replace(".", decimal);
    if (c.t === "d") return c.v ? c.v.split("-").reverse().join("/") : "";
    return String(c.v || "").replace(/[\t\r\n]+/g, " ").trim();
  };
  const lineas = filas.map((f) => f.map(cel).join("\t"));
  if (encabezados) lineas.unshift(COLUMNAS_EXCEL.join("\t"));
  return lineas.join("\r\n");
}

// Completar después sensorial / controles / liberación de una parada ya
// guardada (el analista registra primero la medición y luego lo demás).
export async function completarParada(registro, extra) {
  const cols = await columnasRegistros();
  const campos = {};
  for (const [k, val] of Object.entries(extra)) if (cols[k] && val !== undefined) campos[cols[k]] = val === "" ? null : val;
  if (!registro.ID || !Object.keys(campos).length) return false;
  await encolar({ tipo: "update", lista: "registros", id: registro.ID, campos });
  return true;
}

// ¿Le faltan sensorial/controles a esta parada?
export const paradaIncompleta = (ex) => !ex || !ex.color || !ex.pproDesinf || !ex.pproFiltrado || !ex.pcc1 || !ex.pcc2 || !ex.liberacion;

// Lotes de los últimos N días cuyas paradas aún no tienen microbiología
// (los resultados llegan del laboratorio días después).
export async function lotesMicroPendiente(dias = 21) {
  const cols = await columnasRegistros();
  if (!cols.aerobios) return [];
  const desde = new Date(diaASP(sumarDias(hoyISO(), -dias)));
  const [regs, lotes] = await Promise.all([
    api.items("registros", { where: [["Fecha_produccion", "ge", desde]], top: 5000 }),
    api.items("lotes", { where: [["Fechadeproducci_x00f3_n", "ge", desde]], top: 2000 }),
  ]);
  const grupos = {};
  for (const r of regs) {
    const k = `${r.Title}|${diaISO(r.Fecha_produccion)}`;
    const g = (grupos[k] ||= { lote: r.Title, fecha: diaISO(r.Fecha_produccion), paradas: 0, conMicro: 0 });
    g.paradas++;
    if (r[cols.aerobios] !== null && r[cols.aerobios] !== undefined) g.conMicro++;
  }
  return Object.values(grupos)
    .filter((g) => g.conMicro < g.paradas)
    .map((g) => ({ ...g, id: lotes.find((l) => l.Title === g.lote && diaISO(l.Fechadeproducci_x00f3_n) === g.fecha)?.ID || null }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// Sube lo pendiente y espera a que termine (incluida la vuelta extra para lo
// encolado mientras subía). Sin red regresa enseguida.
export async function subirAhora() {
  await sincronizar();
  await sincronizar();
}

// ---------------- Control de pesos ----------------

// Parámetros por producto (lista ParametrosPeso, Title = código de Odoo).
export async function parametrosPeso() {
  try {
    const rows = await api.items("parametrosPeso", { top: 2000 });
    await kv.set("cache:paramPeso", rows);
    return rows;
  } catch {
    return kv.get("cache:paramPeso", []);
  }
}

// Presentación del producto según Odoo o su nombre (sin parámetros):
// { nominal, unidad } o null.
//  - productos por unidad: "weight" de Odoo es la presentación (0,397 kg → 397 g);
//  - granel (weight = 1 "por kilo") y cajas de exportación: del nombre
//    ("PULPA DE MORA 14KG" → 14 kg; "12 X 14 OZ" → 396,9 g por unidad).
export function presentacionDe(of) {
  let gramos = null;
  const uom = of.uom_producto || "";
  if (/^unit|^unidad/i.test(uom) && of.peso_kg > 0) gramos = of.peso_kg * 1000;
  if (!gramos) {
    const oz = (of.producto || "").match(/(\d+(?:[.,]\d+)?)\s*OZ\b/i);
    const m = (of.producto || "").match(/(\d+(?:[.,]\d+)?)\s*(KG|KL|KILOS?|G|GR|GRAMOS?)\b/i);
    if (oz) gramos = Math.round(parseFloat(oz[1].replace(",", ".")) * 28.3495 * 10) / 10;
    else if (m) gramos = parseFloat(m[1].replace(",", ".")) * (/^g/i.test(m[2]) ? 1 : 1000);
  }
  if (!gramos && of.peso_kg > 0 && of.peso_kg !== 1) gramos = of.peso_kg * 1000;
  if (!gramos) return null;
  const unidad = gramos >= 2000 ? "kg" : "g";
  return { nominal: unidad === "kg" ? gramos / 1000 : gramos, unidad };
}

// Clave de la presentación en ParametrosPeso: "PRESENTACION 397 G". En gramos
// se redondea al entero (14 oz = 396,9 g → la misma presentación que 397 g).
export function clavePresentacion(pres) {
  if (!pres) return null;
  const n = pres.unidad === "g" ? Math.round(pres.nominal) : Math.round(pres.nominal * 100) / 100;
  return `PRESENTACION ${n} ${pres.unidad}`.toUpperCase();
}
export const etiquetaPresentacion = (clave) => clave.replace(/^PRESENTACION /, "").replace(/ G$/, " g").replace(/ KG$/, " kg");

// Peso que se espera del producto, en este orden:
//  1) excepción configurada para ese producto (Title = código);
//  2) parámetro de su PRESENTACIÓN (Title = "PRESENTACION 397 G"), que
//     comparten todos los productos de igual peso;
//  3) solo el nominal (Odoo o nombre), sin rango.
// Devuelve { nominal, min, max, unidad, origen, param, clave }.
// Presentación efectiva: la ASIGNADA a mano en ParametrosPeso (fila con el
// código del producto, peso nominal y SIN mínimo/máximo; para productos cuyo
// nombre no dice el peso y que Odoo tiene "por kilo", ej. SALS009 = 5 kg) o la
// deducida de Odoo / del nombre.
const esAsignacion = (p) => p?.PesoNominal && p.PesoMinimo == null && p.PesoMaximo == null;
export function presentacionEfectiva(of, params) {
  const propio = params.find((p) => (p.Title || "").trim().toUpperCase() === (of.codigo || "").trim().toUpperCase());
  if (esAsignacion(propio)) return { nominal: propio.PesoNominal, unidad: propio.Unidad || "g", asignada: true };
  return presentacionDe(of);
}

// Peso que se espera del producto, en este orden:
//  1) excepción del producto (Title = código, CON mínimo/máximo);
//  2) parámetro de su PRESENTACIÓN (Title = "PRESENTACION 397 G"), que
//     comparten todos los productos de igual peso;
//  3) solo el nominal (Odoo, nombre o asignado), sin rango.
// Devuelve { nominal, min, max, unidad, origen, param, clave }.
export function especPeso(of, params) {
  const buscar = (t) => params.find((p) => (p.Title || "").trim().toUpperCase() === t) || null;
  const propio = buscar((of.codigo || "").trim().toUpperCase());
  const pres = presentacionEfectiva(of, params);
  const clave = clavePresentacion(pres);
  if (propio?.PesoNominal && !esAsignacion(propio)) return { nominal: propio.PesoNominal, min: propio.PesoMinimo ?? null, max: propio.PesoMaximo ?? null, unidad: propio.Unidad || "g", origen: "producto", param: propio, clave };
  const dePres = clave ? buscar(clave) : null;
  if (dePres?.PesoNominal) return { nominal: dePres.PesoNominal, min: dePres.PesoMinimo ?? null, max: dePres.PesoMaximo ?? null, unidad: dePres.Unidad || pres.unidad, origen: "presentación", param: dePres, clave };
  if (!pres) return { nominal: null, min: null, max: null, unidad: "g", origen: "sin dato", param: null, clave };
  return { nominal: pres.nominal, unidad: pres.unidad, min: null, max: null, origen: pres.asignada ? "asignada" : "Odoo", param: null, clave };
}

export function estadoPeso(valor, esp) {
  if (valor === null || valor === undefined || isNaN(valor)) return null;
  if (esp.min !== null && esp.min !== undefined && valor < esp.min) return "bajo";
  if (esp.max !== null && esp.max !== undefined && valor > esp.max) return "alto";
  return esp.min === null && esp.max === null ? "sinrango" : "ok";
}

// Alta o cambio de un parámetro (solo administrador).
export async function guardarParametroPeso(p) {
  const campos = {
    Title: p.codigo.trim().toUpperCase(),
    Producto: p.producto || "",
    Cliente: p.cliente || "",
    PesoNominal: p.nominal,
    PesoMinimo: p.min,
    PesoMaximo: p.max,
    Unidad: p.unidad,
    Activo: true,
    Notas: p.notas || null,
  };
  if (p.id) await encolar({ tipo: "update", lista: "parametrosPeso", id: p.id, campos });
  else await encolar({ tipo: "add", lista: "parametrosPeso", clave: [["Title", "eq", campos.Title]], campos });
  await subirAhora();
}

export async function controlesDelDia(d) {
  try {
    const rows = await api.items("controlPesos", {
      where: [["Fecha", "ge", new Date(diaASP(d))], ["Fecha", "lt", new Date(diaASP(sumarDias(d, 1)))]],
      orderby: "HoraInicio asc",
      top: 1000,
    });
    const pend = (await idb.getAll("outbox")).filter((o) => o.lista === "controlPesos" && o.tipo === "add" && diaISO(o.campos.Fecha) === d).map((o) => ({ ...o.campos, pendiente: true }));
    return [...rows, ...pend.filter((p) => !rows.some((r) => r.Title === p.Title))];
  } catch {
    return (await idb.getAll("outbox")).filter((o) => o.lista === "controlPesos" && o.tipo === "add" && diaISO(o.campos.Fecha) === d).map((o) => ({ ...o.campos, pendiente: true }));
  }
}

// Visita en curso: se guarda en el dispositivo mientras se toman muestras
// (si se cierra la app o se va la señal no se pierde nada).
// Puede haber varios controles abiertos a la vez (ej. dos líneas dosificando):
// se guardan por id en "pesos:visitas".
async function mapaVisitas() {
  const m = (await kv.get("pesos:visitas")) || {};
  const vieja = await kv.get("pesos:visita"); // formato anterior: uno solo
  if (vieja?.id) {
    m[vieja.id] = vieja;
    await kv.set("pesos:visitas", m);
    await kv.del("pesos:visita");
  }
  return m;
}
export const visitasEnCurso = async () => Object.values(await mapaVisitas()).sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
export const getVisita = async (id) => (await mapaVisitas())[id] || null;
export async function guardarVisitaLocal(v) {
  const m = await mapaVisitas();
  m[v.id] = v;
  await kv.set("pesos:visitas", m);
}
export async function descartarVisita(id) {
  const m = await mapaVisitas();
  delete m[id];
  await kv.set("pesos:visitas", m);
}

export function resumenMuestras(muestras, esp) {
  const pesos = muestras.map((m) => m.peso);
  const n = pesos.length;
  const prom = n ? pesos.reduce((a, b) => a + b, 0) / n : null;
  const fuera = muestras.filter((m) => ["bajo", "alto"].includes(estadoPeso(m.peso, esp))).length;
  return { n, promedio: prom === null ? null : Math.round(prom * 100) / 100, menor: n ? Math.min(...pesos) : null, mayor: n ? Math.max(...pesos) : null, fuera };
}

export async function finalizarVisita(v, { resultado, recomendaciones, estadoSellado }, fotoBlob) {
  const r = resumenMuestras(v.muestras, v.esp);
  const campos = {
    Title: v.id,
    Fecha: diaASP(v.dia),
    HoraInicio: v.inicio,
    HoraFin: new Date().toISOString(),
    OrdenFabricacion: v.of.of,
    CodigoProducto: v.of.codigo,
    Producto: v.of.producto,
    Cliente: v.cliente || "",
    Lote: v.lote || "",
    Parada: v.parada || "",
    Equipo: v.equipo || "",
    Analista: v.analista || usuario?.nombre || "",
    PesoNominal: v.esp.nominal,
    PesoMinimo: v.esp.min,
    PesoMaximo: v.esp.max,
    Unidad: v.esp.unidad,
    NMuestras: r.n,
    Promedio: r.promedio,
    PesoMenor: r.menor,
    PesoMayor: r.mayor,
    FueraDeRango: r.fuera,
    // Detalle legible y ordenado: "1. 10:32 · 398,5 g · OK"
    Muestras: v.muestras.map((m, i) => `${i + 1}. ${fmtHora(m.hora)} · ${String(m.peso).replace(".", ",")} ${v.esp.unidad} · ${m.estado === "ok" ? "OK" : m.estado === "bajo" ? "BAJO" : m.estado === "alto" ? "ALTO" : "—"}`).join("\n"),
    Recomendaciones: recomendaciones || null,
    Resultado: resultado,
    // Opcional: solo en productos donde se verifica el sellado.
    TipoSellado: v.sellado || null,
    EstadoSellado: v.sellado ? estadoSellado || v.estadoSellado || null : null,
  };
  const foto = fotoBlob ? { campo: "Foto", ext: "jpg" } : null;
  // Control reabierto (ya existía en SharePoint): se actualiza la misma fila.
  if (v.spId) await encolar({ tipo: "update", lista: "controlPesos", id: v.spId, campos, foto }, fotoBlob);
  else await encolar({ tipo: "add", lista: "controlPesos", clave: [["Title", "eq", v.id]], campos, foto }, fotoBlob);
  await kv.set("pesos:ultimoEquipo", v.equipo || "");
  await kv.set(`pesos:sellado:${v.of.codigo}`, v.sellado || "");
  await descartarVisita(v.id);
  return campos;
}

export async function getControl(id) {
  return (await api.items("controlPesos", { where: [["ID", "eq", id]], top: 1 }))[0] || null;
}

// "1. 10:32 · 398,5 g · OK" → { peso, hora (ISO del día del control), estado }
export function muestrasDeTexto(texto, dia, esp) {
  return (texto || "")
    .split("\n")
    .map((l) => l.match(/^\s*\d+\.\s*(\d{1,2}:\d{2})\s*·\s*([\d.,]+)\s*\S*\s*·/))
    .filter(Boolean)
    .map((m) => {
      const peso = Number(m[2].replace(",", "."));
      return { peso, hora: new Date(`${dia}T${m[1].padStart(5, "0")}:00-05:00`).toISOString(), estado: estadoPeso(peso, esp) };
    });
}

// Retomar un control ya guardado para seguir tomando muestras: se arma la
// visita local con sus muestras; al terminar se actualiza la MISMA fila.
export async function reabrirControl(c) {
  const dia = diaISO(c.Fecha);
  const esp = { nominal: c.PesoNominal, min: c.PesoMinimo ?? null, max: c.PesoMaximo ?? null, unidad: c.Unidad || "g", origen: "registro" };
  const v = {
    id: c.Title,
    spId: c.ID,
    dia,
    inicio: c.HoraInicio,
    of: { of: c.OrdenFabricacion, codigo: c.CodigoProducto, producto: c.Producto },
    esp,
    cliente: c.Cliente || "",
    parada: c.Parada || "",
    lote: c.Lote || "",
    equipo: c.Equipo || "",
    analista: c.Analista || "",
    recomendaciones: c.Recomendaciones || "",
    resultado: c.Resultado || "",
    sellado: c.TipoSellado || "",
    estadoSellado: c.EstadoSellado || "",
    muestras: muestrasDeTexto(c.Muestras, dia, esp),
  };
  await guardarVisitaLocal(v);
  return v;
}

// Corregir datos de un control guardado (sin tocar las muestras).
export async function editarControl(c, cambios) {
  const campos = {};
  for (const [k, v] of Object.entries({ Parada: cambios.parada, Lote: cambios.lote, Equipo: cambios.equipo, Analista: cambios.analista, Resultado: cambios.resultado, Recomendaciones: cambios.recomendaciones, TipoSellado: cambios.sellado, EstadoSellado: cambios.sellado === "" ? "" : cambios.estadoSellado }))
    if (v !== undefined) campos[k] = v === "" ? null : v;
  await encolar({ tipo: "update", lista: "controlPesos", id: c.ID, campos });
  await subirAhora();
}

// Resultado sugerido de un control: sin muestras fuera → Conforme; hubo fuera
// pero las 2 últimas ya están en rango → Con ajustes; si no → No conforme.
export function resultadoSugerido(muestras, esp) {
  const r = resumenMuestras(muestras, esp);
  if (!r.fuera) return "Conforme";
  const ult = muestras.slice(-2);
  return ult.length === 2 && ult.every((m) => !["bajo", "alto"].includes(estadoPeso(m.peso, esp))) ? "Con ajustes" : "No conforme";
}

const lineaMuestra = (m, i, unidad) =>
  `${i + 1}. ${fmtHora(m.hora)} · ${String(m.peso).replace(".", ",")} ${unidad} · ${m.estado === "ok" ? "OK" : m.estado === "bajo" ? "BAJO" : m.estado === "alto" ? "ALTO" : "—"}`;

// Control hecho SIN rango: aplica el rango configurado hoy, recalcula estado
// de cada muestra, fuera de rango y resultado, y deja constancia en
// Recomendaciones de que el rango se aplicó después (trazabilidad).
export async function aplicarRangoActual(c, nuevo) {
  const dia = diaISO(c.Fecha);
  const esp = { nominal: c.PesoNominal, min: nuevo.min, max: nuevo.max, unidad: c.Unidad || nuevo.unidad || "g" };
  const muestras = muestrasDeTexto(c.Muestras, dia, esp);
  const r = resumenMuestras(muestras, esp);
  const resultado = resultadoSugerido(muestras, esp);
  const nota = `[Rango ${String(nuevo.min).replace(".", ",")}–${String(nuevo.max).replace(".", ",")} ${esp.unidad} aplicado después del control el ${fmtFecha(new Date().toISOString())} por ${usuario?.nombre || ""}; resultado anterior: ${c.Resultado || "—"}]`;
  const campos = {
    PesoMinimo: nuevo.min,
    PesoMaximo: nuevo.max,
    FueraDeRango: r.fuera,
    Resultado: resultado,
    Muestras: muestras.map((m, i) => lineaMuestra(m, i, esp.unidad)).join("\n"),
    Recomendaciones: [c.Recomendaciones, nota].filter(Boolean).join("\n"),
  };
  await encolar({ tipo: "update", lista: "controlPesos", id: c.ID, campos });
  await subirAhora();
  return { ...r, resultado };
}

// Último tipo de sellado usado con este producto (se precarga, opcional).
export const selladoRecordado = (codigo) => kv.get(`pesos:sellado:${codigo}`, "");

export async function eliminarParametroPeso(p) {
  await encolar({ tipo: "removeWhere", lista: "parametrosPeso", where: [["ID", "eq", p.ID]] });
  await subirAhora();
}

// ---------------- Temperaturas de contenedores ----------------
// Una fila por contenedor y turno: Title = "AAAA-MM-DD|06:00|C3" (único), así
// un reintento o una corrección del mismo turno nunca duplica.

export const claveTemp = (dia, turno, id) => `${dia}|${turno}|${id}`;

export function estadoTemp(t, c) {
  if (t === null || t === undefined || isNaN(t)) return null;
  if (c.min != null && t < c.min) return "Bajo";
  if (c.max != null && t > c.max) return "Alto";
  return "OK";
}

// Turno que corresponde a la hora actual: el más cercano (entre 22:00 y las
// 02:00 del día siguiente sigue contando como el de las 22:00 del día anterior).
const aMin = (s) => s.split(":").reduce((h, m) => Number(h) * 60 + Number(m));
export const aMinutos = aMin;
// Hasta qué hora se puede registrar un turno (sin configurar: 2 horas).
export function finTurno(t) {
  const f = CONFIG.ventanasTemperatura?.[t];
  if (f && /^\d{2}:\d{2}$/.test(f)) return f;
  const m = (aMin(t) + 120) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Turno que se puede registrar ahora. abierto=false si la hora está fuera de
// todos los horarios: entonces turno/dia apuntan al PRÓXIMO turno (para avisar).
// Un horario que pasa la medianoche pertenece al día en que empezó.
export function turnoActual(ahora = new Date()) {
  const local = new Date(ahora.toLocaleString("en-US", { timeZone: TZ }));
  const min = local.getHours() * 60 + local.getMinutes();
  const hoy = ahora.toLocaleDateString("en-CA", { timeZone: TZ });
  const turnos = [...CONFIG.turnosTemperatura].sort();
  for (const t of turnos) {
    const ini = aMin(t), fin = aMin(finTurno(t));
    const cruza = fin <= ini;
    if (!cruza && min >= ini && min < fin) return { dia: hoy, turno: t, abierto: true, fin: finTurno(t) };
    if (cruza && min >= ini) return { dia: hoy, turno: t, abierto: true, fin: finTurno(t) };
    if (cruza && min < fin) return { dia: sumarDias(hoy, -1), turno: t, abierto: true, fin: finTurno(t) };
  }
  const prox = turnos.find((t) => aMin(t) > min);
  return prox ? { dia: hoy, turno: prox, abierto: false, fin: finTurno(prox) } : { dia: sumarDias(hoy, 1), turno: turnos[0], abierto: false, fin: finTurno(turnos[0]) };
}

export async function temperaturasDelDia(dia) {
  const pend = (await idb.getAll("outbox"))
    .filter((o) => o.lista === "temperaturas" && (o.campos?.Title || o.where?.[0]?.[2] || "").startsWith(dia + "|"))
    .map((o) => ({ ...(o.campos || {}), Title: o.campos?.Title || o.where[0][2], pendiente: true }));
  let rows = [];
  try {
    rows = await api.items("temperaturas", {
      where: [["Fecha", "ge", new Date(diaASP(dia))], ["Fecha", "lt", new Date(diaASP(sumarDias(dia, 1)))]],
      top: 1000,
    });
    await kv.set(`cache:temp:${dia}`, rows);
  } catch {
    rows = await kv.get(`cache:temp:${dia}`, []);
  }
  // lo pendiente (aún sin subir) manda sobre lo leído
  const mapa = new Map(rows.map((r) => [r.Title, r]));
  for (const p of pend) mapa.set(p.Title, { ...(mapa.get(p.Title) || {}), ...p });
  return [...mapa.values()];
}

export async function registrarTemperatura({ dia, turno, contenedor, temperatura, observaciones, bodeguero, existente }, fotoBlob) {
  const titulo = claveTemp(dia, turno, contenedor.id);
  const estado = estadoTemp(temperatura, contenedor);
  const campos = {
    Title: titulo,
    Fecha: diaASP(dia),
    Turno: turno,
    ContenedorId: contenedor.id,
    Contenedor: contenedor.nombre,
    Tipo: contenedor.tipo,
    Temperatura: temperatura,
    Minimo: contenedor.min ?? null,
    Maximo: contenedor.max ?? null,
    Estado: estado,
    Observaciones: observaciones || null,
    Bodeguero: bodeguero || "",
    Operario: usuario?.nombre || "",
    HoraRegistro: new Date().toISOString(),
  };
  const foto = fotoBlob ? { campo: "Foto", ext: "jpg" } : null;
  if (existente) await encolar({ tipo: "updateWhere", lista: "temperaturas", where: [["Title", "eq", titulo]], campos, foto }, fotoBlob);
  else await encolar({ tipo: "add", lista: "temperaturas", clave: [["Title", "eq", titulo]], campos, foto }, fotoBlob);
  await kv.set("ultimoBodeguero", bodeguero || "");
  return { ...campos, pendiente: true };
}

// Lecturas de los últimos N días (para el historial / tendencia).
export async function temperaturasRango(desde, hasta) {
  return api.items("temperaturas", {
    where: [["Fecha", "ge", new Date(diaASP(desde))], ["Fecha", "lt", new Date(diaASP(sumarDias(hasta, 1)))]],
    top: 5000,
  });
}
