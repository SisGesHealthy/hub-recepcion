// Calidad - Planta: liberación de producto en proceso.
// Del día de producción: órdenes de fabricación de Odoo (archivo cifrado que
// exporta scripts/exportar_of.py) → lotes que Calidad asigna a cada OF (lista
// Lotes, una OF puede dividirse en varios lotes con su propia fecha de
// elaboración) → mediciones por parada (lista Registros) comparadas en vivo con
// los rangos del producto (lista Catalogo-Parametros-Liberacion).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, campoNum, vacio, confirmar, hoja } from "./ui.js";

export async function render(vista, resto) {
  const cat = await st.catalogo();
  const prodDe = (lote) => cat.find((c) => c.ID === lote.Producto_x002d_CODId) || null;
  if (resto[0] === "lote" && resto[1]) return pantallaLote(vista, Number(resto[1]), prodDe);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(resto[0] || "") ? resto[0] : st.hoyISO();
  return pantallaDia(vista, dia, cat);
}

// ---------------- día de producción ----------------

async function pantallaDia(vista, dia, cat) {
  const porCodigo = (codigo) => cat.find((c) => (c.Title || "").trim().toUpperCase() === (codigo || "").trim().toUpperCase()) || null;
  const ir = (d) => (location.hash = `#/planta/${d}`);
  const fechaInp = el("input", { type: "date", class: "dias", value: dia, onchange: (e) => e.target.value && ir(e.target.value) });
  const estadoOdoo = el("p", { class: "sub" });
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando producción…"));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Liberación en proceso"), estadoOdoo]),
      el("div", { class: "cab-botones" }, [
        el("button", { class: "btn btn-sec", title: "Día anterior", onclick: () => ir(st.sumarDias(dia, -1)) }, "‹"),
        fechaInp,
        el("button", { class: "btn btn-sec", title: "Día siguiente", onclick: () => ir(st.sumarDias(dia, 1)) }, "›"),
        dia !== st.hoyISO() ? el("button", { class: "btn btn-sec", onclick: () => ir(st.hoyISO()) }, "Hoy") : null,
        el("button", { class: "btn btn-sec", title: "Actualizar", onclick: () => cargar() }, "↻"),
      ]),
    ]),
    lista
  );

  async function cargar() {
    lista.replaceChildren(el("div", { class: "cargando" }, "Cargando producción…"));
    const [datos, { lotes, prop }] = await Promise.all([st.cargarOF(), st.lotesDelDia(dia)]);
    const ofs = (datos.ofs || []).filter((o) => o.fecha === dia);
    const edad = datos.generado ? (Date.now() - new Date(datos.generado).getTime()) / 3600000 : null;
    clear(estadoOdoo);
    estadoOdoo.append(`Producción del ${st.fmtDia(dia)} · ${ofs.length} ${ofs.length === 1 ? "orden" : "órdenes"} de Odoo`);
    if (datos.generado) estadoOdoo.append(` · Odoo actualizado ${st.fmtFecha(datos.generado)}`);
    clear(lista);
    if (datos.error) lista.appendChild(el("div", { class: "aviso" }, datos.error));
    else if (edad !== null && edad > CONFIG.of.horasVigencia)
      lista.appendChild(el("div", { class: "aviso" }, `Los datos de Odoo tienen ${Math.floor(edad)} h: puede faltar alguna orden creada después. Se actualizan solos cada hora.`));

    const usados = new Set();
    for (const o of ofs) {
      const suyos = lotes.filter((l) => prop && (l[prop] || "") === o.of);
      suyos.forEach((l) => usados.add(l));
      lista.appendChild(tarjetaOF(o, suyos, porCodigo(o.codigo), dia, cargar));
    }
    if (!ofs.length && !datos.error)
      lista.appendChild(el("div", { class: "vacio chico" }, "Odoo no tiene órdenes de fabricación con esta fecha de producción."));

    const otros = lotes.filter((l) => !usados.has(l));
    if (otros.length) {
      lista.appendChild(el("h3", { class: "grupo" }, `Otros lotes del día (sin orden de Odoo) · ${otros.length}`));
      for (const l of otros) lista.appendChild(filaLote(l, cat.find((c) => c.ID === l.Producto_x002d_CODId), dia, cargar, true));
    }
  }
  cargar();
}

function tarjetaOF(o, lotes, prod, dia, recargar) {
  const nuevo = (dividir) => formLote({ of: o, prod, dia, dividir, lotes, recargar });
  return el("article", { class: `orden of-card ${lotes.length ? "con-lote" : "sin-lote"}` }, [
    el("div", { class: "of-cab" }, [
      el("div", { class: "orden-info" }, [
        el("strong", { class: "orden-prov" }, `${o.codigo} · ${o.producto}`),
        el("span", { class: "orden-fecha" }, `${o.of} · ${st.fmtKg(o.cantidad)} ${o.unidad} · ${o.estado}${o.lote_odoo ? ` · lote en Odoo: ${o.lote_odoo}` : ""}`),
        !prod ? el("span", { class: "sin-rango" }, "Producto sin rangos en el catálogo de liberación") : null,
      ]),
      el(
        "div",
        { class: "orden-accion" },
        lotes.length
          ? el("button", { class: "btn btn-sec", onclick: () => nuevo(true) }, "+ Dividir en otro lote")
          : el("button", { class: "btn btn-verde", onclick: () => nuevo(false) }, "Asignar lote")
      ),
    ]),
    lotes.length ? el("div", { class: "of-lotes" }, lotes.map((l) => filaLote(l, prod, dia, recargar))) : null,
  ]);
}

function filaLote(l, prod, dia, recargar, conProducto = false) {
  const elab = st.diaISO(l.field_2);
  return el("div", { class: "of-lote" }, [
    el("div", { class: "orden-info" }, [
      el("strong", {}, l.Title + (l.pendiente ? " ↻" : "")),
      el("span", { class: "orden-fecha" }, [
        conProducto && prod ? `${prod.Title} · ` : "",
        `Elab. ${st.fmtDia(elab)}${elab !== dia ? " (otra fecha)" : ""} · Cad. ${st.fmtDia(st.diaISO(l.field_3))}`,
        l.field_4 === "Finalizado" ? " · Cerrado" : "",
      ]),
    ]),
    l.ID
      ? el("div", { class: "fila-botones of-lote-btns" }, [
          el("button", { class: "btn btn-sec", title: "Corregir código o fechas", onclick: () => formLote({ lote: l, prod, dia, recargar }) }, "✎"),
          el("a", { class: "btn btn-verde", href: `#/planta/lote/${l.ID}` }, "Registrar parada"),
        ])
      : el("span", { class: "estado estado-ambar" }, "Subiendo…"),
  ]);
}

// Asignar / dividir / corregir lote. Fecha de elaboración = fecha de
// producción, salvo al dividir (un lote para completar otro día). Caducidad
// siempre a mano; se muestra la vida útil del último lote como referencia.
async function formLote({ of, prod, dia, dividir = false, lotes = [], lote = null, recargar }) {
  const editando = !!lote;
  // Base para sugerir: al dividir, el lote que ya tiene esta OF; si no, el
  // último lote del producto.
  const previo = editando ? null : dividir && lotes.length ? lotes[lotes.length - 1] : await st.ultimoLoteDeProducto(prod?.ID);
  const elabInicial = editando ? st.diaISO(lote.field_2) : dia;
  let sugerido = "";
  let origen = "";
  if (!editando) {
    if (of?.lote_odoo && !dividir && !/^\d+$/.test(of.lote_odoo)) {
      sugerido = of.lote_odoo;
      origen = "Lote que ya tiene la orden en Odoo";
    } else if (previo) {
      sugerido = st.sugerirCodigoLote(previo, elabInicial) || "";
      origen = sugerido ? `Según ${dividir ? "el lote de esta orden" : "el último lote de este producto"}: ${previo.Title}` : "";
    }
  }
  const codigo = el("input", { type: "text", value: editando ? lote.Title : sugerido, placeholder: "Código de lote", autocomplete: "off" });
  const elab = el("input", { type: "date", value: elabInicial, ...(dividir || editando ? {} : { disabled: "" }) });
  const cad = el("input", { type: "date", value: editando ? st.diaISO(lote.field_3) : "" });
  const vida = el("div", { class: "nota" });
  const ref = previo?.field_2 && previo?.field_3 ? Math.round((new Date(previo.field_3) - new Date(previo.field_2)) / 86400000) : null;
  const meses = (dias) => (dias / 30.44).toFixed(1).replace(".0", "");
  const pintarVida = () => {
    clear(vida);
    if (ref !== null) vida.append(`Último lote de este producto: elab. ${st.fmtDia(st.diaISO(previo.field_2))} → cad. ${st.fmtDia(st.diaISO(previo.field_3))} (${ref} días ≈ ${meses(ref)} meses). `);
    if (cad.value && elab.value) {
      const d = Math.round((new Date(cad.value) - new Date(elab.value)) / 86400000);
      vida.append(el("b", { class: d <= 0 || (ref !== null && Math.abs(d - ref) > 31) ? "texto-rojo" : "" }, `Este lote: ${d} días ≈ ${meses(d)} meses.`));
    }
  };
  cad.addEventListener("input", pintarVida);
  elab.addEventListener("input", () => {
    // Al dividir, si cambia la elaboración se vuelve a sugerir el código.
    if (dividir && previo && !codigo.dataset.tocado) codigo.value = st.sugerirCodigoLote(previo, elab.value) || codigo.value;
    pintarVida();
  });
  codigo.addEventListener("input", () => (codigo.dataset.tocado = "1"));
  pintarVida();

  const btn = el("button", { class: "btn btn-verde btn-xl" }, editando ? "Guardar cambios" : "Confirmar lote");
  const titulo = editando ? `Corregir lote ${lote.Title}` : dividir ? "Dividir en otro lote" : "Asignar lote";
  const h = hoja(titulo, [
    el("p", { class: "sub" }, of ? `${of.of} · ${of.codigo} · ${of.producto}` : prod ? `${prod.Title} · ${prod.field_1}` : ""),
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Código de lote"), codigo, origen ? el("span", { class: "sugerido" }, `Sugerido — revísalo. ${origen}`) : null]),
    el("div", { class: "campos-2" }, [
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, dividir ? "Fecha de elaboración (de este lote)" : "Fecha de elaboración"), elab]),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Fecha de caducidad"), cad]),
    ]),
    !dividir && !editando ? el("p", { class: "nota" }, "La elaboración es la fecha de producción. Para un lote de otra fecha usa “Dividir en otro lote”.") : null,
    vida,
    btn,
  ]);
  setTimeout(() => (sugerido ? cad : codigo).focus(), 250);

  btn.addEventListener("click", async () => {
    const c = codigo.value.trim().toUpperCase().replace(/\s+/g, " ");
    if (!c) return toast("Escribe el código de lote", "err");
    if (!cad.value) return toast("Escribe la fecha de caducidad", "err");
    if (cad.value <= elab.value) return toast("La caducidad debe ser posterior a la elaboración", "err");
    if (!editando && lotes.some((l) => (l.Title || "").toUpperCase() === c)) return toast(`El lote ${c} ya está asignado a esta orden`, "err");
    const d = Math.round((new Date(cad.value) - new Date(elab.value)) / 86400000);
    if (ref !== null && Math.abs(d - ref) > 31) {
      const ok = await confirmar("Revisa la caducidad", `Este lote dura ${d} días (≈ ${meses(d)} meses) y el último de este producto duraba ${ref} días (≈ ${meses(ref)} meses). ¿Es correcto?`, { si: "Sí, es correcto", no: "Corregir" });
      if (!ok) return;
    }
    btn.disabled = true;
    if (editando) await st.editarLote(lote, { codigo: c, fechaElab: elab.value, fechaCad: cad.value });
    else await st.crearLote({ codigo: c, of: of?.of, fechaProduccion: dia, fechaElab: elab.value, fechaCad: cad.value, catId: prod?.ID });
    h.cerrar();
    toast(editando ? "Lote actualizado" : `Lote ${c} asignado`);
    setTimeout(recargar, 600);
  });
}

// ---------------- lote: registro de paradas ----------------

async function pantallaLote(vista, id, prodDe) {
  let lote = null;
  try {
    lote = await st.getLote(id);
  } catch {}
  if (!lote) return vacio(vista, "Lote no encontrado (sin conexión o eliminado). Vuelve a la lista.");
  const prod = prodDe(lote);
  const tabla = el("div", { class: "paradas" });
  let paradas = [];

  const rangoTxt = (min, max) => (min === null || min === undefined) && (max === null || max === undefined) ? "sin rango" : `${min ?? "—"} – ${max ?? "—"}`;
  const pinta = (campo, estado) => {
    campo.wrap.classList.remove("ok", "bajo", "alto");
    if (estado) campo.wrap.classList.add(estado);
  };
  const ratioOut = el("div", { class: "ratio" });
  const brix = campoNum("°Brix", { oninput: () => evaluar(), autofocus: true });
  const ph = campoNum("pH", { oninput: () => evaluar() });
  const acidez = campoNum("Acidez", { oninput: () => evaluar() });
  const recorrido = campoNum("Recorrido (opcional)");
  const fruta = campoNum("% fruta (opcional)", { sufijo: "%" });
  const responsable = el("select", {}, CONFIG.responsablesPlanta.map((r) => el("option", { value: r }, r)));
  responsable.value = await kv.get("ultimoResponsablePlanta", CONFIG.responsablesPlanta[0]);
  const repeticion = el("input", { type: "checkbox" });
  const obs = el("input", { type: "text", class: "obs", placeholder: "Observación (opcional)" });
  const nParada = el("b", { class: "n-parada" });

  function evaluar() {
    const v = { brix: brix.val(), ph: ph.val(), acidez: acidez.val() };
    v.ratio = v.brix && v.acidez ? v.brix / v.acidez : null;
    const ev = st.evaluarRango(prod, v);
    pinta(brix, ev.brix);
    pinta(ph, ev.ph);
    pinta(acidez, ev.acidez);
    ratioOut.className = "ratio " + (ev.ratio || "");
    ratioOut.textContent = v.ratio ? `Ratio ${v.ratio.toFixed(2)}${prod?.field_9 != null ? ` (rango ${rangoTxt(prod.field_9, prod.field_10)})` : ""}` : "";
    return { v, ev };
  }

  function siguienteParada() {
    return Math.max(0, ...paradas.filter((p) => !p.Repeticion).map((p) => p.field_1 || 0)) + 1;
  }

  async function cargar() {
    const [srv, pend] = await Promise.all([st.registrosDeLote(lote), st.paradasPendientes(lote.Title)]);
    paradas = [...srv, ...pend].sort((a, b) => (a.field_1 || 0) - (b.field_1 || 0));
    nParada.textContent = `Parada ${siguienteParada()}`;
    clear(tabla);
    if (!paradas.length) return tabla.appendChild(el("div", { class: "vacio chico" }, "Sin paradas registradas aún."));
    const celda = (val, min, max) => {
      const ev = val === null || val === undefined ? null : (min != null && val < min) || (max != null && val > max) ? "fuera" : "";
      return el("td", { class: ev || "" }, val === null || val === undefined ? "—" : String(Math.round(val * 100) / 100));
    };
    tabla.appendChild(
      el("table", {}, [
        el("tr", {}, ["Parada", "°Bx", "pH", "Acidez", "Ratio", "Resp.", ""].map((x) => el("th", {}, x))),
        ...paradas.map((p) =>
          el("tr", {}, [
            el("td", {}, `${p.field_1}${p.Repeticion ? " (rep.)" : ""}`),
            celda(p.field_2, prod?.field_3, prod?.field_4),
            celda(p.field_3, prod?.field_5, prod?.field_6),
            celda(p.field_4, prod?.field_7, prod?.field_8),
            celda(p.field_8, prod?.field_9, prod?.field_10),
            el("td", {}, p.field_9 || ""),
            el("td", {}, p.pendiente ? "↻" : "✓"),
          ])
        ),
      ])
    );
  }

  const btn = el("button", { class: "btn btn-verde btn-xl", type: "submit" }, "Guardar parada");
  const form = el("form", { class: "pallet-form", novalidate: "" }, [
    el("div", { class: "fila-sep" }, [nParada, el("label", { class: "check" }, [repeticion, " Repetición de la parada anterior"])]),
    el("div", { class: "campos-3" }, [brix.wrap, ph.wrap, acidez.wrap]),
    ratioOut,
    el("details", { class: "tara-pallet" }, [el("summary", {}, "Recorrido / % fruta"), el("div", { class: "campos-2" }, [recorrido.wrap, fruta.wrap])]),
    el("div", { class: "campos-2" }, [el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Responsable"), responsable]), el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Observación"), obs])]),
    btn,
  ]);
  repeticion.addEventListener("change", () => {
    const n = repeticion.checked ? Math.max(1, siguienteParada() - 1) : siguienteParada();
    nParada.textContent = `Parada ${n}${repeticion.checked ? " · repetición" : ""}`;
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { v, ev } = evaluar();
    if (v.brix === null || v.ph === null) return toast("Ingresa al menos °Brix y pH", "err");
    const fuera = Object.entries(ev).filter(([, x]) => x === "bajo" || x === "alto");
    if (fuera.length && !obs.value.trim()) {
      const ok = await confirmar(
        "Fuera de especificación",
        `${fuera.map(([k, x]) => `${k} ${x}`).join(", ")}. ¿Registrar igual? Se recomienda anotar la acción tomada en Observación y repetir la medición.`,
        { si: "Registrar igual", no: "Volver" }
      );
      if (!ok) return;
    }
    btn.disabled = true;
    const parada = repeticion.checked ? Math.max(1, siguienteParada() - 1) : siguienteParada();
    await st.registrarParada(lote, prod, {
      ...v,
      ratio: v.ratio ? Math.round(v.ratio * 1e4) / 1e4 : null,
      parada,
      recorrido: recorrido.val(),
      fruta: fruta.val(),
      responsable: responsable.value,
      obs: obs.value.trim(),
      repeticion: repeticion.checked,
    });
    btn.disabled = false;
    toast(`Parada ${parada} registrada`);
    for (const c of [brix, ph, acidez, recorrido, fruta]) {
      c.input.value = "";
      pinta(c, null);
    }
    obs.value = "";
    repeticion.checked = false;
    ratioOut.textContent = "";
    await cargar();
    brix.input.focus();
  });

  const especif = prod
    ? el("div", { class: "especif" }, [
        el("span", {}, ["°Bx ", el("b", {}, rangoTxt(prod.field_3, prod.field_4))]),
        el("span", {}, ["pH ", el("b", {}, rangoTxt(prod.field_5, prod.field_6))]),
        el("span", {}, ["Acidez ", el("b", {}, rangoTxt(prod.field_7, prod.field_8))]),
        el("span", {}, ["Ratio ", el("b", {}, rangoTxt(prod.field_9, prod.field_10))]),
      ])
    : el("div", { class: "aviso" }, "Este producto no tiene rangos en el catálogo: se registra sin validación.");

  vista.append(
    el("section", { class: "rec-cab" }, [
      el("a", { href: `#/planta/${st.diaISO(lote.Fechadeproducci_x00f3_n) || ""}`, class: "volver" }, "← Producción del día"),
      el("div", { class: "rec-titulo" }, [el("h1", {}, lote.Title), el("span", {}, prod ? `${prod.Title} · ${prod.field_1}` : "")]),
      especif,
    ]),
    el("div", { class: "rec-grid" }, [
      el("section", { class: "card" }, [el("h2", {}, "Nueva medición"), form]),
      el("section", { class: "card" }, [
        el("h2", {}, "Paradas del lote"),
        tabla,
        el("div", { class: "fin-wrap" }, el("button", {
          class: "btn btn-sec",
          onclick: async () => {
            if (await confirmar("Cerrar lote", `${lote.Title} pasa a "Finalizado" y deja de aparecer en la lista.`, { si: "Cerrar lote" })) {
              await st.cerrarLote(lote);
              toast("Lote cerrado");
              location.hash = `#/planta/${st.diaISO(lote.Fechadeproducci_x00f3_n) || ""}`;
            }
          },
        }, "Cerrar lote")),
      ]),
    ])
  );
  await cargar();
}
