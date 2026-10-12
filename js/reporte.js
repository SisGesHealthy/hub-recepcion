// Reporte de liberaciones con las MISMAS 43 columnas (A…AQ) del Excel
// "MODELO LIBERACIONES 2026" del sistema de gestión: mientras se formaliza la
// transición, Calidad copia de aquí y pega en su Excel sin mover nada.

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, vacio } from "./ui.js";

export async function render(vista) {
  const hoy = st.hoyISO();
  const desde = el("input", { type: "date", class: "dias", value: hoy });
  const hasta = el("input", { type: "date", class: "dias", value: hoy });
  const decimal = el("select", { class: "dias", title: "Separador decimal al copiar" }, [el("option", { value: "," }, "Decimales con coma"), el("option", { value: "." }, "Decimales con punto")]);
  const estado = el("p", { class: "sub" });
  const cont = el("div", { class: "reporte-wrap" });
  let filas = [];

  const copiar = async (encabezados) => {
    if (!filas.length) return toast("No hay filas para copiar", "err");
    const txt = st.filasATexto(filas, { encabezados, decimal: decimal.value });
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const t = el("textarea", {}, txt);
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    toast(`${filas.length} filas copiadas: pega en la celda A de la primera fila libre (Ctrl+V)`);
  };
  const descargar = () => {
    if (!filas.length) return toast("No hay filas", "err");
    // CSV con ";" y coma decimal: así lo abre Excel en español sin asistente.
    const txt = st.filasATexto(filas, { encabezados: true, decimal: "," }).replace(/\t/g, ";");
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + txt], { type: "text/csv;charset=utf-8" })), download: `Liberaciones_${desde.value}_${hasta.value}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: `#/planta/${hoy}`, class: "volver" }, "← Producción del día"),
        el("h1", { class: "titulo" }, "Reporte de liberaciones"),
        el("p", { class: "sub" }, "Mismas columnas que MODELO LIBERACIONES 2026 (A a AQ), por fecha de producción"),
      ]),
    ]),
    el("div", { class: "filtros-reporte" }, [
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Desde"), desde]),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Hasta"), hasta]),
      el("button", { class: "btn btn-azul", onclick: () => cargar() }, "Ver"),
      decimal,
      el("button", { class: "btn btn-verde", onclick: () => copiar(false) }, "📋 Copiar filas"),
      el("button", { class: "btn btn-sec", onclick: () => copiar(true) }, "Copiar con encabezados"),
      el("button", { class: "btn btn-sec", onclick: descargar }, "⬇ Excel (CSV)"),
    ]),
    estado,
    cont
  );

  async function cargar() {
    if (desde.value > hasta.value) return toast("La fecha 'desde' es posterior a 'hasta'", "err");
    clear(cont);
    cont.appendChild(el("div", { class: "cargando" }, "Armando el reporte…"));
    try {
      filas = await st.reporteLiberaciones(desde.value, hasta.value);
    } catch (e) {
      filas = [];
      return vacio(cont, "No se pudo leer SharePoint: " + e.message);
    }
    estado.textContent = `${filas.length} fila${filas.length === 1 ? "" : "s"} (una por parada) · del ${st.fmtDia(desde.value)} al ${st.fmtDia(hasta.value)}`;
    clear(cont);
    if (!filas.length) return vacio(cont, "No hay paradas registradas en esas fechas.");
    const letras = st.COLUMNAS_EXCEL.map((_, i) => (i < 26 ? String.fromCharCode(65 + i) : "A" + String.fromCharCode(65 + i - 26)));
    const fmt = (c) => (c.t === "n" ? (c.v === null || isNaN(c.v) ? "" : String(c.v).replace(".", decimal.value)) : c.t === "d" ? st.fmtDia(c.v) : c.v);
    cont.appendChild(
      el("table", { class: "doc-tabla reporte" }, [
        el("tr", {}, letras.map((l) => el("th", { class: "letra" }, l))),
        el("tr", {}, st.COLUMNAS_EXCEL.map((h) => el("th", {}, h.trim()))),
        ...filas.map((f) =>
          el(
            "tr",
            {},
            f.map((c, i) => el("td", { class: (i === 10 && c.v === "ALERTA") || (i === 38 && c.v && c.v !== "Liberado") ? "fuera" : "" }, fmt(c)))
          )
        ),
      ])
    );
  }
  decimal.addEventListener("change", () => filas.length && cargar());
  cargar();
}
