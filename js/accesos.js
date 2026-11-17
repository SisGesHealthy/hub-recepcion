// Accesos rápidos: códigos QR (para pegar en la planta o abrir con la cámara)
// que llevan directo a una pantalla. El QR solo abre la página: quien entra
// es la cuenta Microsoft con la que el equipo ya inició sesión.

import { el } from "./dom.js";
import { toast } from "./ui.js";

const BASE = "https://sisgeshealthy.github.io/hub-recepcion/";
const LIB = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";

export const ACCESOS_PLANTA = [
  { ruta: "#/planta", titulo: "Registrar parada", sub: "Liberación en proceso · producción del día", icono: "🏭" },
  { ruta: "#/planta/reporte", titulo: "Reporte de liberaciones", sub: "Las 43 columnas para copiar al Excel", icono: "📊" },
  { ruta: "#/planta/micro", titulo: "Micro pendiente", sub: "Lotes esperando resultado de laboratorio", icono: "🧫" },
];

let cargaLib = null;
function libQR() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  cargaLib ??= new Promise((ok, mal) => {
    const s = document.createElement("script");
    s.src = LIB;
    s.onload = () => ok(window.qrcode);
    s.onerror = () => mal(new Error("No se pudo cargar el generador de QR (¿sin internet?)"));
    document.head.appendChild(s);
  });
  return cargaLib;
}

async function qrSVG(texto) {
  const qrcode = await libQR();
  const q = qrcode(0, "M");
  q.addData(texto);
  q.make();
  const box = el("div", { class: "qr-img" });
  box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  return box;
}

export async function render(vista, accesos = ACCESOS_PLANTA, volver = "#/planta") {
  const grid = el("div", { class: "qr-grid" });
  vista.append(
    el("div", { class: "cab no-print" }, [
      el("div", {}, [el("a", { href: volver, class: "volver" }, "← Volver"), el("h1", { class: "titulo" }, "Accesos rápidos"), el("p", { class: "sub" }, "Escanea con la cámara del celular o imprime y pega junto a la línea.")]),
      el("div", { class: "cab-botones" }, [el("button", { class: "btn btn-azul", onclick: () => window.print() }, "🖨 Imprimir")]),
    ]),
    grid,
    el("p", { class: "nota no-print" }, "El QR solo abre la pantalla. Si el celular no tiene la sesión de Microsoft abierta, la pide una vez y luego entra directo. En Android también puedes mantener presionado el ícono de la app instalada para ver estos mismos accesos.")
  );
  for (const a of accesos) {
    const url = BASE + a.ruta;
    let img;
    try {
      img = await qrSVG(url);
    } catch (e) {
      img = el("div", { class: "aviso" }, e.message);
    }
    grid.appendChild(
      el("article", { class: "qr-card" }, [
        el("div", { class: "qr-tit" }, [el("span", { class: "qr-ico" }, a.icono), el("div", {}, [el("b", {}, a.titulo), el("small", {}, a.sub)])]),
        img,
        el("code", { class: "qr-url" }, url),
        el("div", { class: "fila-botones no-print" }, [
          el("button", {
            class: "btn btn-sec btn-mini",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast("Enlace copiado");
              } catch {
                toast(url);
              }
            },
          }, "Copiar enlace"),
          el("a", { class: "btn btn-sec btn-mini", href: a.ruta }, "Abrir"),
        ]),
      ])
    );
  }
}
