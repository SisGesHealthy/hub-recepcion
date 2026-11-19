// Calidad: liberación de materia prima por orden de recepción (formato M.ASC.02R04). Reemplaza
// "Órdenes de recepción para liberación" + "Nueva liberación". Un solo paso:
// se abre la orden, se ingresan °Brix/pH/acidez y se libera o rechaza (la
// Power App creaba primero un ítem "En proceso" y lo actualizaba después).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, hoja, campoNum, vacio, confirmar } from "./ui.js";

let timer = null;

export function render(vista, resto = []) {
  clearInterval(timer);
  if (resto[0] === "historial") return import("./historial-calidad.js").then((m) => m.render(vista));
  if (resto[0] === "micro") return pantallaMicro(vista);
  if (resto[0] === "registro") return pantallaRegistro(vista);
  if (resto[0] === "ver" && resto[1])
    return import("./recepciones.js").then((m) => m.detalle(vista, Number(resto[1]), { volver: ["#/calidad/historial", "← Historial de liberaciones"], reenviar: false }));
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando…"));
  const aviso = el("div", { class: "aviso hidden" });
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Liberación de materia prima"), el("p", { class: "sub" }, "Órdenes programadas pendientes de análisis")]),
      el("div", { class: "fila-botones" }, [
        el("a", { class: "btn btn-sec", href: "#/calidad/historial" }, "📋 Historial de liberaciones"),
        el("a", { class: "btn btn-sec", href: "#/calidad/registro" }, "🧾 Registro M.ASC.02R04"),
        el("a", { class: "btn btn-sec", href: "#/calidad/micro" }, "🧫 Micro pendiente"),
        el("button", { class: "btn btn-sec", onclick: () => cargar() }, "↻ Actualizar"),
      ]),
    ]),
    aviso,
    lista
  );

  async function cargar() {
    const { rows, offline } = await st.listarOrdenes();
    aviso.className = offline ? "aviso" : "aviso hidden";
    aviso.textContent = offline ? "Sin conexión: lista de la última descarga." : "";
    // "En Proceso" lo deja la Power App al empezar un análisis que no terminó.
    const pend = rows.filter((o) => o.Estado === "Programada" && (!o.Estado_calidad || o.Estado_calidad === "Pendiente" || o.Estado_calidad === "En Proceso"));
    const hechas = rows.filter((o) => o.Estado === "Programada" && (o.Estado_calidad === "Liberado" || o.Estado_calidad === "Rechazado"));
    const g = st.clasificarOrdenes(pend);
    clear(lista);
    if (!pend.length) vacio(lista, "No hay órdenes pendientes de liberación. ✓");
    const tarjeta = (o) =>
      el("article", { class: "orden" }, [
        el("div", { class: "orden-info" }, [
          el("strong", { class: "orden-prov" }, o.Proveedor?.trim()),
          el("span", { class: "orden-fruta" }, o.Fruta),
          el("span", { class: "orden-fecha" }, `${st.fmtFecha(o.FechaProgramada)} · #${st.idnDe(o)}`),
        ]),
        el("div", { class: "orden-cant" }, [el("b", {}, st.fmtKg(o.CantidadProgramada)), el("small", {}, o.Unidad || "KG")]),
        el("div", { class: "orden-accion" }, el("button", { class: "btn btn-verde", onclick: () => liberar(o, cargar) }, "Iniciar liberación")),
      ]);
    if (g.hoy.length) lista.append(el("h3", { class: "grupo" }, `Hoy · ${g.hoy.length}`), ...g.hoy.map(tarjeta));
    if (g.proximas.length) lista.append(el("h3", { class: "grupo" }, `Próximas · ${g.proximas.length}`), ...g.proximas.map(tarjeta));
    if (g.atrasadas.length)
      lista.append(el("details", { class: "atrasadas" }, [el("summary", {}, `Atrasadas · ${g.atrasadas.length}`), ...g.atrasadas.map(tarjeta)]));
    if (hechas.length)
      lista.append(
        el("details", { class: "atrasadas" }, [
          el("summary", {}, `Ya analizadas, esperando recepción · ${hechas.length}`),
          ...hechas.map((o) =>
            el("div", { class: "fila-mini" }, [
              el("span", {}, `${o.Proveedor?.trim()} · ${o.Fruta}`),
              el("span", { class: `estado ${o.Estado_calidad === "Liberado" ? "estado-verde" : "estado-rojo"}` }, o.Estado_calidad),
            ])
          ),
        ])
      );
  }
  cargar();
  timer = setInterval(() => document.body.contains(lista) && cargar(), 60000);
}

// Formato M.ASC.02R04 en un solo paso:
// 1) inspección al llegar (la hace la analista): seguridad, daños, olor, contaminación + transporte;
// 2) análisis: °Bx/pH/acidez, madurez 1–5, insectos, pudrición;
// 3) observaciones o incidencias; análisis micro opcional (queda pendiente de resultado).
// Insectos/pudrición u otra no conformidad → no se libera directo: liberar CON CONDICIÓN o rechazar.
// Rechazo → ventana "Detalle del rechazo" (solo ahí aparece el detalle).
async function liberar(orden, alTerminar) {
  const inicio = new Date().toISOString();
  const [b0, b1] = CONFIG.rangosMP.brix;
  const [p0, p1] = CONFIG.rangosMP.ph;
  const [a0, a1] = CONFIG.rangosMP.acidez;
  const ratioTxt = el("div", { class: "ratio" });
  const recalc = () => {
    const b = brix.val();
    const a = acidez.val();
    ratioTxt.textContent = b && a ? `Ratio °Brix/acidez: ${(b / a).toFixed(2)}` : "";
  };
  const brix = campoNum("°Brix", { oninput: recalc });
  const ph = campoNum("pH");
  const acidez = campoNum("Acidez", { sufijo: "%", oninput: recalc });
  const obs = el("textarea", { rows: "2", placeholder: "Novedades o condiciones (obligatorio si se libera con condición)" });
  const ref = el("div", { class: "referencia" }, "Buscando análisis anteriores…");

  // Pregunta de dos opciones, sin respuesta por defecto (hay que tocar una).
  const resp = {};
  const pregunta = (clave, texto, [ok, mal], { valOk = false } = {}) => {
    const b1 = el("button", { type: "button", class: "opt" }, ok), b2 = el("button", { type: "button", class: "opt" }, mal);
    const pintar = () => {
      b1.className = "opt" + (resp[clave] === valOk ? " on ok" : "");
      b2.className = "opt" + (resp[clave] === !valOk ? " on mal" : "");
    };
    b1.addEventListener("click", () => ((resp[clave] = valOk), pintar()));
    b2.addEventListener("click", () => ((resp[clave] = !valOk), pintar()));
    pregunta.pintores.push(pintar);
    return el("div", { class: "preg" }, [el("span", {}, texto), el("div", { class: "opts" }, [b1, b2])]);
  };
  pregunta.pintores = [];
  // valOk = valor que significa "todo bien": defectos → No (false); seguridad/transporte → true
  const pDef = (k, t) => pregunta(k, t, ["No", "Sí"], { valOk: false });
  const BIEN = { seguridad: true, danos: false, olor: false, contaminacion: false, plagas: false, transporte: true };
  const todoConforme = el("button", { type: "button", class: "btn btn-sec btn-sm" }, "✓ Todo conforme");
  todoConforme.addEventListener("click", () => { Object.assign(resp, BIEN); pregunta.pintores.forEach((f) => f()); });

  const inspeccion = el("section", { class: "bloque-insp bloque-transporte" }, [
    el("div", { class: "bloque-cab" }, [el("h3", {}, "🚚 1 · Inspección del transporte"), todoConforme]),
    pregunta("seguridad", "Seguridad industrial", ["Cumple", "No cumple"], { valOk: true }),
    pDef("danos", "Daños mecánicos"),
    pDef("olor", "Olor a pesticida"),
    pDef("contaminacion", "Contaminación física"),
    pDef("plagas", "Plagas en el transporte"),
    pregunta("transporte", "Condiciones de transporte", ["OK", "No OK"], { valOk: true }),
  ]);

  // Madurez 1–5
  const madBtns = [1, 2, 3, 4, 5].map((n) => el("button", { type: "button", class: "opt mad" }, String(n)));
  madBtns.forEach((b, i) => b.addEventListener("click", () => { resp.madurez = i + 1; madBtns.forEach((x, j) => (x.className = "opt mad" + (j === i ? " on ok" : ""))); }));

  const responsable = el("select", {}, [el("option", { value: "" }, "— ¿Quién libera? —"), ...CONFIG.responsablesPlanta.map((r) => el("option", { value: r }, r))]);
  st.kvGet?.("ultimoResponsableMP").then?.((v) => { if (v && CONFIG.responsablesPlanta.includes(v)) responsable.value = v; });
  const micro = el("input", { type: "checkbox" });

  const analisis = el("section", { class: "bloque-insp" }, [
    el("div", { class: "bloque-cab" }, [el("h3", {}, "2 · Análisis")]),
    ref,
    el("div", { class: "campos-3" }, [brix.wrap, ph.wrap, acidez.wrap]),
    ratioTxt,
    el("div", { class: "preg" }, [el("span", {}, "Madurez (1–5)"), el("div", { class: "opts" }, madBtns)]),
    pDef("insectos", "Insectos"),
    pDef("pudricion", "Pudrición"),
  ]);

  st.historialFruta(orden).then((rows) => {
    clear(ref);
    if (!rows.length) return ref.append("Sin liberaciones anteriores de esta fruta.");
    const prov = st.norm(orden.Proveedor);
    let soloProv = false;
    const tabla = el("div");
    const pintar = () => {
      const vis = (soloProv ? rows.filter((r) => st.norm(r.proveedor) === prov) : rows).slice(0, 8);
      tabla.replaceChildren(vis.length ? el("table", {}, [el("tr", {}, ["Fecha", "Proveedor", "°Bx", "pH", "Acidez", "Mad.", "Estado"].map((x) => el("th", {}, x)))].concat(
        vis.map((r) => el("tr", { class: st.norm(r.proveedor) === prov ? "mismo-prov" : "", title: r.obs || "" }, [r.fecha, r.proveedor, r.bx ?? "", r.ph ?? "", r.ac ?? "", r.mad ?? "", r.est].map((x) => el("td", {}, String(x)))))
      )) : el("small", {}, "Este proveedor no tiene liberaciones anteriores de esta fruta."));
    };
    const chk = el("input", { type: "checkbox" });
    chk.addEventListener("change", () => ((soloProv = chk.checked), pintar()));
    ref.append(
      el("div", { class: "ref-cab" }, [el("small", {}, `Liberaciones anteriores de esta fruta (${rows.length})`), el("label", { class: "ref-filtro" }, [chk, " Solo este proveedor"])]),
      tabla
    );
    pintar();
  });

  const btnLib = el("button", { class: "btn btn-verde btn-xl" }, "Liberado");
  const btnRech = el("button", { class: "btn btn-rojo btn-xl" }, "Rechazado");
  const h = hoja(`${orden.Proveedor?.trim()} · ${orden.Fruta}`, [
    el("p", { class: "sub" }, `Programada ${st.fmtFecha(orden.FechaProgramada)} · ${st.fmtKg(orden.CantidadProgramada)} ${orden.Unidad || "KG"} · #${st.idnDe(orden)}`),
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Responsable de la liberación"), responsable]),
    inspeccion,
    analisis,
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Observaciones o incidencias"), obs]),
    el("label", { class: "check-micro" }, [micro, el("span", {}, [el("b", {}, "Análisis micro"), " — se tomó muestra; el resultado queda pendiente de cargar"])]),
    el("div", { class: "fila-botones" }, [btnRech, btnLib]),
  ], { ancho: 760 });

  const fuera = (v, lo, hi) => v !== null && (v < lo || v > hi);
  const NOMBRES = { seguridad: "seguridad industrial", danos: "daños mecánicos", olor: "olor a pesticida", contaminacion: "contaminación física", plagas: "plagas en el transporte", transporte: "condiciones de transporte", insectos: "insectos", pudricion: "pudrición" };
  const MAL = { ...BIEN, insectos: false, pudricion: false };

  async function decidir(decision) {
    const v = { brix: brix.val(), ph: ph.val(), acidez: acidez.val(), obs: obs.value.trim(), inicio };
    if (!responsable.value) return toast("Elige quién hace la liberación", "err");
    const faltan = Object.keys(MAL).filter((k) => resp[k] === undefined);
    if (faltan.length) return toast(`Falta responder: ${faltan.map((k) => NOMBRES[k]).join(", ")}`, "err");
    if (!resp.madurez) return toast("Falta la madurez (1–5)", "err");
    if (v.brix === null || v.ph === null) return toast("Ingresa al menos °Brix y pH", "err");
    if (fuera(v.brix, b0, b1) || fuera(v.ph, p0, p1) || fuera(v.acidez, a0, a1)) {
      const ok = await confirmar("Valor fuera de lo habitual", `°Brix ${v.brix} · pH ${v.ph} · acidez ${v.acidez ?? "—"}. ¿Es correcto o es un error de tipeo?`, { si: "Es correcto", no: "Corregir" });
      if (!ok) return;
    }
    const i = { ...resp, micro: micro.checked, responsable: responsable.value, condicionado: false, detalle: null };
    const problemas = Object.keys(MAL).filter((k) => resp[k] !== MAL[k]);
    if (decision === "Liberado" && problemas.length) {
      // Insectos / pudrición (u otra no conformidad): decide la analista.
      const r = await elegir(
        "Hay no conformidades",
        `Se marcó: ${problemas.map((k) => NOMBRES[k]).join(", ")}. ¿Cómo queda la recepción?`,
        [["condicion", "Liberar con condición", "Bodega puede recibir; el motivo va en observaciones"], ["rechazar", "Rechazar", "Bodega solo podrá recibir lo conforme"]]
      );
      if (!r) return;
      if (r === "rechazar") decision = "Rechazado";
      else {
        if (!v.obs) { obs.focus(); return toast("Escribe la condición en observaciones o incidencias", "err"); }
        i.condicionado = true;
      }
    }
    if (decision === "Rechazado") {
      const det = await detalleRechazo(problemas.map((k) => NOMBRES[k]));
      if (det === null) return;
      i.detalle = det;
    }
    btnLib.disabled = btnRech.disabled = true;
    st.kvSet?.("ultimoResponsableMP", responsable.value);
    await st.registrarLiberacion(orden, { ...v, acidez: v.acidez ?? 0, i }, decision);
    h.cerrar();
    toast(
      decision === "Rechazado" ? "Rechazo registrado: Bodega solo podrá recibir la fruta conforme" : i.condicionado ? "Liberado con condición: Bodega ya puede recibir" : "Liberado: Bodega ya puede iniciar la recepción",
      decision === "Liberado" ? "ok" : "err"
    );
    alTerminar();
  }
  btnLib.addEventListener("click", () => decidir("Liberado"));
  btnRech.addEventListener("click", () => decidir("Rechazado"));
}

// Ventana con opciones (devuelve la clave elegida o null).
function elegir(titulo, texto, opciones) {
  return new Promise((res) => {
    let r = null;
    const h = hoja(titulo, [
      el("p", { class: "conf-texto" }, texto),
      ...opciones.map(([k, t, sub]) => el("button", { class: `opcion-grande ${k === "rechazar" ? "rojo" : ""}`, onclick: () => ((r = k), h.cerrar()) }, [el("b", {}, t), el("small", {}, sub)])),
      el("button", { class: "btn btn-sec", onclick: () => h.cerrar() }, "Cancelar"),
    ], { onCerrar: () => res(r) });
  });
}

// Detalle del rechazo: solo existe cuando se rechaza (motivos rápidos + texto).
function detalleRechazo(marcados) {
  const MOTIVOS = ["Pudrición", "Insectos", "Plagas en el transporte", "°Brix fuera de rango", "Madurez inadecuada", "Daños mecánicos", "Contaminación física", "Olor a pesticida"];
  const sel = new Set(MOTIVOS.filter((m) => marcados.some((x) => m.toLowerCase().startsWith(x.slice(0, 6)))));
  const txt = el("textarea", { rows: "3", placeholder: "Detalle del rechazo (qué se encontró, cantidad afectada…)" });
  return new Promise((res) => {
    let r = null;
    const chips = MOTIVOS.map((m) => {
      const b = el("button", { type: "button", class: "chip-motivo" + (sel.has(m) ? " on" : "") }, m);
      b.addEventListener("click", () => { sel.has(m) ? sel.delete(m) : sel.add(m); b.classList.toggle("on"); });
      return b;
    });
    const h = hoja("Detalle del rechazo", [
      el("p", { class: "sub" }, "Calidad rechaza la carga completa. En la recepción, Bodega podrá aceptar solo la fruta conforme."),
      el("div", { class: "chips-motivo" }, chips),
      txt,
      el("div", { class: "fila-botones" }, [
        el("button", { class: "btn btn-sec", onclick: () => h.cerrar() }, "Cancelar"),
        el("button", { class: "btn btn-rojo", onclick: () => {
          const d = [[...sel].join(", "), txt.value.trim()].filter(Boolean).join(" — ");
          if (!d) return toast("Indica al menos un motivo", "err");
          r = d; h.cerrar();
        } }, "Registrar rechazo"),
      ]),
    ], { onCerrar: () => res(r) });
  });
}

// ---------------- microbiología de materia prima ----------------
async function pantallaMicro(vista) {
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Buscando liberaciones con análisis micro…"));
  vista.append(
    el("div", { class: "cab" }, [el("div", {}, [
      el("a", { href: "#/calidad", class: "volver" }, "← Liberación"),
      el("h1", { class: "titulo" }, "Microbiología de materia prima"),
      el("p", { class: "sub" }, "Liberaciones con “Análisis micro” marcado y sin resultado"),
    ])]),
    lista
  );
  async function cargar() {
    let rows;
    try { rows = await st.microPendientesMP(); } catch (e) { return vacio(lista, "No se pudo leer SharePoint: " + e.message); }
    clear(lista);
    if (!rows.length) return vacio(lista, "No hay resultados pendientes. ✓");
    for (const l of rows) {
      lista.append(el("article", { class: "orden" }, [
        el("div", { class: "orden-info" }, [
          el("strong", { class: "orden-prov" }, (l.Proveedor || "").trim()),
          el("span", { class: "orden-fruta" }, l.Fruta),
          el("span", { class: "orden-fecha" }, `${l.Estado === "Rechazado" ? "Rechazado" : "Liberado"} ${st.fmtFecha(l.HoraCierre || l.Created)} · #${l.ID_1} · ${l.Responsable || l.Operario || ""}`),
        ]),
        el("div", { class: "orden-accion" }, el("button", { class: "btn btn-azul", onclick: () => cargarResultado(l, cargar) }, "Cargar resultado")),
      ]));
    }
  }
  cargar();
}
function cargarResultado(l, alTerminar) {
  const aer = campoNum("Aerobios"), moh = campoNum("Mohos y levaduras"), col = campoNum("Coliformes"), eco = campoNum("E. coli");
  const sal = el("input", { type: "text", placeholder: "Ej. Ausencia" });
  const h = hoja(`${(l.Proveedor || "").trim()} · ${l.Fruta}`, [
    el("div", { class: "campos-3" }, [aer.wrap, moh.wrap, col.wrap, eco.wrap, el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Salmonella"), sal])]),
    el("button", { class: "btn btn-verde btn-xl", onclick: async () => {
      const v = { aerobios: aer.val(), mohos: moh.val(), coliformes: col.val(), ecoli: eco.val(), salmonella: sal.value.trim() };
      if (Object.values(v).every((x) => x === null || x === "")) return toast("Ingresa al menos un resultado", "err");
      await st.cargarMicroMP(l, v); h.cerrar(); toast("Resultado de microbiología guardado"); alTerminar();
    } }, "Guardar resultado"),
  ]);
}

// ---------------- registro M.ASC.02R04 (sin digitar dos veces) ----------------
async function pantallaRegistro(vista) {
  const dias = el("select", { class: "dias" }, [["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["90", "Últimos 90 días"]].map(([v, t]) => el("option", { value: v, ...(v === "30" ? { selected: "" } : {}) }, t)));
  const cont = el("div", { class: "tabla-scroll" }, el("div", { class: "cargando" }, "Armando el registro…"));
  let filas = [];
  const copiar = (sep) => {
    if (!filas.length) return;
    const cols = Object.keys(filas[0]);
    const esc = (v) => { const t = typeof v === "number" ? String(v).replace(".", sep === "\t" ? "," : ".") : String(v ?? ""); return sep === "," && /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t.replace(/\t|\n/g, " "); };
    const txt = [cols.join(sep), ...filas.map((f) => cols.map((c) => esc(f[c])).join(sep))].join("\n");
    navigator.clipboard.writeText(txt).then(() => toast(sep === "\t" ? "Copiado: pégalo en el Excel M.ASC.02R04" : "Copiado en CSV"));
  };
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("a", { href: "#/calidad", class: "volver" }, "← Liberación"), el("h1", { class: "titulo" }, "Registro de recepción de fruta · M.ASC.02R04"), el("p", { class: "sub" }, "Se arma solo con la liberación de Calidad y el cierre de Bodega")]),
      el("div", { class: "fila-botones" }, [dias, el("button", { class: "btn btn-sec", onclick: () => copiar("\t") }, "Copiar para Excel"), el("button", { class: "btn btn-sec", onclick: () => copiar(",") }, "Copiar CSV")]),
    ]),
    cont
  );
  async function cargar() {
    cont.replaceChildren(el("div", { class: "cargando" }, "Armando el registro…"));
    try { filas = await st.registroRecepcionMP(Number(dias.value)); } catch (e) { return vacio(cont, "No se pudo leer SharePoint: " + e.message); }
    if (!filas.length) return vacio(cont, "Sin liberaciones en ese período.");
    const cols = Object.keys(filas[0]);
    cont.replaceChildren(el("table", { class: "tabla-registro" }, [
      el("thead", {}, el("tr", {}, cols.map((c) => el("th", { class: /TRANSPORTE/.test(c) ? "th-transporte" : "" }, c)))),
      el("tbody", {}, filas.map((f) => el("tr", { class: /RECHAZ/.test(f["ESTATUS RECIBIDO"]) ? "fila-rech" : /CONDICI/.test(f["ESTATUS RECIBIDO"]) ? "fila-cond" : "" }, cols.map((c) => el("td", {}, String(f[c] ?? "")))))),
    ]));
  }
  dias.addEventListener("change", cargar);
  cargar();
}
