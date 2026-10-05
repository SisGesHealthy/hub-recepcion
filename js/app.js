// Arranque, barra superior, inicio por departamento y rutas (#/bodega, ...).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import { initStore, setUsuario, getUsuario, onSync, sincronizar, descartarPrimeraOperacion } from "./store.js";
import { confirmar } from "./ui.js";

const vista = document.getElementById("vista");
const DEPTOS = {
  bodega: { titulo: "Bodega", sub: "Recepción de fruta por pallet", icono: "🚚", ruta: "#/bodega" },
  calidad: { titulo: "Calidad", sub: "Liberación de materia prima", icono: "🧪", ruta: "#/calidad" },
  planta: { titulo: "Calidad - Planta", sub: "Liberación de producto en proceso", icono: "🏭", ruta: "#/planta" },
};

const DEMO_USUARIOS = [
  ["Bodega2", "bodega2@healthyfood.com.ec"],
  ["Analista Calidad Healthy Food", "calidad2@healthyfood.com.ec"],
  ["Sistemas de Gestion HF", "sistemasdegestion@healthyfood.com.ec"],
];

async function main() {
  if (CONFIG.useMock) {
    const guardado = localStorage.getItem("hub-recepcion:demoUser") || DEMO_USUARIOS[0][1];
    const u = DEMO_USUARIOS.find((x) => x[1] === guardado) || DEMO_USUARIOS[0];
    setUsuario(u[0], u[1]);
  } else {
    const auth = await import("./auth.js");
    const acc = await auth.initAuth();
    if (!acc) return pantallaLogin(auth);
    setUsuario(acc.name, acc.username);
  }
  await initStore();
  pintarBarra();
  window.addEventListener("hashchange", rutear);
  rutear();
  if ("serviceWorker" in navigator && !CONFIG.useMock) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function pantallaLogin(auth) {
  clear(vista);
  vista.appendChild(
    el("div", { class: "login" }, [
      el("img", { src: "icons/logo.png", class: "login-logo", alt: "Healthy Food" }),
      el("h1", {}, "Recepción y Liberación"),
      el("p", {}, "Inicia sesión con la cuenta Microsoft del puesto (bodega o calidad)."),
      el("button", { class: "btn btn-verde btn-xl", onclick: () => auth.login() }, "Iniciar sesión"),
    ])
  );
}

function pintarBarra() {
  const u = getUsuario();
  const barra = document.getElementById("barra");
  clear(barra);
  const chip = el("button", { class: "sync-chip", onclick: () => detalleSync() });
  barra.append(
    el("a", { href: "#/", class: "barra-marca" }, [el("img", { src: "icons/logo.png", alt: "" }), el("span", {}, "Recepción y Liberación")]),
    el("div", { class: "barra-der" }, [
      chip,
      CONFIG.useMock
        ? el(
            "select",
            {
              class: "demo-user",
              title: "Modo demo: cambiar de cuenta",
              onchange: (e) => {
                localStorage.setItem("hub-recepcion:demoUser", e.target.value);
                location.hash = "#/";
                location.reload();
              },
            },
            DEMO_USUARIOS.map(([n, c]) => el("option", { value: c, ...(c === u.correo ? { selected: "" } : {}) }, `${n} (demo)`))
          )
        : el("span", { class: "barra-user" }, u.nombre),
    ])
  );
  onSync((s) => {
    chip.className = "sync-chip " + (s.error ? "err" : s.pendientes ? "pend" : "ok");
    chip.textContent = s.error ? `⚠ ${s.pendientes} sin subir` : s.pendientes ? `↻ Subiendo ${s.pendientes}…` : "✓ Al día";
    ultimoSync = s;
  });
}

let ultimoSync = null;
async function detalleSync() {
  const s = ultimoSync || {};
  if (!s.error) {
    sincronizar();
    return;
  }
  const venc = /sesi[oó]n/i.test(s.error);
  if (venc && !CONFIG.useMock) {
    if (await confirmar("Sesión vencida", "Los datos están guardados en este dispositivo. Inicia sesión otra vez para subirlos.", { si: "Iniciar sesión" }))
      (await import("./auth.js")).login();
    return;
  }
  const ok = await confirmar(
    "No se pudo subir un registro",
    `${s.error}\n\nSe reintenta solo cada 30 s. Si el error persiste (por ejemplo, alguien borró la orden en SharePoint), puedes descartar ese registro para que sigan subiendo los demás.`,
    { si: "Descartar ese registro", no: "Reintentar luego", peligro: true }
  );
  if (ok) descartarPrimeraOperacion();
}

async function rutear() {
  const u = getUsuario();
  const [, seccion, ...resto] = (location.hash || "#/").replace(/^#/, "").split("/");
  window.scrollTo(0, 0);
  if (!seccion) return inicio(u);
  if (!u.accesos.includes(seccion)) return sinAcceso(u);
  clear(vista);
  if (seccion === "bodega") (await import("./bodega.js")).render(vista, resto);
  else if (seccion === "calidad") (await import("./calidad.js")).render(vista, resto);
  else if (seccion === "planta") (await import("./planta.js")).render(vista, resto);
}

function inicio(u) {
  clear(vista);
  if (u.accesos.length === 1) {
    // Un solo departamento (ej. bodega2): directo, sin pantalla intermedia.
    location.replace(DEPTOS[u.accesos[0]].ruta);
    return;
  }
  if (!u.accesos.length) return sinAcceso(u);
  vista.appendChild(
    el("section", { class: "inicio" }, [
      el("h1", { class: "titulo" }, `Hola, ${u.nombre.split(" ")[0]}`),
      el("p", { class: "sub" }, "Elige el área"),
      el(
        "div",
        { class: "deptos" },
        u.accesos.map((k) =>
          el("a", { class: "depto", href: DEPTOS[k].ruta }, [
            el("span", { class: "depto-ico" }, DEPTOS[k].icono),
            el("strong", {}, DEPTOS[k].titulo),
            el("small", {}, DEPTOS[k].sub),
          ])
        )
      ),
    ])
  );
}

function sinAcceso(u) {
  clear(vista);
  vista.appendChild(
    el("div", { class: "vacio" }, [
      el("h2", {}, "Sin acceso"),
      el("p", {}, `La cuenta ${u.correo} no tiene asignado este departamento. Pide a Sistemas que la agregue en config.js → accesos.`),
    ])
  );
}

main().catch((e) => {
  console.error(e);
  vista.textContent = "Error al iniciar: " + e.message;
});
