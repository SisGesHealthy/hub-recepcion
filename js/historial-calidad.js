// Historial de liberaciones de MP para Calidad: qué se liberó o rechazó y lo
// que Bodega recibió de cada orden (kg, pallets, envases, transporte), para
// trazabilidad. Cada fila abre el resumen completo de la recepción.

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, vacio } from "./ui.js";

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
        el("tr", {}, COLS.map((c) => el("th", {}, c[0]))),
        ...visibles.map((f) => {
          const rec = f.recepciones.find((r) => r.Estado === "Finalizada") || f.recepciones[0];
          const tr = el(
            "tr",
            { class: rec ? "clic" : "", title: rec ? "Ver resumen de la recepción" : "", onclick: rec ? () => (location.hash = `#/calidad/ver/${rec.ID}`) : null },
            COLS.map(([nombre, fn, t]) => {
              const v = fn(f);
              const td = el("td", { class: t === "n" ? "num" : "" }, t === "n" ? (v === null || v === undefined || v === "" ? "" : typeof v === "number" ? v.toLocaleString("es-EC", { maximumFractionDigits: 2 }) : String(v)) : String(v ?? ""));
              if (nombre === "Estado") td.className = v === "Liberado" ? "ok" : "fuera";
              if (nombre === "Recepción" && v !== "Recibida") td.className = "aviso-td";
              return td;
            })
          );
          return tr;
        }),
      ])
    );
  };

  async function cargar() {
    clear(resumen);
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
