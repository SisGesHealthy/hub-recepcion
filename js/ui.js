// Piezas de interfaz compartidas: avisos, hojas modales, confirmación,
// compresión de foto y panel de firma.

import { el, clear } from "./dom.js";
import { CONFIG } from "./config.js";
import { getApi } from "./store.js";

export function toast(msg, tipo = "ok") {
  const t = el("div", { class: `toast toast-${tipo}` }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

// Hoja modal; devuelve { cerrar, cuerpo }.
export function hoja(titulo, contenido, { ancho = 560, onCerrar } = {}) {
  const root = document.getElementById("overlay-root");
  const panel = el("div", { class: "hoja", style: `max-width:${ancho}px` }, [
    el("div", { class: "hoja-head" }, [
      el("h2", {}, titulo),
      el("button", { class: "icon-btn", "aria-label": "Cerrar", onclick: () => cerrar() }, "✕"),
    ]),
    el("div", { class: "hoja-body" }, contenido),
  ]);
  const fondo = el("div", { class: "hoja-fondo", onclick: (e) => e.target === fondo && cerrar() }, panel);
  root.appendChild(fondo);
  requestAnimationFrame(() => fondo.classList.add("in"));
  function cerrar() {
    fondo.classList.remove("in");
    setTimeout(() => fondo.remove(), 200);
    onCerrar?.();
  }
  return { cerrar, panel };
}

export function confirmar(titulo, texto, { si = "Sí", no = "Cancelar", peligro = false } = {}) {
  return new Promise((resolve) => {
    let r = false;
    const h = hoja(
      titulo,
      [
        el("p", { class: "conf-texto" }, texto),
        el("div", { class: "fila-botones" }, [
          el("button", { class: "btn btn-sec", onclick: () => h.cerrar() }, no),
          el("button", { class: `btn ${peligro ? "btn-rojo" : "btn-verde"}`, onclick: () => ((r = true), h.cerrar()) }, si),
        ]),
      ],
      { ancho: 420, onCerrar: () => resolve(r) }
    );
  });
}

// Reduce la foto de la cámara (2-4 MB) a JPEG de ~150 KB antes de guardarla.
export async function comprimirFoto(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  const src = bmp || (await cargarImagen(file));
  const { ladoMax, calidad } = CONFIG.foto;
  const k = Math.min(1, ladoMax / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * k);
  c.height = Math.round(src.height * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", calidad));
}
function cargarImagen(file) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
}

// <img> que carga una imagen local (blob en IndexedDB) o remota (SharePoint).
export function imagen({ blob, remota }, clase = "") {
  const img = el("img", { class: clase, alt: "" });
  (async () => {
    try {
      let b = blob;
      if (!b && remota) {
        const api = getApi();
        const url = api.imageUrl(remota.lista, remota.id, remota.valor);
        if (url) b = await api.fetchImage(url);
      }
      if (b) img.src = URL.createObjectURL(b);
    } catch {
      img.classList.add("img-err");
    }
  })();
  return img;
}

// Panel de firma con dedo/lápiz. Devuelve { nodo, vacio(), blob(), limpiar() }.
export function panelFirma() {
  const canvas = el("canvas", { class: "firma-canvas" });
  const ctx = canvas.getContext("2d");
  let trazos = 0;
  let dibujando = false;
  function ajustar() {
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1d2318";
    trazos = 0;
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (!canvas.width) ajustar();
    dibujando = true;
    canvas.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...pos(e));
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dibujando) return;
    ctx.lineTo(...pos(e));
    ctx.stroke();
    trazos++;
  });
  canvas.addEventListener("pointerup", () => (dibujando = false));
  canvas.addEventListener("pointercancel", () => (dibujando = false));
  new ResizeObserver(() => ajustar()).observe(canvas);
  const nodo = el("div", { class: "firma-wrap" }, [
    canvas,
    el("span", { class: "firma-linea" }, "Firma del proveedor / transportista"),
    el("button", { class: "firma-limpiar", type: "button", onclick: () => ajustar() }, "Borrar firma"),
  ]);
  return {
    nodo,
    vacio: () => trazos < 5,
    blob: () =>
      new Promise((res) => {
        // fondo blanco para que el PNG se lea en el correo
        const c = document.createElement("canvas");
        c.width = canvas.width;
        c.height = canvas.height;
        const x = c.getContext("2d");
        x.fillStyle = "#fff";
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(canvas, 0, 0);
        c.toBlob(res, "image/png");
      }),
  };
}

// Texto → número aceptando coma o punto decimal ("366,5" o "366.5").
// Con <input type="number"> algunos navegadores en español descartan la coma
// y el campo queda vacío; por eso el campo es de texto con teclado decimal.
export function aNumero(txt) {
  const s = String(txt ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (s === "" || !/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return null;
  return Number(s);
}

// Campo numérico grande, teclado decimal en tablet.
export function campoNum(label, { valor = "", sufijo = "", paso = "any", id, oninput, autofocus } = {}) {
  const input = el("input", {
    type: "text", inputmode: paso === "1" ? "numeric" : "decimal", autocomplete: "off", id,
    value: valor === 0 || valor ? String(valor) : "", ...(autofocus ? { autofocus: "" } : {}),
  });
  input.dataset.num = "1";
  // Solo dígitos y un separador decimal (coma o punto).
  input.addEventListener("input", () => {
    let v = input.value.replace(/[^\d.,]/g, "");
    if (paso === "1") v = v.split(/[.,]/)[0]; // entero: "10.5" → "10", nunca "105"
    const i = v.search(/[.,]/);
    if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/[.,]/g, "");
    if (v !== input.value) input.value = v;
  });
  if (oninput) input.addEventListener("input", oninput);
  input.addEventListener("focus", () => input.select());
  const wrap = el("label", { class: "campo" }, [el("span", { class: "campo-label" }, label), el("div", { class: "campo-input" }, [input, sufijo ? el("span", { class: "sufijo" }, sufijo) : null])]);
  return { wrap, input, val: () => aNumero(input.value) };
}

export function vacio(nodo, msg) {
  clear(nodo);
  nodo.appendChild(el("div", { class: "vacio" }, msg));
}
