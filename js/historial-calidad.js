// Historial de liberaciones de MP para Calidad: qué se liberó o rechazó y lo
// que Bodega recibió de cada orden (kg, pallets, envases, transporte), para
// trazabilidad. Cada fila abre el resumen completo de la recepción.

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { CONFIG } from "./config.js";
import { toast, vacio, hoja, campoNum } from "./ui.js";
import { btnSolicitudes } from "./solicitudes.js";

const COLS = [
  ["Fecha liberación", (f) => st.fmtFecha(f.lib.HoraCierre || f.lib.Created)],
  ["Orden", (f) => f.lib.ID_1],
  ["Proveedor", (f) => (f.lib.Proveedor || "").trim()],
  ["Fruta", (f) => f.lib.Fruta],
  ["Estado", (f) => f.lib.Estado],
  ["°Brix", (f) => f.lib.OData__x00b0_Brix, "n"],
  ["pH", (f) => f.lib.PH, "n"],
  ["Acidez %", (f) => f.lib.Acidez, "n"],
  ["Ratio", (f) => (f.lib.OData__x00b0_Brix && f.lib.Acidez ? Math.round((f.lib.OData__x00b0_Brix / f.lib.Acidez) * 100) / 100 : null), "n"],
  ["Analista", (f) => f.lib.Operario],
  ["Kg programados", (f) => f.orden?.CantidadProgramada ?? null, "n"],
  ["Recepción", (f) => f.estadoRecepcion],
  ["Llegada", (f) => st.fmtFecha(f.llegada)],
  ["Kg neto recibido", (f) => f.netoRecibido, "n"],
  ["Kg bruto", (f) => (f.pallets ? Math.round(f.bruto * 100) / 100 : null), "n"],
  ["Pallets", (f) => (f.recepciones.length ? f.pallets : null), "n"],
  ["Envases", (f) => (f.recepciones.length ? f.envases : null), "n"],
  ["Peso envase kg", (f) => f.pesoEnvase],
  ["Bodeguero", (f) => f.bodeguero],
  ["Conductor", (f) => f.conductor],
  ["Placa", (f) => f.placa],
  ["Observaciones", (f) => f.lib.Observaciones || ""],
];

export async function render(vista) {
  const dias = el("select", { class: "dias", id: "hist-dias" }, [["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["90", "Últimos 90 días"]].map(([v, t]) => el("option", { value: v, ...(v === "30" ? { selected: "" } : {}) }, t)));
  const estado = el("select", { class: "dias", id: "hist-estado" }, [["", "Liberadas y rechazadas"], ["Liberado", "Solo liberadas"], ["Rechazado", "Solo rechazadas"]].map(([v, t]) => el("option", { value: v }, t)));
  const buscar = el("input", { type: "search", id: "hist-buscar", class: "obs buscar", placeholder: "Buscar proveedor, fruta, orden o placa…" });
  const resumen = el("div", { class: "hist-resumen" });
  const cont = el("div", { class: "reporte-wrap" });
  let filas = [];
  let visibles = [];

  const texto = (sep) => {
    const cel = (c, t) => {
      const v = c ?? "";
      if (t === "n") return v === "" || isNaN(v) ? "" : String(v).replace(".", ",");
      return String(v).replace(/[\t\r\n;]+/g, " ").trim();
    };
    return [COLS.map((c) => c[0]).join(sep), ...visibles.map((f) => COLS.map(([, fn, t]) => cel(fn(f), t)).join(sep))].join("\r\n");
  };
  const copiar = async () => {
    if (!visibles.length) return toast("No hay filas para copiar", "err");
    const txt = texto("\t");
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const t = el("textarea", {}, txt);
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    toast(`${visibles.length} filas copiadas con encabezados: pega en Excel (Ctrl+V)`);
  };
  const descargar = () => {
    if (!visibles.length) return toast("No hay filas", "err");
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + texto(";")], { type: "text/csv;charset=utf-8" })), download: `Historial_liberaciones_MP_${st.hoyISO()}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: "#/calidad", class: "volver" }, "← Órdenes pendientes"),
        el("h1", { class: "titulo" }, "Historial de liberaciones"),
        el("p", { class: "sub" }, "Lo que Calidad analizó y lo que Bodega recibió de cada orden"),
      ]),
      el("div", { class: "cab-botones" }, btnSolicitudes("calidad", "#/calidad/solicitudes")),
    ]),
    el("div", { class: "filtros-reporte" }, [
      dias,
      estado,
      el("button", { class: "btn btn-verde", onclick: copiar }, "📋 Copiar para Excel"),
      el("button", { class: "btn btn-sec", onclick: descargar }, "⬇ Excel (CSV)"),
    ]),
    buscar,
    resumen,
    cont
  );

  const pintar = () => {
    const q = st.norm(buscar.value);
    visibles = filas.filter(
      (f) => (!estado.value || f.lib.Estado === estado.value) && (!q || st.norm(`${f.lib.Proveedor} ${f.lib.Fruta} ${f.lib.ID_1} ${f.placa} ${f.lib.Operario}`).includes(q))
    );
    const lib = visibles.filter((f) => f.lib.Estado === "Liberado");
    const rech = visibles.filter((f) => f.lib.Estado === "Rechazado");
    const recibidas = lib.filter((f) => f.estadoRecepcion === "Recibida");
    const kg = recibidas.reduce((s, f) => s + (f.netoRecibido || 0), 0);
    const env = lib.reduce((s, f) => s + (f.envases || 0), 0);
    const porFruta = {};
    for (const f of recibidas) porFruta[f.lib.Fruta] = (porFruta[f.lib.Fruta] || 0) + (f.netoRecibido || 0);
    clear(resumen);
    resumen.append(
      el("div", { class: "hist-kpis" }, [
        kpi(String(lib.length), "liberadas"),
        kpi(String(rech.length), "rechazadas", rech.length ? "rojo" : ""),
        kpi(String(lib.length - recibidas.length), "liberadas sin cerrar en Bodega", lib.length - recibidas.length ? "ambar" : ""),
        kpi(`${st.fmtKg(kg)} kg`, "neto recibido de lo liberado"),
        kpi(String(env), "envases recibidos"),
      ]),
      Object.keys(porFruta).length
        ? el(
            "div",
            { class: "chips" },
            Object.entries(porFruta)
              .sort((a, b) => b[1] - a[1])
              .map(([fr, k]) => el("span", { class: "estado estado-verde" }, `${fr}: ${st.fmtKg(k)} kg`))
          )
        : null
    );
    clear(cont);
    if (!visibles.length) return vacio(cont, "No hay liberaciones en ese período.");
    cont.appendChild(
      el("table", { class: "doc-tabla reporte hist-tabla" }, [
        el("tr", {}, [...COLS.map((c) => el("th", {}, c[0])), el("th", {}, "Cambios")]),
        ...visibles.map((f) => {
          const rec = f.recepciones.find((r) => r.Estado === "Finalizada") || f.recepciones[0];
          const tr = el(
            "tr",
            { class: rec ? "clic" : "", title: rec ? "Ver resumen de la recepción" : "", onclick: rec ? () => (location.hash = `#/calidad/ver/${rec.ID}`) : null },
            [
              ...COLS.map(([nombre, fn, t]) => {
                const v = fn(f);
                const td = el("td", { class: t === "n" ? "num" : "" }, t === "n" ? (v === null || v === undefined || v === "" ? "" : typeof v === "number" ? v.toLocaleString("es-EC", { maximumFractionDigits: 2 }) : String(v)) : String(v ?? ""));
                if (nombre === "Estado") td.className = v === "Liberado" ? "ok" : "fuera";
                if (nombre === "Recepción" && v !== "Recibida") td.className = "aviso-td";
                return td;
              }),
              el("td", { onclick: (e) => e.stopPropagation() }, botonCambio(f.lib)),
            ]
          );
          return tr;
        }),
      ])
    );
  };

  // Solicitudes pendientes por liberación (ID → solicitud).
  let solPend = new Map();
  const botonCambio = (lib) => {
    if (solPend.has(lib.ID)) return el("a", { class: "btn btn-sec btn-mini", href: "#/calidad/solicitudes", title: solPend.get(lib.ID).Resumen || "" }, "⏳ Pendiente");
    return el("button", { class: "btn btn-sec btn-mini", onclick: () => modificarLiberacion(lib, cargar) }, st.esAprobador("calidad") ? "✎ Editar" : "Solicitar cambio");
  };

  async function cargar() {
    clear(resumen);
    solPend = new Map((await st.solicitudesPendientes("calidad").catch(() => [])).filter((x) => x.Lista === "liberaciones").map((x) => [x.ItemID, x]));
    cont.replaceChildren(el("div", { class: "cargando" }, "Cruzando liberaciones con recepciones…"));
    try {
      filas = await st.historialLiberaciones(Number(dias.value));
    } catch (e) {
      filas = [];
      return vacio(cont, "No se pudo leer SharePoint: " + e.message);
    }
    pintar();
  }
  buscar.addEventListener("input", pintar);
  estado.addEventListener("change", pintar);
  dias.addEventListener("change", cargar);
  cargar();
}

function kpi(valor, texto, tono = "") {
  return el("div", { class: `hist-kpi ${tono}` }, [el("b", {}, valor), el("span", {}, texto)]);
}

// Cambiar una liberación ya guardada: misma lógica que Calidad - Planta. Quien
// no es aprobador de "Calidad (MP)" envía una solicitud con justificación; el
// aprobador edita directo y queda la constancia (SolicitudesModificacion).
async function modificarLiberacion(lib, alTerminar) {
  const aprobador = st.esAprobador("calidad");
  const SN = ["Sí", "No"];
  const referencia = `Liberación #${lib.ID_1} · ${(lib.Proveedor || "").trim()} · ${lib.Fruta || ""} · ${st.fmtFecha(lib.HoraCierre || lib.Created)}`;
  // [etiqueta, propiedad, tipo (num | txt | area | opciones), valor actual]
  const defs = [
    ["Estado", "Estado", ["Liberado", "Rechazado"], lib.Estado],
    ["Liberado con condición", "Condicionado", SN, lib.Condicionado],
    ["°Brix", "OData__x00b0_Brix", "num", lib.OData__x00b0_Brix],
    ["pH", "PH", "num", lib.PH],
    ["Acidez", "Acidez", "num", lib.Acidez],
    ["Madurez (1-5)", "Madurez", "num", lib.Madurez],
    ["Responsable", "Responsable", "txt", lib.Responsable],
    ["Seguridad industrial", "SeguridadIndustrial", ["Cumple", "No cumple"], lib.SeguridadIndustrial],
    ["Condiciones de transporte", "CondicionesTransporte", ["OK", "No OK"], lib.CondicionesTransporte],
    ["Insectos", "Insectos", SN, lib.Insectos],
    ["Pudrición", "Pudricion", SN, lib.Pudricion],
    ["Daños mecánicos", "DanosMecanicos", SN, lib.DanosMecanicos],
    ["Olor a pesticida", "OlorPesticida", SN, lib.OlorPesticida],
    ["Contaminación física", "ContaminacionFisica", SN, lib.ContaminacionFisica],
    ["Plagas en el transporte", "PlagasTransporte", SN, lib.PlagasTransporte],
    ["Análisis micro", "AnalisisMicro", SN, lib.AnalisisMicro],
    ["Aerobios", "MicroAerobios", "num", lib.MicroAerobios],
    ["Mohos y levaduras", "MicroMohosLevaduras", "num", lib.MicroMohosLevaduras],
    ["Coliformes", "MicroColiformes", "num", lib.MicroColiformes],
    ["E. coli", "MicroEColi", "num", lib.MicroEColi],
    ["Salmonella", "MicroSalmonella", "txt", lib.MicroSalmonella],
    ["Detalle del rechazo", "DetalleRechazo", "area", lib.DetalleRechazo],
    ["Observaciones", "Observaciones", "area", lib.Observaciones],
  ];
  const entradas = defs.map(([label, prop, tipo, actual]) => {
    if (tipo === "num") {
      const c = campoNum(label, { valor: actual ?? "" });
      return { label, prop, tipo, actual, wrap: c.wrap, leer: () => c.val() };
    }
    let x;
    if (Array.isArray(tipo)) {
      x = el("select", {}, [el("option", { value: "" }, "—"), ...tipo.map((o) => el("option", { value: o }, o))]);
      x.value = actual ?? "";
    } else if (tipo === "area") x = el("textarea", { rows: "2" }, actual ?? "");
    else x = el("input", { type: "text", value: actual ?? "" });
    const vacio = actual === null || actual === undefined || actual === "";
    return { label, prop, tipo, actual, wrap: el("label", { class: `campo ${vacio ? "campo-vacio" : ""}` }, [el("span", { class: "campo-label" }, label), x]), leer: () => (x.value.trim() === "" ? null : x.value.trim()) };
  });
  const igual = (a, b) => (a ?? null) === (b ?? null) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);
  const just = el("textarea", { rows: "3", placeholder: "¿Por qué se cambia? (ej. se registró el pH de otra orden)" });
  const btn = el("button", { class: "btn btn-verde btn-xl" }, aprobador ? "Guardar cambio" : "Enviar solicitud");
  const h = hoja(aprobador ? "Editar liberación" : "Solicitar cambio de liberación", [
    el("p", { class: "sub" }, referencia),
    el("p", { class: "nota" }, aprobador
      ? "Eres aprobador de Calidad (MP): el cambio se aplica al guardar y queda registrado con tu justificación."
      : "El cambio NO se aplica todavía: se envía para aprobación con tu justificación."),
    el("div", { class: "campos-3" }, entradas.filter((e) => e.tipo === "num").map((e) => e.wrap)),
    el("div", { class: "campos-2" }, entradas.filter((e) => e.tipo !== "num").map((e) => e.wrap)),
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Justificación (obligatoria)"), just]),
    btn,
  ], { ancho: 760 });
  btn.addEventListener("click", async () => {
    const cambios = entradas
      .map((e) => ({ campo: e.prop, etiqueta: e.label, antes: e.actual ?? null, despues: e.leer(), ...(e.prop === "Estado" ? { idn: lib.ID_1 } : {}) }))
      .filter((c) => !igual(c.antes, c.despues));
    if (!cambios.length) return toast("No cambiaste ningún dato", "err");
    if (cambios.some((c) => c.campo === "Estado" && !c.despues)) return toast("El estado no puede quedar vacío", "err");
    if (just.value.trim().length < 10) return toast("Escribe la justificación (al menos una frase)", "err"), just.focus();
    btn.disabled = true;
    const datos = { modulo: "calidad", lista: "liberaciones", item: lib, referencia, cambios, justificacion: just.value.trim() };
    try {
      if (aprobador) await st.editarDirecto(datos);
      else await st.solicitarModificacion(datos);
    } catch (e) {
      btn.disabled = false;
      return toast(e.message, "err");
    }
    h.cerrar();
    toast(aprobador ? "Cambio guardado y registrado" : "Solicitud enviada para aprobación");
    await st.subirAhora();
    alTerminar?.();
  });
}
