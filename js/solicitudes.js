// Solicitudes de modificación de registros ya guardados (compartido por
// Calidad - Planta y Calidad MP): lista de pendientes para aprobar o rechazar
// y el historial de lo resuelto. Ver store.js (solicitarModificacion…).

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, vacio, confirmar } from "./ui.js";

// Botón con el número de solicitudes pendientes del módulo (se llena al cargar).
export function btnSolicitudes(modulo, href) {
  const a = el("a", { class: "btn btn-sec", href }, "📝 Solicitudes");
  st.solicitudesPendientes(modulo)
    .then((xs) => {
      if (xs.length) {
        a.textContent = `📝 Solicitudes (${xs.length})`;
        if (st.esAprobador(modulo)) a.classList.add("btn-amarillo");
      }
    })
    .catch(() => {});
  return a;
}

export async function render(vista, modulo, volver) {
  const aprobador = st.esAprobador(modulo);
  const pend = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando…"));
  const hist = el("div", { class: "reporte-wrap" });
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: volver[0], class: "volver" }, volver[1]),
        el("h1", { class: "titulo" }, `Solicitudes de modificación · ${st.NOMBRES_MODULO[modulo] || modulo}`),
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
    xs = await st.solicitudesPendientes(modulo);
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
        const actual = (await st.itemPorId(sol.Lista, sol.ItemID)) || {};
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
    const rec = (await st.solicitudesRecientes(modulo)).filter((x) => x.Estado !== "Pendiente");
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
