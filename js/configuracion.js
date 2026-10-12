// Configuración (solo Sistemas): responsables de liberación y bodegueros. Se
// guarda en SharePoint (Documentos compartidos/HubRecepcion/configuracion.json)
// y la toman todas las tablets al abrir la app; no hay que tocar el código.

import { CONFIG } from "./config.js";
import { el } from "./dom.js";
import * as st from "./store.js";
import { toast } from "./ui.js";

export async function render(vista) {
  await st.cargarConfig({ esperar: true });
  const lista = (arr) => el("textarea", { rows: String(Math.max(4, arr.length + 1)) }, arr.join("\n"));
  const resp = lista(CONFIG.responsablesPlanta);
  const bod = lista(CONFIG.bodegueros);
  const lineas = (t) => [...new Set(t.value.split("\n").map((x) => x.trim()).filter(Boolean))];
  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Guardar configuración");
  btn.addEventListener("click", async () => {
    const r = lineas(resp);
    const b = lineas(bod);
    if (!r.length || !b.length) return toast("Debe haber al menos un responsable y un bodeguero", "err");
    btn.disabled = true;
    try {
      await st.guardarConfig({ responsablesPlanta: r, bodegueros: b, inicialesHistoricas: CONFIG.inicialesHistoricas });
      toast("Configuración guardada: las tablets la toman al volver a abrir la app");
    } catch (e) {
      toast("No se pudo guardar en SharePoint: " + e.message, "err");
    }
    btn.disabled = false;
  });
  vista.append(
    el("div", { class: "cab" }, [el("div", {}, [el("h1", { class: "titulo" }, "Configuración"), el("p", { class: "sub" }, "Un nombre por línea. Quitar a alguien no borra sus registros anteriores.")])]),
    el("section", { class: "card config" }, [
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Responsables de liberación (Calidad - Planta)"), resp]),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Bodegueros (iniciales, Bodega)"), bod]),
      el("p", { class: "nota" }, `Registros antiguos con iniciales se muestran con nombre: ${Object.entries(CONFIG.inicialesHistoricas).map(([k, v]) => `${k} = ${v}`).join(" · ")}.`),
      btn,
    ])
  );
}
