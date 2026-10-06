// Calidad: liberación de materia prima por orden de recepción. Reemplaza
// "Órdenes de recepción para liberación" + "Nueva liberación". Un solo paso:
// se abre la orden, se ingresan °Brix/pH/acidez y se libera o rechaza (la
// Power App creaba primero un ítem "En proceso" y lo actualizaba después).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, hoja, campoNum, vacio, confirmar } from "./ui.js";

let timer = null;

export function render(vista) {
  clearInterval(timer);
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando…"));
  const aviso = el("div", { class: "aviso hidden" });
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Liberación de materia prima"), el("p", { class: "sub" }, "Órdenes programadas pendientes de análisis")]),
      el("button", { class: "btn btn-sec", onclick: () => cargar() }, "↻ Actualizar"),
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
  const brix = campoNum("°Brix", { oninput: recalc, autofocus: true });
  const ph = campoNum("pH");
  const acidez = campoNum("Acidez", { sufijo: "%", oninput: recalc });
  const obs = el("textarea", { rows: "2", placeholder: "Observaciones (obligatorio si se rechaza)" });
  const ref = el("div", { class: "referencia" }, "Buscando análisis anteriores…");

  st.ultimasLiberaciones(orden.Fruta).then((rows) => {
    clear(ref);
    if (!rows.length) return ref.append("Sin análisis anteriores de esta fruta.");
    ref.append(
      el("small", {}, "Últimos lotes liberados de esta fruta"),
      el(
        "table",
        {},
        [el("tr", {}, ["Fecha", "°Bx", "pH", "Acidez"].map((x) => el("th", {}, x)))].concat(
          rows.map((r) =>
            el("tr", {}, [st.fmtFecha(r.HoraCierre || r.Created, false), r.OData__x00b0_Brix ?? "", r.PH ?? "", r.Acidez ?? ""].map((x) => el("td", {}, String(x))))
          )
        )
      )
    );
  });

  const btnLib = el("button", { class: "btn btn-verde btn-xl" }, "Liberado");
  const btnRech = el("button", { class: "btn btn-rojo btn-xl" }, "Rechazado");
  const h = hoja(`${orden.Proveedor?.trim()} · ${orden.Fruta}`, [
    el("p", { class: "sub" }, `Programada ${st.fmtFecha(orden.FechaProgramada)} · ${st.fmtKg(orden.CantidadProgramada)} ${orden.Unidad || "KG"} · #${st.idnDe(orden)}`),
    el("div", { class: "campos-3" }, [brix.wrap, ph.wrap, acidez.wrap]),
    ratioTxt,
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Observaciones"), obs]),
    ref,
    el("div", { class: "fila-botones" }, [btnRech, btnLib]),
  ]);
  setTimeout(() => brix.input.focus(), 250);

  const fuera = (v, lo, hi) => v !== null && (v < lo || v > hi);
  async function decidir(decision) {
    const v = { brix: brix.val(), ph: ph.val(), acidez: acidez.val(), obs: obs.value.trim(), inicio };
    if (v.brix === null || v.ph === null) return toast("Ingresa al menos °Brix y pH", "err");
    if (fuera(v.brix, b0, b1) || fuera(v.ph, p0, p1) || fuera(v.acidez, a0, a1)) {
      const ok = await confirmar("Valor fuera de lo habitual", `°Brix ${v.brix} · pH ${v.ph} · acidez ${v.acidez ?? "—"}. ¿Es correcto o es un error de tipeo?`, { si: "Es correcto", no: "Corregir" });
      if (!ok) return;
    }
    if (decision === "Rechazado" && !v.obs) {
      obs.focus();
      return toast("Indica el motivo del rechazo en observaciones", "err");
    }
    btnLib.disabled = btnRech.disabled = true;
    await st.registrarLiberacion(orden, { ...v, acidez: v.acidez ?? 0 }, decision);
    h.cerrar();
    toast(decision === "Liberado" ? "Liberado: Bodega ya puede iniciar la recepción" : "Rechazo registrado", decision === "Liberado" ? "ok" : "err");
    alTerminar();
  }
  btnLib.addEventListener("click", () => decidir("Liberado"));
  btnRech.addEventListener("click", () => decidir("Rechazado"));
}
