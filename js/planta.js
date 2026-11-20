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
  if (resto[0] === "reporte") return (await import("./reporte.js")).render(vista);
  if (resto[0] === "micro") return pantallaMicroPendiente(vista, cat);
  if (resto[0] === "qr") return (await import("./accesos.js")).render(vista);
  if (resto[0] === "solicitudes") return pantallaSolicitudes(vista);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(resto[0] || "") ? resto[0] : st.hoyISO();
  return pantallaDia(vista, dia, cat);
}

// ---------------- solicitudes de modificación ----------------

// Botón con el número de solicitudes pendientes (se llena al cargar).
function btnSolicitudes() {
  const a = el("a", { class: "btn btn-sec", href: "#/planta/solicitudes" }, "📝 Solicitudes");
  st.solicitudesPendientes("planta")
    .then((xs) => {
      if (xs.length) {
        a.textContent = `📝 Solicitudes (${xs.length})`;
        if (st.esAprobador("planta")) a.classList.add("btn-amarillo");
      }
    })
    .catch(() => {});
  return a;
}

async function pantallaSolicitudes(vista) {
  const aprobador = st.esAprobador("planta");
  const pend = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando…"));
  const hist = el("div", { class: "reporte-wrap" });
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: `#/planta/${st.hoyISO()}`, class: "volver" }, "← Producción del día"),
        el("h1", { class: "titulo" }, "Solicitudes de modificación"),
        el("p", { class: "sub" }, aprobador ? "Revisa cada cambio y su justificación: al aprobar se aplica al registro." : "Cambios pedidos a registros ya guardados. Los aprueba Calidad."),
      ]),
    ]),
    el("h2", {}, "Pendientes"),
    pend,
    el("h2", {}, "Últimos 45 días"),
    hist
  );
  let xs = [];
  try {
    xs = await st.solicitudesPendientes("planta");
  } catch (e) {
    return vacio(pend, "No se pudo leer SharePoint: " + e.message);
  }
  clear(pend);
  if (!xs.length) pend.appendChild(el("div", { class: "vacio chico" }, "No hay solicitudes pendientes. ✓"));
  for (const sol of xs) {
    const comentario = el("input", { type: "text", placeholder: "Comentario (obligatorio si rechazas)" });
    const resolver = async (aprobar) => {
      if (!aprobar && !comentario.value.trim()) return toast("Escribe por qué se rechaza", "err"), comentario.focus();
      if (sol.pendienteSubir) return toast("Esta solicitud aún no sube a SharePoint; inténtalo en un momento.", "err");
      // ¿El registro cambió desde que se pidió?
      let aviso = "";
      try {
        const actual = (await st.registroPorId(sol.ItemID)) || {};
        const dif = JSON.parse(sol.Cambios || "[]").filter((c) => (actual[c.campo] ?? null) !== (c.antes ?? null) && !(typeof c.antes === "number" && Math.abs((actual[c.campo] ?? 0) - c.antes) < 1e-9));
        if (dif.length) aviso = `\n\nOjo: desde la solicitud cambió ${dif.map((c) => c.etiqueta).join(", ")} en el registro. Si apruebas, queda el valor solicitado.`;
      } catch {}
      if (!(await confirmar(aprobar ? "Aprobar cambio" : "Rechazar cambio", `${sol.Referencia}\n\n${sol.Resumen}${aviso}`, { si: aprobar ? "Aprobar y aplicar" : "Rechazar", peligro: !aprobar }))) return;
      await st.resolverSolicitud(sol, aprobar, comentario.value.trim());
      toast(aprobar ? "Cambio aprobado y aplicado" : "Solicitud rechazada");
      await st.subirAhora();
      location.reload();
    };
    pend.appendChild(
      el("article", { class: "orden solicitud" }, [
        el("div", { class: "orden-info" }, [
          el("strong", { class: "orden-prov" }, `${sol.Title} · ${sol.Referencia || ""}`),
          el("span", { class: "orden-fecha" }, `Pide: ${sol.Solicitante || sol.SolicitanteCorreo || "—"}${sol.Created ? ` · ${st.fmtDia(st.diaISO(sol.Created))} ${st.fmtHora(sol.Created)}` : ""}${sol.pendienteSubir ? " · ↻ subiendo" : ""}`),
          el("pre", { class: "sol-cambios" }, sol.Resumen || ""),
          el("p", { class: "sol-just" }, ["Justificación: ", el("b", {}, sol.Justificacion || "—")]),
        ]),
        aprobador
          ? el("div", { class: "sol-acciones" }, [
              comentario,
              el("div", { class: "fila-botones" }, [
                el("button", { class: "btn btn-sec", onclick: () => resolver(false) }, "Rechazar"),
                el("button", { class: "btn btn-verde", onclick: () => resolver(true) }, "Aprobar"),
              ]),
            ])
          : el("span", { class: "estado estado-ambar" }, "Esperando aprobación"),
      ])
    );
  }
  try {
    const rec = (await st.solicitudesRecientes("planta")).filter((x) => x.Estado !== "Pendiente");
    if (!rec.length) return hist.appendChild(el("p", { class: "nota" }, "Sin solicitudes resueltas en este período."));
    hist.appendChild(
      el("table", { class: "doc-tabla" }, [
        el("tr", {}, ["Código", "Registro", "Cambios", "Justificación", "Pidió", "Estado", "Resolvió"].map((x) => el("th", {}, x))),
        ...rec.map((x) =>
          el("tr", {}, [
            el("td", {}, x.Title),
            el("td", {}, x.Referencia || ""),
            el("td", {}, el("pre", { class: "sol-cambios" }, x.Resumen || "")),
            el("td", {}, x.Justificacion || ""),
            el("td", {}, x.Solicitante || ""),
            el("td", {}, el("span", { class: `estado ${x.Estado === "Aprobada" ? "estado-verde" : "estado-rojo"}` }, x.Directa ? "Edición directa" : x.Estado)),
            el("td", {}, `${x.Resolutor || ""}${x.FechaResolucion ? ` · ${st.fmtDia(st.diaISO(x.FechaResolucion))}` : ""}${x.ComentarioResolucion ? ` · ${x.ComentarioResolucion}` : ""}`),
          ])
        ),
      ])
    );
  } catch (e) {
    hist.appendChild(el("p", { class: "nota" }, "No se pudo leer el historial: " + e.message));
  }
}

// ---------------- microbiología pendiente ----------------

// Formulario de resultados de laboratorio. actual: valores ya cargados.
function formMicro(actual = {}) {
  const aer = campoNum("Aerobios", { valor: actual.aerobios ?? "" });
  const moh = campoNum("Mohos y levaduras", { valor: actual.mohos ?? "" });
  const col = campoNum("Coliformes", { valor: actual.coliformes ?? "" });
  const eco = campoNum("E. coli", { valor: actual.ecoli ?? "" });
  const sal = el("input", { type: "text", value: actual.salmonella ?? "", placeholder: "Ej. Ausencia" });
  return {
    nodo: el("div", { class: "campos-3" }, [aer.wrap, moh.wrap, col.wrap, eco.wrap, el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Salmonella"), sal])]),
    valores: () => ({ aerobios: aer.val(), mohos: moh.val(), coliformes: col.val(), ecoli: eco.val(), salmonella: sal.value.trim() }),
  };
}

// Valores de microbiología ya cargados en alguna parada del grupo.
async function microActual(regs) {
  const cols = await st.columnasRegistros();
  const r = regs.find((x) => cols.aerobios && x[cols.aerobios] != null) || regs.find((x) => cols.mohos && x[cols.mohos] != null);
  if (!r) return {};
  const v = (k) => (cols[k] ? r[cols[k]] : null);
  return { aerobios: v("aerobios"), mohos: v("mohos"), coliformes: v("coliformes"), ecoli: v("ecoli"), salmonella: v("salmonella") };
}

async function pantallaMicroPendiente(vista, cat) {
  const nombreProd = (cod) => {
    const p = cat.find((c) => (c.Ordenamiento || "").trim() === (cod || "").trim());
    return p ? `${p.Title} · ${p.field_1 || ""}` : cod || "Producto sin código";
  };
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Buscando producción sin microbiología…"));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: `#/planta/${st.hoyISO()}`, class: "volver" }, "← Producción del día"),
        el("h1", { class: "titulo" }, "Microbiología pendiente"),
        el("p", { class: "sub" }, "Por producto y fecha de fabricación (últimas 3 semanas). El resultado se aplica a todos los lotes de ese día."),
      ]),
    ]),
    lista
  );
  let rows = [];
  try {
    rows = await st.lotesMicroPendiente(21);
  } catch (e) {
    return vacio(lista, "No se pudo leer SharePoint: " + e.message);
  }
  clear(lista);
  if (!rows.length) return vacio(lista, "No hay producción pendiente de microbiología. ✓");
  for (const g of rows)
    lista.appendChild(
      el("div", { class: "orden lote" }, [
        el("div", { class: "orden-info" }, [
          el("strong", { class: "orden-prov" }, nombreProd(g.codProducto)),
          el("span", { class: "orden-fecha" }, `Fabricación ${st.fmtDia(g.fecha)} · ${g.lotes.length === 1 ? "lote" : `${g.lotes.length} lotes`}: ${g.lotes.map((l) => l.lote).join(", ")}`),
          el("span", { class: "orden-fecha" }, `${g.paradas - g.conMicro} de ${g.paradas} paradas sin resultado`),
        ]),
        el("div", { class: "orden-accion" }, el("button", { class: "btn btn-verde", disabled: g.codProducto ? null : "", onclick: () => cargarMicroGrupo(g, nombreProd(g.codProducto)) }, "Cargar resultado")),
      ])
    );
}

async function cargarMicroGrupo(g, nombre) {
  let regs = [];
  try {
    regs = await st.registrosMicroGrupo(g.codProducto, g.fecha);
  } catch (e) {
    return toast("No se pudo leer SharePoint: " + e.message, "err");
  }
  const f = formMicro(await microActual(regs));
  const btn = el("button", { class: "btn btn-verde btn-xl" }, `Guardar en las ${regs.length} paradas`);
  const h = hoja("Microbiología", [
    el("p", { class: "sub" }, `${nombre} · fabricación ${st.fmtDia(g.fecha)}`),
    el("p", { class: "nota" }, `Se guarda en ${g.lotes.length === 1 ? "el lote" : `los ${g.lotes.length} lotes`} ${g.lotes.map((l) => l.lote).join(", ")} (${regs.length} paradas).`),
    f.nodo,
    btn,
  ]);
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const n = await st.guardarMicroLote(regs, f.valores());
    if (!n) {
      btn.disabled = false;
      return toast("Ingresa al menos un resultado", "err");
    }
    h.cerrar();
    toast(`Microbiología guardada en ${n} paradas`);
    await st.subirAhora();
    location.reload();
  });
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
        el("a", { class: "btn btn-sec", href: "#/planta/micro" }, "🧫 Micro pendiente"),
        el("a", { class: "btn btn-sec", href: "#/planta/reporte" }, "📊 Reporte"),
        el("a", { class: "btn btn-sec", href: "#/planta/qr", title: "Códigos QR de acceso directo" }, "▦ QR"),
        btnSolicitudes(),
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

// Las columnas del Excel "MODELO LIBERACIONES 2026" se capturan aquí: medición
// (°Bx, pH, acidez, viscosidad, recorrido, % fruta), sensorial y controles
// PPRO/PCC (precargados pero con confirmación obligatoria del analista, para
// que no sea copiar y pegar), liberación, incidente/correcciones.
// La microbiología llega días después y se carga una vez para todo el lote.
async function pantallaLote(vista, id, prodDe) {
  let lote = null;
  try {
    lote = await st.getLote(id);
  } catch {}
  if (!lote) return vacio(vista, "Lote no encontrado (sin conexión o eliminado). Vuelve a la lista.");
  const prod = prodDe(lote);
  const cols = await st.columnasRegistros();
  const faltanCols = Object.entries(cols).filter(([, p]) => !p).map(([k]) => CONFIG.registrosExtra[k]);
  const tabla = el("div", { class: "paradas" });
  const micro = el("div");
  let paradas = [];
  const extras = new Map(); // registro → extras leídos
  let solPend = new Map(); // ID de registro → solicitud de cambio pendiente

  const rangoTxt = (min, max) => ((min === null || min === undefined) && (max === null || max === undefined) ? "sin rango" : `${min ?? "—"} – ${max ?? "—"}`);
  const pinta = (campo, estado) => {
    campo.wrap.classList.remove("ok", "bajo", "alto");
    if (estado) campo.wrap.classList.add(estado);
  };
  const sel = (opciones, vacio = true) => el("select", {}, [...(vacio ? [el("option", { value: "" }, "—")] : []), ...opciones.map((o) => el("option", { value: o }, o))]);
  const campoSel = (label, s) => el("label", { class: "campo" }, [el("span", { class: "campo-label" }, label), s]);

  // --- medición ---
  const ratioOut = el("div", { class: "ratio" });
  const brix = campoNum("°Brix", { oninput: () => evaluar(), autofocus: true });
  const ph = campoNum("pH", { oninput: () => evaluar() });
  const acidez = campoNum("Acidez", { oninput: () => evaluar() });
  const viscosidad = campoNum("Viscosidad");
  const recorrido = campoNum("Recorrido");
  const fruta = campoNum("% fruta", { sufijo: "%" });

  // --- tipo de parada: nueva o repetición de una existente ---
  const tipo = el("select", { class: "tipo-parada" });
  const nParada = el("b", { class: "n-parada" });

  // --- sensorial y controles ---
  const color = el("input", { type: "text", placeholder: "OK o código Pantone (ej. 7402 C)" });
  const olor = sel(CONFIG.opciones.sensorial);
  const sabor = sel(CONFIG.opciones.sensorial);
  const pproD = sel(CONFIG.opciones.control);
  const pproF = sel(CONFIG.opciones.control);
  const pcc1 = sel(CONFIG.opciones.pcc1);
  const pcc2 = sel(CONFIG.opciones.control);
  const origenPrecarga = el("span", { class: "sugerido" });
  const confirma = el("input", { type: "checkbox" });
  const bloqueCtrl = el("fieldset", { class: "bloque-confirmar" }, [
    el("legend", {}, "Sensorial y controles"),
    origenPrecarga,
    el("div", { class: "campos-3" }, [el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Color"), color]), campoSel("Olor", olor), campoSel("Sabor", sabor)]),
    el("div", { class: "campos-2" }, [campoSel("PPRO desinfección", pproD), campoSel("PPRO filtrado", pproF), campoSel("PCC 1 pasteurizado", pcc1), campoSel("PCC 2 pernos y tuercas", pcc2)]),
    el("label", { class: "check confirmar" }, [confirma, " Revisé y confirmo que estos datos corresponden a ESTA parada"]),
  ]);
  for (const x of [color, olor, sabor, pproD, pproF, pcc1, pcc2]) x.addEventListener("change", () => bloqueCtrl.classList.add("editado"));

  // --- liberación ---
  const liberacion = sel(CONFIG.opciones.liberacion, false);
  const incidente = el("textarea", { rows: "2", placeholder: "¿Qué pasó? (solo si no se libera)" });
  const correcciones = el("textarea", { rows: "2", placeholder: "Acción tomada en producción (ej. se añaden 20 kg de agua)" });
  const bloqueNoLib = el("div", { class: "campos-2 hidden" }, [campoSel("Detalle del incidente", incidente), campoSel("Correcciones", correcciones)]);
  let liberacionTocada = false;
  liberacion.addEventListener("change", () => {
    liberacionTocada = true;
    bloqueNoLib.classList.toggle("hidden", liberacion.value === "Liberado");
  });

  const responsable = el("select", {}, CONFIG.responsablesPlanta.map((r) => el("option", { value: r }, r)));
  const ultimoResp = await kv.get("ultimoResponsablePlanta", "");
  responsable.value = CONFIG.responsablesPlanta.includes(ultimoResp) ? ultimoResp : CONFIG.responsablesPlanta[0];
  const obs = el("input", { type: "text", class: "obs", placeholder: "Observación (opcional)" });

  function evaluar() {
    const v = { brix: brix.val(), ph: ph.val(), acidez: acidez.val() };
    v.ratio = v.brix && v.acidez ? v.brix / v.acidez : null;
    const ev = st.evaluarRango(prod, v);
    pinta(brix, ev.brix);
    pinta(ph, ev.ph);
    pinta(acidez, ev.acidez);
    ratioOut.className = "ratio " + (ev.ratio || "");
    ratioOut.textContent = v.ratio ? `Ratio ${v.ratio.toFixed(2)}${prod?.field_9 != null ? ` (rango ${rangoTxt(prod.field_9, prod.field_10)})` : ""}` : "";
    // Liberación sugerida según rangos, mientras el analista no la cambie.
    if (!liberacionTocada) {
      const fuera = Object.values(ev).some((x) => x === "bajo" || x === "alto");
      liberacion.value = fuera ? "No liberado" : "Liberado";
      bloqueNoLib.classList.toggle("hidden", liberacion.value === "Liberado");
    }
    return { v, ev };
  }

  const numeros = () => [...new Set(paradas.map((p) => p.field_1 || 0))].sort((a, b) => a - b);
  const siguienteParada = () => Math.max(0, ...numeros()) + 1;
  const sigRep = (n) => {
    const reps = paradas.filter((p) => p.field_1 === n && p.Repeticion).map((p) => extras.get(p)?.numRep || 1);
    return reps.length ? Math.max(...reps) + 1 : 1;
  };
  function etiquetaActual() {
    if (tipo.value === "nueva") return { parada: siguienteParada(), repeticion: false, numRep: null, texto: `Parada ${siguienteParada()}` };
    const n = Number(tipo.value);
    const r = sigRep(n);
    return { parada: n, repeticion: true, numRep: r, texto: `Parada ${n}.${r} · repetición de la ${n}` };
  }
  const pintarTipo = () => (nParada.textContent = etiquetaActual().texto);
  tipo.addEventListener("change", pintarTipo);

  // Precarga de sensorial/controles: parada anterior de este lote o, si es la
  // primera, el último registro del producto. Siempre a confirmar.
  async function precargar() {
    let base = paradas.length ? paradas[paradas.length - 1] : null;
    let origen = base ? `parada ${st.etiquetaParada(base, extras.get(base)?.numRep)} de este lote` : "";
    let ex = base ? extras.get(base) : null;
    const conDatos = (e) => e && (e.color || e.pcc1 || e.pproDesinf);
    if (!conDatos(ex)) {
      ex = null;
      const ult = await st.ultimoRegistroDeProducto(prod);
      if (ult) {
        const e2 = await st.extrasDe(ult);
        if (conDatos(e2)) {
          ex = e2;
          origen = `último lote de este producto (${ult.Title})`;
        }
      }
    }
    color.value = ex?.color || "";
    olor.value = ex?.olor || "OK";
    sabor.value = ex?.sabor || "OK";
    pproD.value = ex?.pproDesinf || "";
    pproF.value = ex?.pproFiltrado || "";
    pcc1.value = ex?.pcc1 || "";
    pcc2.value = ex?.pcc2 || "";
    origenPrecarga.textContent = ex ? `Precargado de la ${origen}. Revísalo: no lo confirmes sin verificar.` : "Sin registros anteriores de este producto: completa los campos.";
    confirma.checked = false;
    bloqueCtrl.classList.remove("editado");
  }

  async function cargar() {
    const [srv, pend, sols] = await Promise.all([st.registrosDeLote(lote), st.paradasPendientes(lote.Title), st.solicitudesPendientes("planta").catch(() => [])]);
    solPend = new Map(sols.filter((x) => x.Lista === "registros").map((x) => [x.ItemID, x]));
    paradas = [...srv, ...pend];
    for (const p of paradas) extras.set(p, p.pendiente ? Object.fromEntries(Object.entries(cols).map(([k, prop]) => [k, prop ? p[prop] ?? null : null])) : await st.extrasDe(p));
    paradas.sort((a, b) => (a.field_1 || 0) - (b.field_1 || 0) || (a.Repeticion ? 1 : 0) - (b.Repeticion ? 1 : 0) || (extras.get(a)?.numRep || 0) - (extras.get(b)?.numRep || 0));
    // opciones del tipo de parada
    clear(tipo);
    tipo.append(el("option", { value: "nueva" }, `Nueva: parada ${siguienteParada()}`), ...numeros().map((n) => el("option", { value: String(n) }, `Repetir parada ${n} (→ ${n}.${sigRep(n)})`)));
    pintarTipo();
    pintarTabla();
    pintarMicro();
  }

  function pintarTabla() {
    clear(tabla);
    if (!paradas.length) return tabla.appendChild(el("div", { class: "vacio chico" }, "Sin paradas registradas aún."));
    const celda = (val, min, max) => {
      const ev = val === null || val === undefined ? null : (min != null && val < min) || (max != null && val > max) ? "fuera" : "";
      return el("td", { class: ev || "" }, val === null || val === undefined ? "—" : String(Math.round(val * 100) / 100));
    };
    tabla.appendChild(
      el("table", {}, [
        el("tr", {}, ["Parada", "°Bx", "pH", "Acidez", "Ratio", "Liberación", "Resp.", "", ""].map((x) => el("th", {}, x))),
        ...paradas.map((p) => {
          const ex = extras.get(p) || {};
          return el("tr", {}, [
            el("td", {}, st.etiquetaParada(p, ex.numRep)),
            celda(p.field_2, prod?.field_3, prod?.field_4),
            celda(p.field_3, prod?.field_5, prod?.field_6),
            celda(p.field_4, prod?.field_7, prod?.field_8),
            celda(p.field_8, prod?.field_9, prod?.field_10),
            el("td", { class: ex.liberacion && ex.liberacion !== "Liberado" ? "fuera" : "" }, ex.liberacion || "—"),
            el("td", {}, st.nombreResponsable(p.field_9)),
            el("td", {}, p.pendiente ? "↻" : "✓"),
            el(
              "td",
              {},
              !p.ID
                ? ""
                : solPend.has(p.ID)
                  ? el("a", { class: "btn btn-sec btn-mini", href: "#/planta/solicitudes", title: solPend.get(p.ID).Resumen || "" }, "⏳ Cambio pendiente")
                  : el("button", { class: `btn ${st.paradaIncompleta(ex) ? "btn-amarillo" : "btn-sec"} btn-mini`, type: "button", onclick: () => modificar(p) }, st.esAprobador("planta") ? (st.paradaIncompleta(ex) ? "Completar" : "✎ Editar") : st.paradaIncompleta(ex) ? "Solicitar completar" : "Solicitar cambio")
            ),
          ]);
        }),
      ])
    );
  }

  // Cambiar una parada ya guardada (incluida información que faltó): quien no
  // es aprobador envía una SOLICITUD con justificación; el aprobador (Calidad /
  // Sistemas, ver Configuración) edita directo y también queda la constancia.
  async function modificar(p) {
    const ex = extras.get(p) || {};
    const aprobador = st.esAprobador("planta");
    const etiqueta = st.etiquetaParada(p, ex.numRep);
    const referencia = `Lote ${lote.Title} · parada ${etiqueta} · ${st.fmtDia(st.diaISO(lote.Fechadeproducci_x00f3_n))}`;
    // [clave, etiqueta, propiedad SharePoint, tipo, valor actual]
    const defs = [
      ["brix", "°Brix", "field_2", "num", p.field_2],
      ["ph", "pH", "field_3", "num", p.field_3],
      ["acidez", "Acidez", "field_4", "num", p.field_4],
      ["viscosidad", "Viscosidad", "field_6", "num", p.field_6],
      ["recorrido", "Recorrido", "field_5", "num", p.field_5],
      ["fruta", "% fruta", "field_7", "num", p.field_7],
      ["color", "Color", cols.color, "txt", ex.color],
      ["olor", "Olor", cols.olor, CONFIG.opciones.sensorial, ex.olor],
      ["sabor", "Sabor", cols.sabor, CONFIG.opciones.sensorial, ex.sabor],
      ["pproDesinf", "PPRO desinfección", cols.pproDesinf, CONFIG.opciones.control, ex.pproDesinf],
      ["pproFiltrado", "PPRO filtrado", cols.pproFiltrado, CONFIG.opciones.control, ex.pproFiltrado],
      ["pcc1", "PCC 1 pasteurizado", cols.pcc1, CONFIG.opciones.pcc1, ex.pcc1],
      ["pcc2", "PCC 2 pernos y tuercas", cols.pcc2, CONFIG.opciones.control, ex.pcc2],
      ["liberacion", "Liberación", cols.liberacion, CONFIG.opciones.liberacion, ex.liberacion],
      ["incidente", "Detalle del incidente", cols.incidente, "area", ex.incidente],
      ["correcciones", "Correcciones", cols.correcciones, "area", ex.correcciones],
      ["responsable", "Responsable", "field_9", [...new Set([st.nombreResponsable(p.field_9), ...CONFIG.responsablesPlanta].filter(Boolean))], st.nombreResponsable(p.field_9)],
      ["obs", "Observaciones", "Observaciones", "txt", p.Observaciones],
    ].filter((d) => d[2]);
    const entradas = defs.map(([k, label, prop, tipoD, actual]) => {
      if (tipoD === "num") {
        const c = campoNum(label, { valor: actual ?? "" });
        return { k, label, prop, tipoD, actual, wrap: c.wrap, leer: () => c.val() };
      }
      let x;
      if (Array.isArray(tipoD)) {
        x = sel(tipoD);
        x.value = actual ?? "";
      } else if (tipoD === "area") x = el("textarea", { rows: "2" }, actual ?? "");
      else x = el("input", { type: "text", value: actual ?? "" });
      const vacio = actual === null || actual === undefined || actual === "";
      return { k, label, prop, tipoD, actual, wrap: el("label", { class: `campo ${vacio ? "campo-vacio" : ""}` }, [el("span", { class: "campo-label" }, label), x]), leer: () => (x.value.trim() === "" ? null : x.value.trim()) };
    });
    const igual = (a, b) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
    const just = el("textarea", { rows: "3", placeholder: "¿Por qué se cambia? (ej. faltó registrar el PCC 1; dato tomado del registro físico de la línea)" });
    const btnG = el("button", { class: "btn btn-verde btn-xl" }, aprobador ? "Guardar cambio" : "Enviar solicitud");
    const vacios = entradas.filter((e) => e.actual === null || e.actual === undefined || e.actual === "").length;
    const h = hoja(aprobador ? `Editar parada ${etiqueta}` : `Solicitar cambio · parada ${etiqueta}`, [
      el("p", { class: "sub" }, referencia),
      el("p", { class: "nota" }, aprobador
        ? "Eres aprobador de Calidad - Planta: el cambio se aplica al guardar y queda registrado con tu justificación."
        : "El cambio NO se aplica todavía: se envía a Calidad para su aprobación con tu justificación."),
      vacios ? el("p", { class: "nota" }, `Los campos resaltados están vacíos en el registro (${vacios}).`) : null,
      el("div", { class: "campos-3" }, entradas.filter((e) => e.tipoD === "num").map((e) => e.wrap)),
      el("div", { class: "campos-2" }, entradas.filter((e) => e.tipoD !== "num").map((e) => e.wrap)),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Justificación (obligatoria)"), just]),
      btnG,
    ], { ancho: 720 });
    btnG.addEventListener("click", async () => {
      const cambios = entradas
        .map((e) => ({ campo: e.prop, etiqueta: e.label, antes: e.actual ?? null, despues: e.leer() }))
        .filter((c) => !igual(c.antes, c.despues));
      // Si cambia °Bx o acidez, el ratio se recalcula.
      const vB = cambios.find((c) => c.campo === "field_2")?.despues ?? p.field_2;
      const vA = cambios.find((c) => c.campo === "field_4")?.despues ?? p.field_4;
      if (cambios.some((c) => c.campo === "field_2" || c.campo === "field_4")) {
        const r = vB && vA ? Math.round((vB / vA) * 100) / 100 : null;
        if (!igual(r, p.field_8)) cambios.push({ campo: "field_8", etiqueta: "Ratio", antes: p.field_8 ?? null, despues: r });
      }
      if (!cambios.length) return toast("No cambiaste ningún dato", "err");
      if (just.value.trim().length < 10) return toast("Escribe la justificación (al menos una frase)", "err"), just.focus();
      btnG.disabled = true;
      const datos = { modulo: "planta", lista: "registros", item: p, referencia, cambios, justificacion: just.value.trim() };
      try {
        if (aprobador) await st.editarDirecto(datos);
        else await st.solicitarModificacion(datos);
      } catch (e) {
        btnG.disabled = false;
        return toast(e.message, "err");
      }
      h.cerrar();
      toast(aprobador ? "Cambio guardado y registrado" : "Solicitud enviada a Calidad para aprobación");
      await st.subirAhora();
      await cargar();
    });
  }

  // Microbiología (resultado de laboratorio, días después): la muestra es por
  // producto y fecha de fabricación, así que se guarda en todas las paradas de
  // ese producto en ese día, aunque sean de otros lotes.
  async function pintarMicro() {
    clear(micro);
    if (!paradas.some((p) => p.ID)) return;
    const dia = st.diaISO(lote.Fechadeproducci_x00f3_n);
    let regs = [];
    try {
      regs = prod?.Ordenamiento ? await st.registrosMicroGrupo(prod.Ordenamiento, dia) : [];
    } catch {}
    if (!regs.length) regs = paradas.filter((p) => p.ID); // sin código de producto: solo este lote
    const otrosLotes = [...new Set(regs.map((r) => r.Title))].filter((t) => t !== lote.Title);
    const actual = await microActual(regs);
    const f = formMicro(actual);
    const pendiente = actual.aerobios == null && actual.mohos == null;
    const btnM = el("button", { class: "btn btn-sec", type: "button" }, `Guardar en las ${regs.length} paradas`);
    btnM.addEventListener("click", async () => {
      const n = await st.guardarMicroLote(regs, f.valores());
      if (!n) return toast("Ingresa al menos un resultado", "err");
      toast(`Microbiología guardada en ${n} paradas`);
      setTimeout(cargar, 800);
    });
    micro.append(
      el("details", { class: "micro" }, [
        el("summary", {}, `Microbiología · ${prod?.Title || ""} fabricación ${st.fmtDia(dia)} · ${pendiente ? "pendiente de laboratorio" : "registrada"}`),
        otrosLotes.length ? el("p", { class: "nota" }, `Es la misma muestra para los lotes del día: ${[lote.Title, ...otrosLotes].join(", ")}. Se guarda en todos.`) : null,
        f.nodo,
        el("div", { class: "fila-botones" }, btnM),
      ])
    );
  }

  const btn = el("button", { class: "btn btn-verde btn-xl", type: "submit" }, "Guardar parada");
  const form = el("form", { class: "pallet-form", novalidate: "" }, [
    el("div", { class: "fila-sep" }, [nParada, tipo]),
    el("div", { class: "campos-3" }, [brix.wrap, ph.wrap, acidez.wrap]),
    ratioOut,
    el("details", { class: "tara-pallet" }, [el("summary", {}, "Viscosidad / recorrido / % fruta"), el("div", { class: "campos-3" }, [viscosidad.wrap, recorrido.wrap, fruta.wrap])]),
    bloqueCtrl,
    el("div", { class: "campos-2" }, [campoSel("Liberación", liberacion), campoSel("Responsable de liberación", responsable)]),
    bloqueNoLib,
    obs,
    btn,
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { v, ev } = evaluar();
    if (v.brix === null || v.ph === null) return toast("Ingresa al menos °Brix y pH", "err");
    // Se puede registrar primero la medición y completar sensorial/controles
    // después desde la tabla ("Completar"), como trabajaban con la Power App.
    let soloMedicion = false;
    if (!confirma.checked) {
      soloMedicion = await confirmar(
        "¿Guardar solo la medición?",
        "Sensorial y controles (PPRO/PCC) quedarán PENDIENTES en esta parada. Podrás completarlos luego con «Completar» en la tabla de paradas.",
        { si: "Guardar solo medición", no: "Volver y confirmar" }
      );
      if (!soloMedicion) {
        bloqueCtrl.scrollIntoView({ behavior: "smooth", block: "center" });
        bloqueCtrl.classList.add("falta");
        return;
      }
    } else if (!color.value.trim() || !pproD.value || !pproF.value || !pcc1.value || !pcc2.value) return toast("Completa color y los controles PPRO/PCC", "err");
    if (liberacion.value !== "Liberado" && !correcciones.value.trim()) {
      correcciones.focus();
      return toast("Indica la corrección aplicada (parada no liberada)", "err");
    }
    const fuera = Object.entries(ev).filter(([, x]) => x === "bajo" || x === "alto");
    if (fuera.length && liberacion.value === "Liberado") {
      const ok = await confirmar("Fuera de especificación", `${fuera.map(([k, x]) => `${k} ${x}`).join(", ")}, pero la parada se marca "Liberado". ¿Es correcto?`, { si: "Sí, liberar", no: "Revisar" });
      if (!ok) return;
    }
    btn.disabled = true;
    const et = etiquetaActual();
    const { faltan } = await st.registrarParada(lote, prod, {
      ...v,
      ratio: v.ratio ? Math.round(v.ratio * 1e4) / 1e4 : null,
      parada: et.parada,
      repeticion: et.repeticion,
      viscosidad: viscosidad.val(),
      recorrido: recorrido.val(),
      fruta: fruta.val(),
      responsable: responsable.value,
      obs: obs.value.trim(),
      extra: {
        ...(soloMedicion
          ? {}
          : { color: color.value.trim(), olor: olor.value, sabor: sabor.value, pproDesinf: pproD.value, pproFiltrado: pproF.value, pcc1: pcc1.value, pcc2: pcc2.value }),
        liberacion: liberacion.value,
        incidente: liberacion.value === "Liberado" ? "" : incidente.value.trim(),
        correcciones: liberacion.value === "Liberado" ? "" : correcciones.value.trim(),
        numRep: et.numRep,
      },
    });
    btn.disabled = false;
    toast(
      faltan.length
        ? `Parada guardada, pero faltan columnas en SharePoint: ${faltan.join(", ")}`
        : `${et.texto.split(" ·")[0]} registrada${soloMedicion ? " · sensorial y controles pendientes" : ""}`,
      faltan.length ? "err" : "ok"
    );
    for (const c of [brix, ph, acidez, viscosidad, recorrido, fruta]) {
      c.input.value = "";
      pinta(c, null);
    }
    obs.value = "";
    incidente.value = "";
    correcciones.value = "";
    liberacionTocada = false;
    ratioOut.textContent = "";
    await st.subirAhora();
    await cargar();
    await precargar();
    tipo.value = "nueva";
    pintarTipo();
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

  const volverA = `#/planta/${st.diaISO(lote.Fechadeproducci_x00f3_n) || ""}`;
  vista.append(
    el("section", { class: "rec-cab" }, [
      el("a", { href: volverA, class: "volver" }, "← Producción del día"),
      el("div", { class: "rec-titulo" }, [
        el("h1", {}, lote.Title),
        el("span", {}, [prod ? `${prod.Title} · ${prod.field_1} · ` : "", `Elab. ${st.fmtDia(st.diaISO(lote.field_2))} · Cad. ${st.fmtDia(st.diaISO(lote.field_3))}`]),
      ]),
      especif,
      faltanCols.length ? el("div", { class: "aviso" }, `Faltan columnas en la lista Registros: ${faltanCols.join(", ")}. Esos datos no se guardarán hasta crearlas.`) : null,
    ]),
    el("div", { class: "rec-grid" }, [
      el("section", { class: "card" }, [el("h2", {}, "Nueva medición"), form]),
      el("section", { class: "card" }, [
        el("h2", {}, "Paradas del lote"),
        tabla,
        micro,
        el(
          "div",
          { class: "fin-wrap" },
          el(
            "button",
            {
              class: "btn btn-sec",
              onclick: async () => {
                if (await confirmar("Cerrar lote", `${lote.Title} pasa a "Finalizado".`, { si: "Cerrar lote" })) {
                  await st.cerrarLote(lote);
                  toast("Lote cerrado");
                  location.hash = volverA;
                }
              },
            },
            "Cerrar lote"
          )
        ),
      ]),
    ])
  );
  await cargar();
  await precargar();
}
