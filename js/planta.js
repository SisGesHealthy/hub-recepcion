// Calidad - Planta: liberación de producto en proceso por parada.
// Lotes (lista Lotes) → mediciones (lista Registros) comparadas en vivo con
// los rangos del producto (lista Catalogo-Parametros-Liberacion, que hoy ya
// tiene °Brix/pH/acidez/ratio mín-máx pero nadie los ve al registrar).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, campoNum, vacio, confirmar } from "./ui.js";

export async function render(vista, resto) {
  const cat = await st.catalogo();
  const prodDe = (lote) => cat.find((c) => c.ID === lote.Producto_x002d_CODId) || null;
  if (resto[0] === "lote" && resto[1]) return pantallaLote(vista, Number(resto[1]), prodDe);
  return pantallaLotes(vista, prodDe);
}

async function pantallaLotes(vista, prodDe) {
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando lotes…"));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Liberación en proceso"), el("p", { class: "sub" }, `Lotes abiertos de los últimos ${CONFIG.diasLotes} días`)]),
      el("button", { class: "btn btn-sec", onclick: () => cargar() }, "↻ Actualizar"),
    ]),
    lista
  );
  async function cargar() {
    const lotes = await st.listarLotes();
    clear(lista);
    if (!lotes.length) return vacio(lista, "No hay lotes programados recientes.");
    for (const l of lotes) {
      const p = prodDe(l);
      lista.appendChild(
        el("a", { class: "orden lote", href: `#/planta/lote/${l.ID}` }, [
          el("div", { class: "orden-info" }, [
            el("strong", { class: "orden-prov" }, l.Title),
            el("span", { class: "orden-fruta" }, p ? `${p.Title} · ${p.field_1}` : "Producto sin catálogo"),
            el("span", { class: "orden-fecha" }, `Producción ${st.fmtFecha(l.Fechadeproducci_x00f3_n, false)}`),
          ]),
          el("div", { class: "orden-accion" }, el("span", { class: "btn btn-verde" }, "Registrar parada")),
        ])
      );
    }
  }
  cargar();
}

async function pantallaLote(vista, id, prodDe) {
  const lote = (await kv.get("cache:lotes", [])).find((l) => l.ID === id);
  if (!lote) return vacio(vista, "Lote no encontrado. Vuelve a la lista.");
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
      el("a", { href: "#/planta", class: "volver" }, "← Lotes"),
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
              location.hash = "#/planta";
            }
          },
        }, "Cerrar lote")),
      ]),
    ])
  );
  await cargar();
}
