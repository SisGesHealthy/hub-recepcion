// Averías: la app Hub Averías (Cloudflare Worker → Odoo + Teams) integrada
// dentro del Hub, sin abrir otra pestaña. Se abre en su pantalla de inicio:
// "Reportar avería" para cualquiera y "Mantenimiento (PIN)" para técnicos,
// Ingeniería y Calidad (Calidad libera el equipo con su PIN). La sesión de PIN
// vive solo mientras la pantalla está abierta, igual que en la tablet.

import { CONFIG } from "./config.js";
import { el } from "./dom.js";

export function render(vista) {
  const url = `${CONFIG.averias.url}?origen=recepcion`;
  if (!navigator.onLine) {
    vista.appendChild(
      el("div", { class: "vacio" }, [
        el("h2", {}, "Sin conexión"),
        el("p", {}, "Averías necesita internet para enviar el aviso a Mantenimiento. Conéctate y vuelve a entrar."),
        el("a", { class: "btn btn-sec", href: "#/" }, "← Volver"),
      ])
    );
    return;
  }
  document.body.classList.add("modo-averias");
  const salir = () => {
    if (location.hash.startsWith("#/averias")) return;
    document.body.classList.remove("modo-averias");
    window.removeEventListener("hashchange", salir);
  };
  window.addEventListener("hashchange", salir);
  vista.append(
    el("div", { class: "averias-cab" }, [
      el("a", { class: "btn btn-sec btn-mini", href: "#/" }, "← Volver"),
      el("b", {}, "🔧 Averías"),
      el("a", { class: "btn btn-sec btn-mini", href: CONFIG.averias.url, target: "_blank", rel: "noopener" }, "Abrir aparte ↗"),
    ]),
    el("iframe", { class: "averias-frame", src: url, title: "Hub Averías", allow: "camera; fullscreen; screen-wake-lock" })
  );
}
