// Liberación de equipos después de la limpieza (Calidad).
//
// Flujo (pensado para no volverse engorroso):
//   1. Tablero del día: una tarjeta por OF de Odoo (producto, cliente, OF).
//   2. "Asignar limpieza": quién limpia (personas que marcaron ingreso hoy en
//      Hub Asistencia, solo nombres) + equipos sugeridos por la ruta de la OF
//      (centros de trabajo de sus órdenes de trabajo → equipos). Al confirmar
//      queda la HORA DE INICIO automática.
//   3. Hisopado por equipo: lectura del luminómetro (obligatoria) + Aprueba /
//      No aprueba. La hora se toma sola. Si no aprueba: recomendación rápida
//      (Volver a lavar, Volver a enjuagar, Lavado total u Otro con texto) y el
//      equipo queda para un nuevo hisopado (intento 2, 3…).
//   4. Cuando todos los equipos aprueban, la limpieza queda LIBERADA con la hora
//      del último hisopado aprobado: tiempo = liberación − inicio.
//
// Indicadores del día (método / medición del informe): hisopados realizados,
// hisopados aprobados, tiempo para arranque de planta, estado del registro y
// tiempo de cambio de sabor.
//
// Datos: listas LiberacionEquipos + HisopadosEquipos (ver la capa de datos).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, hoja, confirmar, campoNum } from "./ui.js";

// append() de DOM escribe "null" si recibe null: se filtran los vacíos.
const poner = (nodo, ...hijos) => nodo.append(...hijos.flat().filter((h) => h !== null && h !== undefined && h !== false));
const sinTildes = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const nombreEquipo = (id) => CONFIG.limpieza.equipos.find((e) => e.id === id)?.nombre || id;
const fmtRLU = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("es-EC"));
const TIPOS = ["Arranque", "Cambio de sabor"];

// 01:40:00 (como el informe).
function fmtDur(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
// "1 h 40 min" para pantalla.
function fmtDurCorta(ms) {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// ======================= datos =======================
// SharePoint: LiberacionEquipos (una fila por limpieza, Title = id) y
// HisopadosEquipos (una fila por hisopado, Title = id del hisopado, LimpiezaId).
// Todo se guarda primero en el equipo y sube por la cola (sin señal no se pierde
// nada). La copia local K guarda lo leído de SharePoint + lo pendiente de subir.

const K = "equipos:limpiezas";
const todas = async () => (await kv.get(K, {})) || {};
async function guardarLocal(l) {
  const m = await todas();
  m[l.id] = l;
  await kv.set(K, m);
}
const nuevoId = (p) => `${p}-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
const parseJSON = (s, d) => {
  try {
    return JSON.parse(s) ?? d;
  } catch {
    return d;
  }
};

function cabecera(l) {
  const r = resumen(l);
  return {
    Title: l.id,
    Dia: l.dia,
    OrdenFabricacion: l.of || "",
    CodigoProducto: l.codigo || "",
    Producto: l.producto,
    Cliente: l.cliente || "",
    Tipo: l.tipo,
    Personas: l.personas.join(", "),
    Inicio: l.inicio,
    Liberacion: l.liberacion || null,
    Estado: l.anulada ? "Anulado" : l.liberacion ? "Liberado" : "En curso",
    Equipos: JSON.stringify(l.equipos.map(({ id, nombre }) => ({ id, nombre }))),
    Cambios: JSON.stringify(l.cambios || []),
    AsignadoPor: l.asignadoPor || "",
    CorreoAsignador: l.correo || "",
    DuracionMin: r.duracion !== null ? Math.round(r.duracion / 6000) / 10 : null,
    HisopadosRealizados: r.realizados,
    HisopadosAprobados: r.hisopadosOk,
  };
}

function filaHisopado(l, eq, h, intento) {
  return {
    Title: h.id,
    LimpiezaId: l.id,
    Dia: l.dia,
    OrdenFabricacion: l.of || "",
    Producto: l.producto,
    EquipoId: eq.id,
    Equipo: eq.nombre,
    Intento: intento,
    Hora: h.hora,
    LecturaRLU: h.valor,
    Resultado: h.resultado,
    Recomendacion: h.recomendacion || "",
    Observacion: h.observacion || "",
    Analista: h.analista || "",
    CorreoAnalista: h.correo || "",
  };
}

// Guarda en el equipo al instante y encola la subida.
async function persistir(l, { nueva = false, hisopado = null } = {}) {
  recalcular(l);
  await guardarLocal(l);
  const ref = l.id;
  if (nueva) await st.encolarOperacion({ tipo: "add", lista: "limpiezasEq", clave: [["Title", "eq", l.id]], campos: cabecera(l), ref });
  if (hisopado) await st.encolarOperacion({ tipo: "add", lista: "hisopadosEq", clave: [["Title", "eq", hisopado.h.id]], campos: filaHisopado(l, hisopado.eq, hisopado.h, hisopado.intento), ref });
  if (!nueva) await st.encolarOperacion({ tipo: "updateWhere", lista: "limpiezasEq", where: [["Title", "eq", l.id]], campos: cabecera(l), ref });
}

const hisopadoDeSP = (h) => ({ id: h.Title, hora: h.Hora, valor: h.LecturaRLU, resultado: h.Resultado, recomendacion: h.Recomendacion || null, observacion: h.Observacion || null, analista: h.Analista || "", correo: h.CorreoAnalista || "" });

function desdeSP(c, hs) {
  const equipos = parseJSON(c.Equipos, []).map((e) => ({ id: e.id, nombre: e.nombre, hisopados: [] }));
  for (const h of hs.filter((x) => x.LimpiezaId === c.Title).sort((a, b) => String(a.Hora).localeCompare(String(b.Hora)))) {
    let eq = equipos.find((e) => e.id === h.EquipoId);
    if (!eq) equipos.push((eq = { id: h.EquipoId, nombre: h.Equipo, hisopados: [] }));
    eq.hisopados.push(hisopadoDeSP(h));
  }
  return recalcular({
    id: c.Title,
    dia: c.Dia,
    of: c.OrdenFabricacion || "",
    codigo: c.CodigoProducto || "",
    producto: c.Producto || "",
    cliente: c.Cliente || "",
    tipo: c.Tipo || "Cambio de sabor",
    personas: String(c.Personas || "").split(",").map((s) => s.trim()).filter(Boolean),
    inicio: c.Inicio,
    liberacion: c.Liberacion || null,
    anulada: c.Estado === "Anulado",
    asignadoPor: c.AsignadoPor || "",
    correo: c.CorreoAsignador || "",
    cambios: parseJSON(c.Cambios, []),
    equipos,
  });
}

// Lo pendiente de subir manda sobre lo leído (va más adelantado), pero los
// hisopados que otro equipo ya subió se suman: nunca se pierde uno.
function unirHisopados(l, hs) {
  for (const h of hs.filter((x) => x.LimpiezaId === l.id)) {
    if (l.equipos.some((e) => e.hisopados.some((x) => x.id === h.Title))) continue;
    let eq = l.equipos.find((e) => e.id === h.EquipoId);
    if (!eq) l.equipos.push((eq = { id: h.EquipoId, nombre: h.Equipo, hisopados: [] }));
    eq.hisopados.push(hisopadoDeSP(h));
    eq.hisopados.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
  }
  return recalcular(l);
}

async function pendientesIds() {
  return new Set((await st.operacionesPendientes()).filter((o) => o.lista === "limpiezasEq" || o.lista === "hisopadosEq").map((o) => o.ref));
}

// Trae de SharePoint las limpiezas del rango y actualiza la copia local.
// Devuelve el error (texto) si no se pudo leer; se sigue con la copia.
async function refrescarRango(desde, hasta) {
  const api = st.getApi();
  try {
    const rango = [["Dia", "ge", desde], ["Dia", "le", hasta]];
    const [cabs, hs] = await Promise.all([api.items("limpiezasEq", { where: rango, top: 5000 }), api.items("hisopadosEq", { where: rango, top: 5000 })]);
    const pend = await pendientesIds();
    const local = await todas();
    const remotos = new Set(cabs.map((c) => c.Title));
    for (const c of cabs) local[c.Title] = pend.has(c.Title) && local[c.Title] ? unirHisopados(local[c.Title], hs) : desdeSP(c, hs);
    // Lo que ya no está en SharePoint y no espera subida (ej. se descartó en la cola) se quita.
    for (const [id, l] of Object.entries(local)) if (l.dia >= desde && l.dia <= hasta && !remotos.has(id) && !pend.has(id)) delete local[id];
    await kv.set(K, local);
    return null;
  } catch (e) {
    console.warn("Liberación de equipos:", e);
    return e.status === 403 || e.status === 401 ? "Sin permiso en las listas de Liberación de equipos: se muestra lo guardado en este equipo." : "Sin conexión con SharePoint: se muestra lo guardado en este equipo.";
  }
}

async function refrescarUna(id) {
  const api = st.getApi();
  try {
    const [c] = await api.items("limpiezasEq", { where: [["Title", "eq", id]], top: 1 });
    if (!c) return;
    const hs = await api.items("hisopadosEq", { where: [["LimpiezaId", "eq", id]], top: 500 });
    const local = await todas();
    local[id] = (await pendientesIds()).has(id) && local[id] ? unirHisopados(local[id], hs) : desdeSP(c, hs);
    await kv.set(K, local);
  } catch (e) {
    console.warn("Liberación de equipos:", e);
  }
}

let errorLectura = null;
export async function limpiezasRango(desde, hasta, { remoto = true } = {}) {
  if (remoto) errorLectura = await refrescarRango(desde, hasta);
  return Object.values(await todas())
    .filter((l) => !l.anulada && l.dia >= desde && l.dia <= hasta)
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
}
const limpiezasDelDia = (dia) => limpiezasRango(dia, dia);
async function getLimpieza(id) {
  await refrescarUna(id);
  return (await todas())[id] || null;
}

// Equipos sugeridos para una ruta (centros de trabajo de Odoo). LIMPIEZA es la
// propia operación de liberación: no aporta equipos.
function equiposDeRuta(centros) {
  const mapa = Object.fromEntries(Object.entries(CONFIG.limpieza.centros).map(([k, v]) => [sinTildes(k), v]));
  const ids = [];
  const origen = {}; // equipo → centros de los que sale
  const sinEquipo = [];
  for (const c of centros || []) {
    const k = sinTildes(c);
    if (k === "LIMPIEZA") continue;
    const eqs = mapa[k];
    if (!eqs?.length) {
      sinEquipo.push(c);
      continue;
    }
    for (const id of eqs) {
      if (!ids.includes(id)) ids.push(id);
      (origen[id] ||= []).push(c);
    }
  }
  return { ids, origen, sinEquipo };
}

// Estado de un equipo dentro de una limpieza.
function estadoEquipo(eq) {
  const u = eq.hisopados[eq.hisopados.length - 1];
  if (!u) return { clave: "pend", intento: 1 };
  if (u.resultado === "Aprobado") return { clave: "ok", ultimo: u, intento: eq.hisopados.length };
  return { clave: "rehacer", ultimo: u, intento: eq.hisopados.length + 1 };
}

// Liberada = todos los equipos con su último hisopado aprobado. Hora de
// liberación = la del último hisopado aprobado (se toma sola).
function recalcular(l) {
  const est = l.equipos.map(estadoEquipo);
  const lista = l.equipos.length > 0 && est.every((e) => e.clave === "ok");
  l.liberacion = lista ? est.map((e) => e.ultimo.hora).sort().pop() : null;
  return l;
}

function resumen(l) {
  const est = l.equipos.map(estadoEquipo);
  const hisopados = l.equipos.flatMap((e) => e.hisopados);
  return {
    total: l.equipos.length,
    aprobados: est.filter((e) => e.clave === "ok").length,
    rehacer: est.filter((e) => e.clave === "rehacer").length,
    realizados: hisopados.length,
    hisopadosOk: hisopados.filter((h) => h.resultado === "Aprobado").length,
    duracion: l.liberacion ? Date.parse(l.liberacion) - Date.parse(l.inicio) : null,
  };
}

// Tiempo real que ocupan varias limpiezas: unión de sus intervalos
// [inicio, liberación]. Las que corren en paralelo no se suman dos veces.
function tiempoUnion(ls) {
  const iv = ls.map((l) => [Date.parse(l.inicio), Date.parse(l.liberacion)]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  return cur ? total + cur[1] - cur[0] : null;
}

// Indicadores del día (informe "Método / medición").
// Arranque: las limpiezas del arranque corren en PARALELO; el tiempo va del
// primer inicio al corte = la hora en que se liberó el ÚLTIMO equipo de todas
// ellas (no la suma de cada una). Mientras alguna siga abierta, está "en curso".
// Cambio de sabor: tiempo en que hubo al menos un cambio en limpieza (unión).
function indicadoresDia(limpiezas) {
  const r = limpiezas.map((l) => ({ l, ...resumen(l) }));
  const arr = limpiezas.filter((l) => l.tipo === "Arranque");
  const arrListo = arr.length > 0 && arr.every((l) => l.liberacion);
  const inicioArr = arr.length ? arr.map((l) => l.inicio).sort()[0] : null;
  const corte = arrListo ? arr.map((l) => l.liberacion).sort().pop() : null;
  const cambiosListos = limpiezas.filter((l) => l.tipo === "Cambio de sabor" && l.liberacion);
  return {
    realizados: r.reduce((a, x) => a + x.realizados, 0),
    aprobados: r.reduce((a, x) => a + x.hisopadosOk, 0),
    arranque: corte ? Date.parse(corte) - Date.parse(inicioArr) : null,
    arranqueEnCurso: arr.length > 0 && !arrListo,
    inicioArranque: inicioArr,
    corte,
    cambio: cambiosListos.length ? tiempoUnion(cambiosListos) : null,
    cambios: limpiezas.filter((l) => l.tipo === "Cambio de sabor").length,
    estado: !r.length ? "—" : r.every((x) => x.l.liberacion) ? "OK" : "Pendiente",
  };
}
const textoArranque = (k) => (k.arranqueEnCurso ? "En curso" : fmtDur(k.arranque));

// Tipo sugerido al asignar: mientras el arranque siga abierto (no se liberaron
// todos sus equipos), lo nuevo también es arranque; después, cambio de sabor.
function tipoSugerido(limpiezas) {
  const vivas = limpiezas.filter((l) => !l.anulada);
  if (!vivas.length) return "Arranque";
  const arr = vivas.filter((l) => l.tipo === "Arranque");
  return arr.length && arr.some((l) => !l.liberacion) && vivas.every((l) => l.tipo === "Arranque") ? "Arranque" : "Cambio de sabor";
}

// Personas que marcaron hoy en Hub Asistencia (lista RegistrosAsistencia, solo
// lectura). En planta = su última marcación no es "Salida".
async function personasDelDia(dia) {
  const api = st.getApi();
  if (CONFIG.useMock) await (await import("./mock.js")).sembrarAsistencia(dia);
  try {
    // La lista pasa de 5.000 marcaciones y Jornada no está indexada: filtrar por
    // ella da "supera el umbral de vista de lista". Se leen las últimas por ID
    // (siempre indexado; ~140 marcaciones al día) y se filtra el día aquí.
    const rows = (await api.items("asistencia", { orderby: "ID desc", select: ["ID", "EmpleadoID", "Nombre", "Accion", "FechaHora", "Jornada"], top: 800 })).filter((r) => r.Jornada === dia);
    const por = new Map();
    for (const r of rows.sort((a, b) => String(a.FechaHora).localeCompare(String(b.FechaHora)))) {
      const nombre = String(r.Nombre || "").trim().replace(/\s+/g, " ");
      if (!nombre) continue;
      const k = r.EmpleadoID || nombre;
      const p = por.get(k) || { id: r.EmpleadoID || "", nombre, ingreso: null, ultima: null };
      if (r.Accion === "Ingreso" && !p.ingreso) p.ingreso = r.FechaHora;
      p.ultima = r.Accion;
      por.set(k, p);
    }
    const lista = [...por.values()].map((p) => ({ ...p, enPlanta: p.ultima !== "Salida" })).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    await kv.set("cache:asistencia:" + dia, lista);
    return { lista };
  } catch (e) {
    console.warn("Asistencia:", e);
    return {
      lista: (await kv.get("cache:asistencia:" + dia, [])) || [],
      error: e.status === 403 || e.status === 401 ? "Esta cuenta no tiene permiso para leer la asistencia (lista RegistrosAsistencia). Puedes escribir los nombres." : "No se pudo leer la asistencia de hoy. Puedes escribir los nombres.",
    };
  }
}

// ======================= pantallas =======================

export function render(vista, resto) {
  if (resto[0] === "l" && resto[1]) return detalle(vista, decodeURIComponent(resto[1]));
  if (resto[0] === "registro") return registro(vista);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(resto[0] || "") ? resto[0] : st.hoyISO();
  return tablero(vista, dia);
}

// ---------------- tablero del día ----------------

async function tablero(vista, dia) {
  const fecha = el("input", { type: "date", class: "dias", value: dia, max: st.sumarDias(st.hoyISO(), 2) });
  fecha.addEventListener("change", () => fecha.value && (location.hash = `#/equipos/${fecha.value}`));
  const kpis = el("div", { class: "hist-kpis" });
  const lista = el("div", { class: "eq-lista" }, el("div", { class: "cargando" }, "Cargando órdenes del día…"));
  const avisoOF = el("div");
  poner(vista,
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Liberación de equipos"), el("p", { class: "sub" }, `Limpieza y hisopado · ${dia === st.hoyISO() ? "hoy, " : ""}${st.fmtDia(dia)}`)]),
      el("div", { class: "cab-botones" }, [fecha, el("a", { class: "btn btn-sec", href: "#/equipos/registro" }, "📋 Registro")]),
    ]),
    avisoOF,
    kpis,
    lista,
  );

  const [datosOF, limpiezas] = await Promise.all([st.cargarOF(), limpiezasDelDia(dia)]);
  if (datosOF.error) poner(avisoOF, el("div", { class: "aviso" }, datosOF.error));
  if (errorLectura) poner(avisoOF, el("div", { class: "aviso" }, errorLectura));
  pintarKpis(kpis, limpiezas);

  // Ruta de respaldo: si una OF aún no tiene órdenes de trabajo, se usa la de
  // otra OF del mismo producto.
  const rutaProducto = {};
  for (const o of datosOF.ofs || []) if (o.centros?.length && !rutaProducto[o.codigo]) rutaProducto[o.codigo] = o.centros;
  const ofs = (datosOF.ofs || [])
    .filter((o) => o.fecha === dia)
    .map((o) => {
      const propia = !!o.centros?.length;
      const centros = propia ? o.centros : rutaProducto[o.codigo] || [];
      const sug = equiposDeRuta(centros);
      // Encartonado y similares: la ruta no tiene limpieza ni equipos.
      const requiere = !centros.length || centros.some((c) => sinTildes(c) === "LIMPIEZA") || sug.ids.length > 0;
      return { ...o, centrosRuta: centros, rutaDeOtra: !propia && centros.length > 0, sug, requiere };
    })
    .sort((a, b) => String(a.inicio || "").localeCompare(String(b.inicio || "")) || a.of.localeCompare(b.of));

  clear(lista);
  const usadas = new Set();
  const conLimpieza = ofs.filter((o) => o.requiere);
  for (const o of conLimpieza) {
    const ls = limpiezas.filter((l) => l.of === o.of);
    ls.forEach((l) => usadas.add(l.id));
    lista.appendChild(tarjeta(o, ls));
  }
  // Limpiezas sin OF (o de una OF que ya no está en este día).
  for (const l of limpiezas.filter((x) => !usadas.has(x.id))) lista.appendChild(tarjeta(null, [l]));
  if (!lista.children.length) lista.appendChild(el("div", { class: "vacio chico" }, "No hay órdenes de fabricación con limpieza para este día."));

  const otras = ofs.filter((o) => !o.requiere);
  poner(vista,
    el("div", { class: "fila-botones izq" }, [el("button", { class: "btn btn-sec", onclick: () => asignar(null, dia, limpiezas) }, "+ Otra limpieza (sin OF)")]),
    otras.length
      ? el("details", { class: "eq-otras" }, [
          el("summary", {}, `${otras.length} orden${otras.length > 1 ? "es" : ""} sin limpieza de equipos (encartonado, etc.)`),
          el("ul", {}, otras.map((o) => el("li", {}, `${o.producto} · ${o.of}${o.centrosRuta.length ? ` · ${o.centrosRuta.join(", ")}` : ""}`))),
        ])
      : null
  );

  function tarjeta(o, ls) {
    const l = ls[ls.length - 1] || null;
    const card = el("article", { class: "eq-card" });
    const prod = o?.producto || l?.producto || "";
    const meta = [o?.cliente || l?.cliente, o?.of || l?.of || "Sin OF", o?.inicio ? `plan ${st.fmtHora(o.inicio)}` : null].filter(Boolean).join(" · ");
    poner(card, el("div", { class: "eq-card-cab" }, [
      el("div", {}, [el("strong", { class: "eq-prod" }, prod), el("small", { class: "eq-meta" }, meta)]),
      l ? el("span", { class: `eq-tipo ${l.tipo === "Arranque" ? "arranque" : ""}` }, l.tipo) : null,
    ]));
    if (!l) {
      card.classList.add("libre");
      poner(card,
        el("div", { class: "eq-sug" }, o.sug.ids.length
          ? `Equipos sugeridos (${o.sug.ids.length}): ${o.sug.ids.map(nombreEquipo).join(", ")}${o.rutaDeOtra ? " · ruta de otra OF del producto" : ""}`
          : "Sin ruta en Odoo: se eligen los equipos al asignar."),
        el("div", { class: "fila-botones izq" }, [el("button", { class: "btn btn-verde", onclick: () => asignar(o, dia, limpiezas) }, "Asignar limpieza")])
      );
      return card;
    }
    const r = resumen(l);
    card.classList.add(l.liberacion ? "liberada" : "en-curso");
    card.addEventListener("click", () => (location.hash = `#/equipos/l/${encodeURIComponent(l.id)}`));
    poner(card,
      el("div", { class: "eq-personas" }, `🧽 ${l.personas.join(", ")}`),
      l.liberacion
        ? el("div", { class: "eq-estado ok" }, [el("b", {}, `✓ Liberado ${st.fmtHora(l.liberacion)}`), el("span", {}, `${fmtDurCorta(r.duracion)} · ${r.realizados} hisopado${r.realizados !== 1 ? "s" : ""} (${r.hisopadosOk} aprobado${r.hisopadosOk !== 1 ? "s" : ""})`)])
        : el("div", { class: "eq-estado curso" }, [
            el("b", {}, `Limpiando desde ${st.fmtHora(l.inicio)}`),
            el("span", {}, `${r.aprobados} de ${r.total} equipos aprobados${r.rehacer ? ` · ${r.rehacer} por repetir` : ""}`),
            el("div", { class: "avance-barra" }, el("div", { class: "avance-fill", style: `width:${r.total ? Math.round((100 * r.aprobados) / r.total) : 0}%` })),
          ]),
      ls.length > 1 ? el("small", { class: "eq-meta" }, `${ls.length} limpiezas de esta OF hoy`) : null
    );
    return card;
  }
}

function pintarKpis(nodo, limpiezas) {
  const k = indicadoresDia(limpiezas);
  clear(nodo);
  const kpi = (v, t, clase = "") => el("div", { class: `hist-kpi ${clase}` }, [el("b", {}, String(v)), el("span", {}, t)]);
  poner(nodo,
    kpi(k.realizados, "Hisopados realizados"),
    kpi(k.aprobados, "Hisopados aprobados", k.realizados > k.aprobados ? "ambar" : ""),
    kpi(textoArranque(k), k.corte ? `Tiempo para arranque de planta · ${st.fmtHora(k.inicioArranque)} → ${st.fmtHora(k.corte)}` : "Tiempo para arranque de planta", k.arranqueEnCurso ? "ambar" : ""),
    kpi(k.estado, "Estado del registro", k.estado === "Pendiente" ? "ambar" : ""),
    kpi(fmtDur(k.cambio), `Tiempo de cambio de sabor${k.cambios > 1 ? ` (${k.cambios})` : ""}`)
  );
}

// ---------------- asignar limpieza ----------------

// Selector de personas: chips con quienes marcaron ingreso hoy + escribir otro nombre.
function selectorPersonas(dia, iniciales = []) {
  const elegidas = new Set(iniciales);
  const buscar = el("input", { type: "search", class: "obs eq-buscar", placeholder: "Buscar nombre…" });
  const chips = el("div", { class: "eq-chips" }, el("small", { class: "nota" }, "Cargando asistencia de hoy…"));
  const aviso = el("div");
  const otro = el("input", { type: "text", class: "obs", placeholder: "Otra persona (escribir el nombre)" });
  const agregarOtro = el("button", { class: "btn btn-sec btn-sm", type: "button" }, "Agregar");
  let gente = [];
  const pintar = () => {
    clear(chips);
    const q = sinTildes(buscar.value);
    const extra = [...elegidas].filter((n) => !gente.some((p) => p.nombre === n)).map((n) => ({ nombre: n, enPlanta: true, manual: true }));
    const visibles = [...extra, ...gente.filter((p) => p.enPlanta || elegidas.has(p.nombre))].filter((p) => !q || sinTildes(p.nombre).includes(q));
    if (!visibles.length) chips.appendChild(el("small", { class: "nota" }, gente.length ? "Nadie coincide con la búsqueda." : "Nadie ha marcado ingreso hoy en Hub Asistencia."));
    for (const p of visibles)
      chips.appendChild(
        el("button", {
          type: "button",
          class: `eq-persona ${elegidas.has(p.nombre) ? "on" : ""}`,
          title: p.ingreso ? `Ingreso ${st.fmtHora(p.ingreso)}` : "",
          onclick: () => {
            elegidas.has(p.nombre) ? elegidas.delete(p.nombre) : elegidas.add(p.nombre);
            pintar();
          },
        }, `${elegidas.has(p.nombre) ? "✓ " : ""}${p.nombre}`)
      );
  };
  const sumar = () => {
    const n = otro.value.trim().replace(/\s+/g, " ");
    if (!n) return;
    elegidas.add(n);
    otro.value = "";
    pintar();
  };
  agregarOtro.addEventListener("click", sumar);
  otro.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), sumar()));
  buscar.addEventListener("input", pintar);
  personasDelDia(dia).then(({ lista, error }) => {
    gente = lista;
    if (error) aviso.appendChild(el("div", { class: "aviso" }, error));
    pintar();
  });
  return {
    nodo: el("div", {}, [aviso, buscar, chips, el("div", { class: "eq-otro" }, [otro, agregarOtro])]),
    valor: () => [...elegidas],
  };
}

function asignar(of, dia, limpiezasDia) {
  let tipo = tipoSugerido(limpiezasDia);
  const opsTipo = el("div", { class: "opts" });
  const pintarTipo = () => {
    clear(opsTipo);
    for (const t of TIPOS) opsTipo.appendChild(el("button", { type: "button", class: `opt ${t === tipo ? "on ok" : ""}`, onclick: () => ((tipo = t), pintarTipo()) }, t));
  };
  pintarTipo();

  const personas = selectorPersonas(dia);
  const sug = of ? of.sug : { ids: [], origen: {}, sinEquipo: [] };
  const marcados = new Set(sug.ids);
  const extras = [];
  const listaEq = el("div", { class: "eq-check-lista" });
  const otroEq = el("select", { class: "dias" });
  const pintarEq = () => {
    clear(listaEq);
    for (const id of [...sug.ids, ...extras]) {
      const cb = el("input", { type: "checkbox", ...(marcados.has(id) ? { checked: "" } : {}) });
      cb.addEventListener("change", () => (cb.checked ? marcados.add(id) : marcados.delete(id)));
      listaEq.appendChild(el("label", { class: "eq-check" }, [cb, el("span", {}, [el("b", {}, nombreEquipo(id)), sug.origen[id] ? el("small", {}, sug.origen[id].join(", ")) : el("small", {}, "agregado")])]));
    }
    if (!listaEq.children.length) listaEq.appendChild(el("small", { class: "nota" }, "Sin equipos sugeridos: agrégalos abajo."));
    clear(otroEq);
    otroEq.appendChild(el("option", { value: "" }, "+ Agregar otro equipo…"));
    for (const e of CONFIG.limpieza.equipos) if (!sug.ids.includes(e.id) && !extras.includes(e.id)) otroEq.appendChild(el("option", { value: e.id }, e.nombre));
  };
  otroEq.addEventListener("change", () => {
    if (!otroEq.value) return;
    extras.push(otroEq.value);
    marcados.add(otroEq.value);
    pintarEq();
  });
  pintarEq();

  const desc = of ? null : el("input", { type: "text", class: "obs", placeholder: "¿Qué se limpia? (producto o motivo)" });
  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Iniciar limpieza");
  const h = hoja(
    of ? "Asignar limpieza" : "Otra limpieza (sin OF)",
    [
      of ? el("div", { class: "eq-hoja-of" }, [el("strong", {}, of.producto), el("small", {}, [of.cliente, of.of].filter(Boolean).join(" · "))]) : el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Descripción"), desc]),
      el("h3", { class: "eq-h3" }, "Tipo de limpieza"),
      opsTipo,
      el("h3", { class: "eq-h3" }, "¿Quién limpia?"),
      personas.nodo,
      el("h3", { class: "eq-h3" }, "Equipos a liberar"),
      of?.rutaDeOtra ? el("p", { class: "nota" }, "Esta OF aún no tiene ruta en Odoo: se sugieren los equipos de otra OF del mismo producto.") : null,
      sug.sinEquipo.length ? el("p", { class: "nota" }, `Centros sin equipo asociado: ${sug.sinEquipo.join(", ")}.`) : null,
      listaEq,
      otroEq,
      el("p", { class: "nota" }, "La hora de inicio se registra al tocar «Iniciar limpieza»."),
      btn,
    ].filter(Boolean),
    { ancho: 640 }
  );
  btn.addEventListener("click", async () => {
    const quienes = personas.valor();
    const ids = [...sug.ids, ...extras].filter((id) => marcados.has(id));
    if (!of && !desc.value.trim()) return toast("Escribe qué se limpia.", "err");
    if (!quienes.length) return toast("Elige quién hace la limpieza.", "err");
    if (!ids.length) return toast("Marca al menos un equipo.", "err");
    const u = st.getUsuario();
    const l = {
      id: nuevoId("LE"),
      dia,
      of: of?.of || "",
      codigo: of?.codigo || "",
      producto: of ? of.producto : desc.value.trim(),
      cliente: of?.cliente || "",
      tipo,
      personas: quienes,
      inicio: new Date().toISOString(),
      liberacion: null,
      asignadoPor: u.nombre,
      correo: u.correo,
      equipos: ids.map((id) => ({ id, nombre: nombreEquipo(id), hisopados: [] })),
      cambios: [],
    };
    await persistir(l, { nueva: true });
    h.cerrar();
    toast(`Limpieza iniciada ${st.fmtHora(l.inicio)}`);
    location.hash = `#/equipos/l/${encodeURIComponent(l.id)}`;
  });
}

// ---------------- detalle de una limpieza ----------------

async function detalle(vista, id) {
  const l = await getLimpieza(id);
  if (!l) {
    poner(vista, el("a", { class: "volver", href: "#/equipos" }, "← Liberación de equipos"), el("div", { class: "vacio" }, "No se encontró esa limpieza en este equipo."));
    return;
  }
  const cuerpo = el("div");
  poner(vista, el("a", { class: "volver", href: `#/equipos/${l.dia}` }, "← Liberación de equipos"), cuerpo);
  pintar();

  // Tiempo transcurrido en vivo mientras no esté liberada.
  const reloj = setInterval(() => {
    if (!document.body.contains(cuerpo)) return clearInterval(reloj);
    const t = cuerpo.querySelector("[data-transcurrido]");
    if (t && !l.liberacion) t.textContent = fmtDurCorta(Date.now() - Date.parse(l.inicio));
  }, 30000);

  function pintar() {
    clear(cuerpo);
    const r = resumen(l);
    poner(cuerpo,
      el("div", { class: "cab eq-det-cab" }, [
        el("div", {}, [
          el("h1", { class: "titulo eq-det-prod" }, l.producto),
          el("p", { class: "sub" }, [l.cliente, l.of || "Sin OF", st.fmtDia(l.dia)].filter(Boolean).join(" · ")),
        ]),
        el("span", { class: `eq-tipo grande ${l.tipo === "Arranque" ? "arranque" : ""}` }, l.tipo),
      ]),
      el("div", { class: "eq-datos" }, [
        dato("Limpian", [l.personas.join(", "), el("button", { class: "btn btn-sec btn-mini", onclick: () => cambiarPersonas() }, "Cambiar")]),
        dato("Inicio (automático)", st.fmtHora(l.inicio)),
        l.liberacion ? dato("Liberación", st.fmtHora(l.liberacion)) : dato("Tiempo transcurrido", el("span", { "data-transcurrido": "" }, fmtDurCorta(Date.now() - Date.parse(l.inicio)))),
        l.liberacion ? dato("Tiempo de limpieza", fmtDur(r.duracion)) : dato("Equipos aprobados", `${r.aprobados} de ${r.total}`),
      ]),
      l.liberacion
        ? el("div", { class: "estado estado-verde eq-banner" }, `✓ Equipos liberados a las ${st.fmtHora(l.liberacion)} · ${r.realizados} hisopados, ${r.hisopadosOk} aprobados`)
        : el("div", { class: "eq-nota-flujo" }, "Toca un equipo para registrar el hisopado. Cuando todos aprueben, la limpieza queda liberada sola."),
      el("div", { class: "eq-equipos" }, l.equipos.map(filaEquipo)),
      el("div", { class: "eq-acciones" }, [
        agregarEquipoSelect(),
        !l.equipos.some((e) => e.hisopados.length) ? el("button", { class: "btn btn-sec rojo", onclick: anular }, "Anular limpieza") : null,
      ].filter(Boolean)),
      historial()
    );
  }

  function dato(t, v) {
    return el("div", { class: "eq-dato" }, [el("small", {}, t), el("div", {}, [].concat(v).map((x) => (typeof x === "string" ? el("b", {}, x) : x)))]);
  }

  function filaEquipo(eq) {
    const e = estadoEquipo(eq);
    const u = e.ultimo;
    const fila = el("button", { type: "button", class: `eq-fila ${e.clave}`, onclick: () => hisopado(eq) });
    poner(fila,
      el("span", { class: "eq-fila-ico" }, e.clave === "ok" ? "✓" : e.clave === "rehacer" ? "↻" : "○"),
      el("span", { class: "eq-fila-txt" }, [
        el("b", {}, eq.nombre),
        e.clave === "pend"
          ? el("small", {}, "Pendiente de hisopado")
          : e.clave === "ok"
            ? el("small", {}, `Aprobado · ${fmtRLU(u.valor)} RLU · ${st.fmtHora(u.hora)}${eq.hisopados.length > 1 ? ` · intento ${eq.hisopados.length}` : ""}`)
            : el("small", {}, `No aprobó (${fmtRLU(u.valor)} RLU · ${st.fmtHora(u.hora)}) → ${u.recomendacion}. Falta el hisopado ${e.intento}.`),
      ]),
      e.clave === "ok" ? el("span", { class: "eq-fila-accion sec" }, "Ver") : el("span", { class: "eq-fila-accion" }, e.clave === "rehacer" ? "Nuevo hisopado" : "Registrar")
    );
    // Quitar un equipo agregado por error (solo si no tiene hisopados).
    if (!eq.hisopados.length && l.equipos.length > 1 && !l.liberacion) {
      const quitar = el("span", { class: "eq-quitar", title: "Quitar este equipo", role: "button" }, "✕");
      quitar.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!(await confirmar("Quitar equipo", `¿Quitar «${eq.nombre}» de esta limpieza?`, { si: "Quitar", peligro: true }))) return;
        l.equipos = l.equipos.filter((x) => x !== eq);
        l.cambios.push({ hora: new Date().toISOString(), por: st.getUsuario().nombre, texto: `Quitó el equipo ${eq.nombre}` });
        await persistir(l);
        pintar();
      });
      fila.appendChild(quitar);
    }
    return fila;
  }

  function agregarEquipoSelect() {
    const sel = el("select", { class: "dias" }, [el("option", { value: "" }, "+ Agregar equipo…"), ...CONFIG.limpieza.equipos.filter((e) => !l.equipos.some((x) => x.id === e.id)).map((e) => el("option", { value: e.id }, e.nombre))]);
    sel.addEventListener("change", async () => {
      if (!sel.value) return;
      l.equipos.push({ id: sel.value, nombre: nombreEquipo(sel.value), hisopados: [] });
      l.cambios.push({ hora: new Date().toISOString(), por: st.getUsuario().nombre, texto: `Agregó el equipo ${nombreEquipo(sel.value)}` });
      await persistir(l); // si estaba liberada, vuelve a quedar en curso
      pintar();
    });
    return sel;
  }

  function historial() {
    const hs = l.equipos.flatMap((eq) => eq.hisopados.map((h, i) => ({ ...h, equipo: eq.nombre, intento: i + 1 }))).sort((a, b) => a.hora.localeCompare(b.hora));
    const eventos = [
      { hora: l.inicio, txt: `Inicio de la limpieza · ${l.personas.join(", ")} · asignó ${l.asignadoPor}` },
      ...hs.map((h) => ({ hora: h.hora, txt: `${h.equipo}${h.intento > 1 ? ` (intento ${h.intento})` : ""}: ${fmtRLU(h.valor)} RLU · ${h.resultado}${h.recomendacion ? ` → ${h.recomendacion}` : ""}${h.observacion ? ` · ${h.observacion}` : ""} · ${h.analista}`, mal: h.resultado !== "Aprobado" })),
      ...l.cambios.map((c) => ({ hora: c.hora, txt: `${c.texto} · ${c.por}` })),
      ...(l.liberacion ? [{ hora: l.liberacion, txt: "✓ Equipos liberados", ok: true }] : []),
    ].sort((a, b) => a.hora.localeCompare(b.hora));
    return el("details", { class: "eq-historial", ...(hs.length ? { open: "" } : {}) }, [
      el("summary", {}, `Trazabilidad (${eventos.length})`),
      el("ol", {}, eventos.map((e) => el("li", { class: e.mal ? "mal" : e.ok ? "ok" : "" }, [el("b", {}, st.fmtHora(e.hora)), " ", e.txt]))),
    ]);
  }

  // ---- hisopado de un equipo ----
  function hisopado(eq) {
    const e = estadoEquipo(eq);
    const previos = eq.hisopados.map((h, i) =>
      el("li", { class: h.resultado === "Aprobado" ? "ok" : "mal" }, `Intento ${i + 1} · ${st.fmtHora(h.hora)} · ${fmtRLU(h.valor)} RLU · ${h.resultado}${h.recomendacion ? ` → ${h.recomendacion}` : ""}${h.observacion ? ` · ${h.observacion}` : ""} · ${h.analista}`)
    );
    if (e.clave === "ok") {
      const hh = hoja(eq.nombre, [el("ol", { class: "eq-previos" }, previos), el("p", { class: "nota" }, "Este equipo ya aprobó. Si hay que repetir, registra un hisopado nuevo."), el("button", { class: "btn btn-sec", onclick: () => (hh.cerrar(), formulario(eq, e.intento + 1)) }, "Registrar otro hisopado")], { ancho: 520 });
      return;
    }
    formulario(eq, e.intento, previos);
  }

  function formulario(eq, intento, previos = []) {
    const lectura = campoNum("Lectura del luminómetro", { sufijo: "RLU", paso: "1", autofocus: true });
    const obs = el("textarea", { class: "obs", rows: "2", placeholder: "Observación (opcional)" });
    let rec = null;
    const chips = el("div", { class: "chips-motivo" });
    const otroTxt = el("input", { type: "text", class: "obs hidden", placeholder: "Escribe la recomendación" });
    const pintarChips = () => {
      clear(chips);
      for (const c of [...CONFIG.limpieza.recomendaciones, "Otro"])
        chips.appendChild(el("button", { type: "button", class: `chip-motivo ${rec === c ? "on" : ""}`, onclick: () => ((rec = c), otroTxt.classList.toggle("hidden", c !== "Otro"), c === "Otro" && otroTxt.focus(), pintarChips()) }, c));
    };
    pintarChips();
    const bloqueNo = el("div", { class: "eq-no hidden" }, [el("b", {}, "Recomendación"), chips, otroTxt, el("button", { class: "btn btn-rojo btn-xl", onclick: () => guardarH("No aprobado") }, "Guardar · No aprueba")]);
    const btnSi = el("button", { class: "btn btn-verde eq-decision", onclick: () => guardarH("Aprobado") }, "✓ Aprueba");
    const btnNo = el("button", { class: "btn eq-decision no", onclick: () => {
      if (lectura.val() === null) return falta();
      bloqueNo.classList.remove("hidden");
      btnNo.classList.add("on");
    } }, "✗ No aprueba");
    const falta = () => {
      lectura.wrap.classList.add("campo-vacio");
      lectura.input.focus();
      toast("Escribe la lectura del luminómetro.", "err");
    };
    const h = hoja(
      `Hisopado · ${eq.nombre}`,
      [
        previos.length ? el("ol", { class: "eq-previos" }, previos) : null,
        el("p", { class: "nota" }, `Intento ${intento} · la hora se registra al guardar.`),
        lectura.wrap,
        el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Observación"), obs]),
        el("div", { class: "fila-botones" }, [btnNo, btnSi]),
        bloqueNo,
      ].filter(Boolean),
      { ancho: 520 }
    );
    lectura.input.addEventListener("input", () => lectura.wrap.classList.remove("campo-vacio"));
    setTimeout(() => lectura.input.focus(), 60); // teclado numérico listo al abrir

    async function guardarH(resultado) {
      const valor = lectura.val();
      if (valor === null) return falta();
      let recomendacion = null;
      if (resultado !== "Aprobado") {
        recomendacion = rec === "Otro" ? otroTxt.value.trim() : rec;
        if (!recomendacion) return toast(rec === "Otro" ? "Escribe la recomendación." : "Elige una recomendación.", "err");
      }
      const estabaLiberada = !!l.liberacion;
      const hNuevo = { id: nuevoId("H"), hora: new Date().toISOString(), valor, resultado, recomendacion, observacion: obs.value.trim() || null, analista: st.getUsuario().nombre, correo: st.getUsuario().correo };
      eq.hisopados.push(hNuevo);
      await persistir(l, { hisopado: { eq, h: hNuevo, intento: eq.hisopados.length } });
      h.cerrar();
      if (l.liberacion && !estabaLiberada) toast(`✓ Equipos liberados · ${fmtDurCorta(Date.parse(l.liberacion) - Date.parse(l.inicio))}`);
      else toast(resultado === "Aprobado" ? `${eq.nombre}: aprobado` : `${eq.nombre}: ${recomendacion}`, resultado === "Aprobado" ? "ok" : "err");
      pintar();
    }
  }

  function cambiarPersonas() {
    const sel = selectorPersonas(l.dia, l.personas);
    const btn = el("button", { class: "btn btn-verde btn-xl" }, "Guardar");
    const h = hoja("¿Quién limpia?", [sel.nodo, btn], { ancho: 600 });
    btn.addEventListener("click", async () => {
      const nuevas = sel.valor();
      if (!nuevas.length) return toast("Elige al menos una persona.", "err");
      if (nuevas.join("|") !== l.personas.join("|")) {
        l.cambios.push({ hora: new Date().toISOString(), por: st.getUsuario().nombre, texto: `Personas: ${l.personas.join(", ")} → ${nuevas.join(", ")}` });
        l.personas = nuevas;
        await persistir(l);
      }
      h.cerrar();
      pintar();
    });
  }

  async function anular() {
    if (!(await confirmar("Anular limpieza", "Se quita del tablero (no tiene hisopados). ¿Continuar?", { si: "Anular", peligro: true }))) return;
    l.anulada = true;
    l.cambios.push({ hora: new Date().toISOString(), por: st.getUsuario().nombre, texto: "Anuló la limpieza" });
    await persistir(l);
    location.hash = `#/equipos/${l.dia}`;
  }
}

// ---------------- registro (consulta y copia) ----------------

async function registro(vista) {
  const hoy = st.hoyISO();
  const desde = el("input", { type: "date", class: "dias", value: st.sumarDias(hoy, -6) });
  const hasta = el("input", { type: "date", class: "dias", value: hoy });
  const cuerpo = el("div");
  poner(vista,
    el("a", { class: "volver", href: "#/equipos" }, "← Liberación de equipos"),
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Registro de liberación de equipos"), el("p", { class: "sub" }, "Limpieza y control · hisopados con luminómetro")]),
      el("div", { class: "cab-botones" }, [el("label", { class: "eq-rango" }, ["Desde", desde]), el("label", { class: "eq-rango" }, ["Hasta", hasta])]),
    ]),
    cuerpo
  );
  desde.addEventListener("change", cargar);
  hasta.addEventListener("change", cargar);
  cargar();

  async function cargar() {
    const ls = await limpiezasRango(desde.value, hasta.value);
    clear(cuerpo);
    // Resumen por día (columnas del informe).
    const dias = [...new Set(ls.map((l) => l.dia))].sort().reverse();
    const filasDia = dias.map((d) => {
      const k = indicadoresDia(ls.filter((l) => l.dia === d));
      return [st.fmtDia(d), k.realizados, k.aprobados, textoArranque(k), k.estado, fmtDur(k.cambio), k.corte ? st.fmtHora(k.corte) : ""];
    });
    const encDia = ["Fecha", "Cantidad de hisopados de superficie realizados", "Cantidad de hisopados de superficie aprobados", "Tiempo para arranque de planta", "Estado de registro de limpieza y control de piezas", "Tiempo de cambio de sabor", "Hora de arranque (último equipo liberado)"];
    // Detalle por hisopado (trazabilidad completa).
    const encDet = ["Fecha", "OF", "Producto", "Cliente", "Tipo", "Limpiaron", "Inicio limpieza", "Equipo", "Intento", "Hora hisopado", "Lectura (RLU)", "Resultado", "Recomendación", "Observación", "Analista", "Liberación", "Tiempo de limpieza"];
    const filasDet = [];
    for (const l of [...ls].reverse()) {
      const r = resumen(l);
      for (const eq of l.equipos)
        eq.hisopados.forEach((h, i) =>
          filasDet.push([st.fmtDia(l.dia), l.of || "Sin OF", l.producto, l.cliente, l.tipo, l.personas.join(", "), st.fmtHora(l.inicio), eq.nombre, i + 1, st.fmtHora(h.hora), h.valor, h.resultado, h.recomendacion || "", h.observacion || "", h.analista, l.liberacion ? st.fmtHora(l.liberacion) : "Pendiente", fmtDur(r.duracion)])
        );
    }
    if (!ls.length) return cuerpo.appendChild(el("div", { class: "vacio" }, "No hay limpiezas registradas en este equipo para esas fechas."));
    poner(cuerpo,
      seccion("Método / medición · limpieza y control de piezas", encDia, filasDia, "liberacion_equipos_resumen"),
      seccion(`Detalle por hisopado (${filasDet.length})`, encDet, filasDet, "liberacion_equipos_detalle")
    );
  }

  function seccion(titulo, enc, filas, archivo) {
    const tsv = (conEnc) => [...(conEnc ? [enc] : []), ...filas].map((f) => f.map((c) => String(c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\r\n");
    const copiar = async (conEnc) => {
      try {
        await navigator.clipboard.writeText(tsv(conEnc));
        toast("Copiado: pégalo en Excel.");
      } catch {
        toast("No se pudo copiar.", "err");
      }
    };
    const csv = () => {
      const q = (c) => `"${String(c ?? "").replace(/"/g, '""')}"`;
      const txt = "﻿" + [enc, ...filas].map((f) => f.map(q).join(";")).join("\r\n");
      const a = el("a", { href: URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" })), download: `${archivo}.csv` });
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    return el("section", { class: "card eq-reg" }, [
      el("div", { class: "eq-reg-cab" }, [
        el("h2", {}, titulo),
        el("div", { class: "cab-botones" }, [
          el("button", { class: "btn btn-sec btn-sm", onclick: () => copiar(true) }, "Copiar con encabezados"),
          el("button", { class: "btn btn-sec btn-sm", onclick: () => copiar(false) }, "Copiar filas"),
          el("button", { class: "btn btn-sec btn-sm", onclick: csv }, "CSV"),
        ]),
      ]),
      el("div", { class: "tabla-scroll" }, el("table", { class: "hist-tabla eq-tabla" }, [
        el("thead", {}, el("tr", {}, enc.map((h) => el("th", {}, h)))),
        el("tbody", {}, filas.map((f) => el("tr", { class: f.includes("No aprobado") ? "mal" : "" }, f.map((c) => el("td", {}, String(c ?? "")))))),
      ])),
    ]);
  }
}
