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

export function setUsuario(nombre, correo) {
  const c = (correo || "").toLowerCase();
  usuario = { nombre, correo: c, accesos: CONFIG.accesos[c] || [] };
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

export async function registrosDeLote(lote) {
  try {
    return await api.items("registros", { where: [["Title", "eq", lote.Title]], orderby: "field_1 asc", top: 500 });
  } catch {
    return [];
  }
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

export async function registrarParada(lote, prod, v) {
  const campos = {
    Title: lote.Title,
    field_1: v.parada,
    field_2: v.brix,
    field_3: v.ph,
    field_4: v.acidez,
    field_5: v.recorrido ?? null,
    field_7: v.fruta ?? null,
    field_8: v.ratio ?? null,
    field_9: v.responsable,
    Observaciones: v.obs || null,
    Repeticion: !!v.repeticion,
    Fecha_produccion: lote.Fechadeproducci_x00f3_n,
    COD_Producto: prod?.Ordenamiento || null,
  };
  await encolar({
    tipo: "add",
    lista: "registros",
    clave: [["Title", "eq", lote.Title], ["field_1", "eq", v.parada], ["Repeticion", "eq", !!v.repeticion]],
    campos,
  });
  await kv.set("ultimoResponsablePlanta", v.responsable);
  return campos;
}

export async function cerrarLote(lote) {
  await encolar({ tipo: "update", lista: "lotes", id: lote.ID, campos: { field_4: "Finalizado" } });
  const rows = await kv.get("cache:lotes", []);
  await kv.set("cache:lotes", rows.filter((l) => l.ID !== lote.ID));
}
