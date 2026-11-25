// Registros del Sistema de Gestión para CONSULTA (sin editar), con la
// comodidad de una hoja de Excel: rango de fechas, búsqueda, filtro por
// columna (texto o >, <, >=, <= en números), ordenar con un clic en el
// encabezado, totales y copiar/descargar lo que se ve.
//   M.ASC.02R04 · Registro de recepción de fruta (Calidad MP + Bodega)
//   M.ASC.02R05 · Registro de liberación de producto (Calidad - Planta)

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, vacio, hoja } from "./ui.js";

const REGISTROS = {
  r04: { codigo: "M.ASC.02R04", titulo: "Registro de recepción de fruta", sub: "Por fecha de liberación de Calidad MP" },
  r05: { codigo: "M.ASC.02R05", titulo: "Registro de liberación de producto", sub: "Por fecha de producción (una fila por parada)" },
};

// Tipos de las columnas del R04 (las demás son texto).
const TIPOS_R04 = { R: "n", Fecha: "d", "Cantidad en Kg": "n", "ºbx": "n", pH: "n", Acidez: "n", "ºmadurez": "n" };
const SUMA_R04 = new Set(["Cantidad en Kg"]);

const isoDeDMY = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || "");
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const dmy = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const num = (v) => (v === null || v === undefined || v === "" || isNaN(v) ? "" : Number(v).toLocaleString("es-EC", { maximumFractionDigits: 3 }));

async function cargarDatos(id, desde, hasta) {
  if (id === "r04") {
    const filas = await st.registroRecepcionMP(desde, hasta);
    if (!filas.length) return { cols: [], rows: [] };
    const claves = Object.keys(filas[0]);
    const cols = claves.map((k) => ({ label: k, tipo: TIPOS_R04[k] || "t", suma: SUMA_R04.has(k) }));
    const rows = filas.map((f) =>
      claves.map((k) => {
        const t = TIPOS_R04[k] || "t";
        const v = f[k];
        if (t === "n") return v === "" || v === null || v === undefined ? null : Number(v);
        if (t === "d") return isoDeDMY(v);
        return v === null || v === undefined ? "" : String(v);
      })
    );
    return { cols, rows };
  }
  const filas = await st.reporteLiberaciones(desde, hasta);
  const cols = st.COLUMNAS_EXCEL.map((h, i) => ({ label: h.trim(), tipo: filas[0]?.[i]?.t === "n" ? "n" : filas[0]?.[i]?.t === "d" ? "d" : "t", suma: /CANTIDAD/i.test(h) }));
  // Columnas que el Excel tiene vacías (sistema anterior / sin uso) se ocultan.
  const vacias = new Set(["CODIGO SISTEMA", "NOMBRE SISTEMA", "Columna8", "VISCOSIDAD 5", "RECORRIDO 6", "% FRUTA7"]);
  const idx = cols.map((c, i) => i).filter((i) => !vacias.has(cols[i].label));
  return { cols: idx.map((i) => cols[i]), rows: filas.map((f) => idx.map((i) => (f[i].t === "n" ? f[i].v : f[i].v ?? ""))) };
}

export async function render(vista, resto = []) {
  const id = REGISTROS[resto[0]] ? resto[0] : "r04";
  const reg = REGISTROS[id];
  const hoy = st.hoyISO();
  const inicioMes = hoy.slice(0, 8) + "01";
  const desde = el("input", { type: "date", class: "dias", value: inicioMes });
  const hasta = el("input", { type: "date", class: "dias", value: hoy });
  const rangos = {
    mes: () => [inicioMes, hoy],
    anterior: () => {
      const fin = st.sumarDias(inicioMes, -1);
      return [fin.slice(0, 8) + "01", fin];
    },
    d90: () => [st.sumarDias(hoy, -89), hoy],
    anio: () => [hoy.slice(0, 5) + "01-01", hoy],
  };
  const rango = el("select", { class: "dias" }, [["mes", "Este mes"], ["anterior", "Mes anterior"], ["d90", "Últimos 90 días"], ["anio", "Este año"], ["", "Personalizado"]].map(([v, t]) => el("option", { value: v }, t)));
  const buscar = el("input", { type: "search", class: "obs buscar", placeholder: "Buscar en todas las columnas…" });
  const info = el("span", { class: "grilla-info" });
  const cont = el("div", { class: "grilla-wrap" });

  let cols = [];
  let rows = [];
  let visibles = [];
  // filtros[i] = { txt, sel: Set de valores marcados | null, desde, hasta }
  let filtros = {};
  const activo = (f) => !!(f && (f.txt || f.sel || f.desde || f.hasta));
  let orden = { i: null, dir: 1 };

  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("h1", { class: "titulo" }, `${reg.codigo} · ${reg.titulo}`),
        el("p", { class: "sub" }, `${reg.sub} · solo consulta`),
      ]),
      el("div", { class: "cab-botones" }, Object.entries(REGISTROS).map(([k, r]) => el("a", { class: `btn ${k === id ? "btn-azul" : "btn-sec"}`, href: `#/registros/${k}` }, r.codigo))),
    ]),
    el("div", { class: "filtros-reporte" }, [
      rango,
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Desde"), desde]),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Hasta"), hasta]),
      el("button", { class: "btn btn-azul", onclick: () => cargar() }, "Ver"),
      el("button", { class: "btn btn-sec", onclick: () => ((filtros = {}), (buscar.value = ""), (orden = { i: null, dir: 1 }), pintar()) }, "Quitar filtros"),
      el("button", { class: "btn btn-verde", onclick: () => copiar(false) }, "📋 Copiar lo visible"),
      el("button", { class: "btn btn-sec", onclick: () => copiar(true) }, "Copiar con encabezados"),
      el("button", { class: "btn btn-sec", onclick: descargar }, "⬇ Excel (CSV)"),
    ]),
    el("div", { class: "grilla-barra" }, [buscar, info]),
    cont
  );

  rango.addEventListener("change", () => {
    if (!rango.value) return;
    [desde.value, hasta.value] = rangos[rango.value]();
    cargar();
  });
  for (const x of [desde, hasta]) x.addEventListener("change", () => (rango.value = ""));
  let t = 0;
  buscar.addEventListener("input", () => (clearTimeout(t), (t = setTimeout(pintar, 200))));

  const texto = (c, v) => (c.tipo === "n" ? num(v) : c.tipo === "d" ? dmy(v) : String(v ?? ""));
  const sinValor = (v) => v === null || v === undefined || v === "";
  // Filtro de una columna: valores marcados (como el filtro de Excel), rango
  // desde/hasta en fechas y números, y la casilla de texto: "contiene", o en
  // números >, <, >=, <=, =.
  const pasa = (c, v, f) => {
    if (!activo(f)) return true;
    if (f.sel && !f.sel.has(texto(c, v) || "(vacío)")) return false;
    if (f.desde !== undefined && f.desde !== "" && (sinValor(v) || v < f.desde)) return false;
    if (f.hasta !== undefined && f.hasta !== "" && (sinValor(v) || v > f.hasta)) return false;
    if (!f.txt) return true;
    const m = c.tipo === "n" && /^\s*(>=|<=|>|<|=)\s*(-?[\d.,]+)\s*$/.exec(f.txt);
    if (m) {
      if (sinValor(v)) return false;
      const n = Number(m[2].replace(",", "."));
      return { ">": v > n, "<": v < n, ">=": v >= n, "<=": v <= n, "=": v === n }[m[1]];
    }
    return st.norm(texto(c, v)).includes(st.norm(f.txt));
  };

  // Panel de filtro de una columna: desde/hasta + lista de valores con casillas.
  function panelFiltro(i) {
    const c = cols[i];
    const f = { ...(filtros[i] || {}) };
    // Valores posibles según los OTROS filtros (como Excel).
    const base = rows.filter((r) => cols.every((cc, j) => j === i || pasa(cc, r[j], filtros[j])));
    const cuenta = new Map();
    for (const r of base) {
      const k = texto(c, r[i]) || "(vacío)";
      cuenta.set(k, (cuenta.get(k) || 0) + 1);
    }
    const valorDe = new Map(base.map((r) => [texto(c, r[i]) || "(vacío)", r[i]]));
    const claves = [...cuenta.keys()].sort((a, b) => {
      const va = valorDe.get(a), vb = valorDe.get(b);
      if (a === "(vacío)") return 1;
      if (b === "(vacío)") return -1;
      return c.tipo === "n" ? va - vb : String(va).localeCompare(String(vb), "es", { numeric: true });
    });
    const marcados = new Set(f.sel || claves);
    const tipoInput = c.tipo === "d" ? "date" : c.tipo === "n" ? "number" : null;
    const desdeI = tipoInput ? el("input", { type: tipoInput, step: "any", value: f.desde ?? "" }) : null;
    const hastaI = tipoInput ? el("input", { type: tipoInput, step: "any", value: f.hasta ?? "" }) : null;
    const busca = el("input", { type: "search", class: "obs", placeholder: "Buscar valor…" });
    const lista = el("div", { class: "filtro-lista" });
    const pintarLista = () => {
      clear(lista);
      const q = st.norm(busca.value);
      for (const k of claves) {
        if (q && !st.norm(k).includes(q)) continue;
        const ck = el("input", { type: "checkbox", ...(marcados.has(k) ? { checked: "" } : {}) });
        ck.addEventListener("change", () => (ck.checked ? marcados.add(k) : marcados.delete(k)));
        lista.appendChild(el("label", { class: "filtro-op" }, [ck, el("span", {}, k), el("small", {}, String(cuenta.get(k)))]));
      }
    };
    busca.addEventListener("input", pintarLista);
    pintarLista();
    const todos = (on) => {
      const q = st.norm(busca.value);
      for (const k of claves) if (!q || st.norm(k).includes(q)) on ? marcados.add(k) : marcados.delete(k);
      pintarLista();
    };
    const aplicar = el("button", { class: "btn btn-verde" }, "Aplicar");
    const h = hoja(`Filtro · ${c.label}`, [
      tipoInput
        ? el("div", { class: "campos-2" }, [
            el("label", { class: "campo" }, [el("span", { class: "campo-label" }, c.tipo === "d" ? "Desde la fecha" : "Desde (mínimo)"), desdeI]),
            el("label", { class: "campo" }, [el("span", { class: "campo-label" }, c.tipo === "d" ? "Hasta la fecha" : "Hasta (máximo)"), hastaI]),
          ])
        : null,
      busca,
      el("div", { class: "fila-botones izq" }, [
        el("button", { class: "btn btn-sec btn-mini", onclick: () => todos(true) }, "Marcar todos"),
        el("button", { class: "btn btn-sec btn-mini", onclick: () => todos(false) }, "Desmarcar todos"),
      ]),
      lista,
      el("div", { class: "fila-botones" }, [
        el("button", { class: "btn btn-sec", onclick: () => (delete filtros[i], h.cerrar(), pintar()) }, "Limpiar filtro"),
        aplicar,
      ]),
    ]);
    aplicar.addEventListener("click", () => {
      const nuevo = { txt: f.txt || "" };
      if (marcados.size < claves.length) nuevo.sel = new Set(marcados);
      if (tipoInput) {
        const lee = (x) => (x.value === "" ? "" : c.tipo === "n" ? Number(x.value) : x.value);
        nuevo.desde = lee(desdeI);
        nuevo.hasta = lee(hastaI);
      }
      filtros[i] = nuevo;
      h.cerrar();
      pintar();
    });
  }

  function calcular() {
    const q = st.norm(buscar.value.trim());
    visibles = rows.filter((r) => cols.every((c, i) => pasa(c, r[i], filtros[i])) && (!q || st.norm(r.map((v, i) => texto(cols[i], v)).join(" ")).includes(q)));
    if (orden.i !== null) {
      const i = orden.i;
      const vacio = (v) => v === null || v === undefined || v === "";
      visibles.sort((a, b) => {
        if (vacio(a[i]) && vacio(b[i])) return 0;
        if (vacio(a[i])) return 1; // vacíos siempre al final
        if (vacio(b[i])) return -1;
        return (cols[i].tipo === "n" ? a[i] - b[i] : String(a[i]).localeCompare(String(b[i]), "es", { numeric: true })) * orden.dir;
      });
    }
  }

  function pintar() {
    calcular();
    info.textContent = `${visibles.length} de ${rows.length} filas${Object.values(filtros).some(activo) || buscar.value ? " (filtradas)" : ""}`;
    clear(cont);
    if (!rows.length) return vacio(cont, "Sin registros en ese período.");
    const thead = el("thead", {}, [
      el(
        "tr",
        {},
        cols.map((c, i) =>
          el("th", { class: "orden-th", title: "Clic para ordenar", onclick: () => ((orden = orden.i === i ? (orden.dir === 1 ? { i, dir: -1 } : { i: null, dir: 1 }) : { i, dir: 1 }), pintar()) }, [
            c.label,
            orden.i === i ? el("span", { class: "flecha" }, orden.dir === 1 ? " ▲" : " ▼") : null,
          ])
        )
      ),
      el(
        "tr",
        { class: "fila-filtros" },
        cols.map((c, i) => {
          const lista = `dl-${id}-${i}`;
          const valores = [...new Set(rows.map((r) => texto(c, r[i])).filter(Boolean))].sort((a, b) => a.localeCompare(b, "es", { numeric: true })).slice(0, 300);
          const f = filtros[i] || {};
          const inp = el("input", { type: "search", value: f.txt || "", placeholder: c.tipo === "n" ? "ej. >10" : "Filtrar…", list: lista, class: f.txt ? "activo" : "" });
          inp.addEventListener("change", () => {
            filtros[i] = { ...(filtros[i] || {}), txt: inp.value.trim() };
            pintar();
          });
          const avanzado = f.sel || f.desde || f.hasta;
          const btn = el("button", { class: `filtro-btn ${avanzado ? "activo" : ""}`, type: "button", title: c.tipo === "d" ? "Desde/hasta y varias fechas" : "Elegir varios valores", onclick: () => panelFiltro(i) }, avanzado ? "▾●" : "▾");
          return el("th", {}, [el("div", { class: "filtro-celda" }, [inp, btn]), el("datalist", { id: lista }, valores.map((v) => el("option", { value: v })))]);
        })
      ),
    ]);
    const MAX = 3000;
    const tbody = el(
      "tbody",
      {},
      visibles.slice(0, MAX).map((r) => el("tr", {}, r.map((v, i) => el("td", { class: cols[i].tipo === "n" ? "num" : "" }, texto(cols[i], v)))))
    );
    const conSuma = cols.some((c) => c.suma);
    const tfoot = conSuma
      ? el("tfoot", {}, el("tr", {}, cols.map((c, i) => el("td", { class: "num" }, c.suma ? num(visibles.reduce((s, r) => s + (Number(r[i]) || 0), 0)) : i === 0 ? "Total" : ""))))
      : null;
    cont.appendChild(el("table", { class: "grilla" }, [thead, tbody, tfoot]));
    if (visibles.length > MAX) cont.appendChild(el("p", { class: "nota" }, `Se muestran las primeras ${MAX} filas; filtra o copia para tener todas.`));
  }

  function textoPlano(sep, encabezados) {
    const cel = (c, v) => (c.tipo === "n" ? (v === null || v === undefined || v === "" ? "" : String(v).replace(".", ",")) : String(texto(c, v)).replace(/[\t\r\n;]+/g, " ").trim());
    return [...(encabezados ? [cols.map((c) => c.label).join(sep)] : []), ...visibles.map((r) => r.map((v, i) => cel(cols[i], v)).join(sep))].join("\r\n");
  }
  async function copiar(encabezados) {
    if (!visibles.length) return toast("No hay filas para copiar", "err");
    const txt = textoPlano("\t", encabezados);
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const ta = el("textarea", {}, txt);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(`${visibles.length} filas copiadas${encabezados ? " con encabezados" : ""}`);
  }
  function descargar() {
    if (!visibles.length) return toast("No hay filas", "err");
    const a = el("a", { href: URL.createObjectURL(new Blob(["﻿" + textoPlano(";", true)], { type: "text/csv;charset=utf-8" })), download: `${reg.codigo}_${desde.value}_${hasta.value}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function cargar() {
    if (desde.value > hasta.value) return toast("La fecha 'desde' es posterior a 'hasta'", "err");
    cont.replaceChildren(el("div", { class: "cargando" }, "Leyendo el registro…"));
    try {
      ({ cols, rows } = await cargarDatos(id, desde.value, hasta.value));
    } catch (e) {
      cols = [];
      rows = [];
      return vacio(cont, "No se pudo leer SharePoint: " + e.message);
    }
    filtros = {};
    pintar();
  }
  cargar();
}
