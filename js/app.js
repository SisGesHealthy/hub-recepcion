// Arranque, barra superior, inicio por departamento y rutas (#/bodega, ...).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import { initStore, setUsuario, getUsuario, onSync, sincronizar, descartarPrimeraOperacion, cargarConfig, verComo } from "./store.js";
import * as store from "./store.js";
import { confirmar } from "./ui.js";
import { iconoBalanza } from "./pesos.js";
import { iconoTermometro } from "./temperaturas.js";

const vista = document.getElementById("vista");
const DEPTOS = {
  bodega: { titulo: "Bodega", sub: "Recepción de fruta por pallet", icono: "🚚", ruta: "#/bodega" },
  calidad: { titulo: "Calidad", sub: "Liberación de materia prima", icono: "🧪", ruta: "#/calidad" },
  planta: { titulo: "Calidad - Planta", sub: "Liberación de producto en proceso", icono: "🏭", ruta: "#/planta" },
  pesos: { titulo: "Control de pesos", sub: "Muestreo en dosificado", icono: "balanza", ruta: "#/pesos" },
  temp: { titulo: "Temperaturas", sub: "Contenedores · 3 turnos al día", icono: "termometro", ruta: "#/temp" },
  averias: { titulo: "Averías", sub: "Reportar · Calidad libera el equipo (PIN)", icono: "🔧", ruta: "#/averias" },
  config: { titulo: "Configuración", sub: "Responsables y bodegueros", icono: "⚙️", ruta: "#/config" },
};

const DEMO_USUARIOS = [
  ["Bodega2", "bodega2@healthyfood.com.ec"],
  ["Analista Calidad Healthy Food", "calidad2@healthyfood.com.ec"],
  ["Sistemas de Gestion HF", "sistemasdegestion@healthyfood.com.ec"],
];

// Enlace directo (QR, acceso del ícono): si hay que pasar por el inicio de
// sesión de Microsoft, la página de destino se recuerda y se abre al volver.
const K_DESTINO = "hub-recepcion:destino";
const K_VERCOMO = "hub-recepcion:verComo";

// Cuentas configuradas (para "Ver como" y el selector del demo).
const cuentasConfiguradas = () => [...new Set([...Object.keys(CONFIG.accesos), CONFIG.administrador].map((c) => c.toLowerCase()))].sort();
try {
  if (location.hash.startsWith("#/") && location.hash.length > 2) sessionStorage.setItem(K_DESTINO, location.hash);
} catch {}

async function main() {
  if (CONFIG.useMock) {
    const guardado = localStorage.getItem("hub-recepcion:demoUser") || DEMO_USUARIOS[0][1];
    const u = DEMO_USUARIOS.find((x) => x[1] === guardado) || DEMO_USUARIOS[0];
    setUsuario(u[0], u[1]);
  } else {
    const auth = await import("./auth.js");
    const acc = await auth.initAuth();
    if (!acc) return pantallaLogin(auth);
    try {
      if (!(await auth.asegurarToken())) return; // redirigiendo a Microsoft
    } catch (e) {
      return pantallaLogin(auth, e.message);
    }
    setUsuario(acc.name, acc.username);
  }
  await initStore();
  await cargarConfig();
  // "Ver como" otra cuenta (solo Sistemas, se guarda en esta pestaña).
  try {
    const vc = sessionStorage.getItem(K_VERCOMO);
    if (vc && getUsuario().correo === CONFIG.administrador) verComo(vc);
  } catch {}
  pintarBarra();
  try {
    const destino = sessionStorage.getItem(K_DESTINO);
    sessionStorage.removeItem(K_DESTINO);
    if (destino && location.hash !== destino) history.replaceState(null, "", destino);
  } catch {}
  window.addEventListener("hashchange", rutear);
  rutear();
  if ("serviceWorker" in navigator && !CONFIG.useMock) activarActualizaciones();
}

// Actualización sola: cuando se publica una versión nueva, la app abierta en la tablet la detecta
// (revisa cada 5 min y al volver a la pantalla) y se recarga. Si hay un formulario abierto no se
// pierde nada: aparece un aviso "Actualizar" y se recarga cuando la persona lo toque.
function activarActualizaciones() {
  const teniaVersion = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    const revisar = () => reg.update().catch(() => {});
    setInterval(revisar, 5 * 60000);
    document.addEventListener("visibilitychange", () => !document.hidden && revisar());
  }).catch(() => {});
  let recargando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!teniaVersion || recargando) return; // primera instalación: no hace falta recargar
    if (!document.querySelector(".hoja")) { recargando = true; location.reload(); return; }
    if (document.getElementById("aviso-version")) return;
    document.body.appendChild(el("div", { id: "aviso-version", class: "aviso-version" }, [
      el("span", {}, "Hay una versión nueva de la app."),
      el("button", { class: "btn btn-verde btn-sm", onclick: () => location.reload() }, "Actualizar"),
    ]));
  });
}

function pantallaLogin(auth, error) {
  clear(vista);
  vista.appendChild(
    el("div", { class: "login" }, [
      el("img", { src: "icons/logo.png", class: "login-logo", alt: "Healthy Food" }),
      el("h1", {}, "Recepción y Liberación"),
      error ? el("div", { class: "aviso" }, error) : null,
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
  // Acceso rápido a los registros M.ASC.02R04 / R05 (solo consulta).
  const verRegistros = puedeVerRegistros(u) ? el("a", { class: "btn btn-sec btn-mini barra-registros", href: "#/registros/r04", title: "Registros M.ASC.02R04 y R05 (consulta)" }, "📊 Registros") : null;
  barra.append(
    el("a", { href: "#/", class: "barra-marca" }, [el("img", { src: "icons/logo.png", alt: "" }), el("span", {}, "Recepción y Liberación")]),
    el("div", { class: "barra-der" }, [
      verRegistros,
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
            [...new Set([...DEMO_USUARIOS.map(([, c]) => c), ...cuentasConfiguradas()])].map((c) => {
              const n = DEMO_USUARIOS.find(([, x]) => x === c)?.[0] || c.split("@")[0];
              return el("option", { value: c, ...(c === u.correo ? { selected: "" } : {}) }, `${n} (demo)`);
            })
          )
        : u.correo === CONFIG.administrador
          ? el(
              "select",
              {
                class: "demo-user",
                title: "Ver la app como otra cuenta (solo cambia lo que se muestra)",
                onchange: (e) => {
                  try {
                    if (e.target.value) sessionStorage.setItem(K_VERCOMO, e.target.value);
                    else sessionStorage.removeItem(K_VERCOMO);
                  } catch {}
                  location.hash = "#/";
                  location.reload();
                },
              },
              [el("option", { value: "" }, u.nombre), ...cuentasConfiguradas().filter((c) => c !== u.correo).map((c) => el("option", { value: c, ...(c === u.verComo ? { selected: "" } : {}) }, `👁 Ver como ${c}`))]
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
  pintarAvisoVerComo(u);
  const [, seccion, ...resto] = (location.hash || "#/").replace(/^#/, "").split("/");
  window.scrollTo(0, 0);
  if (!seccion) return inicio(u);
  if (seccion === "registros") {
    if (!puedeVerRegistros(u)) return sinAcceso(u);
    clear(vista);
    return (await import("./registros.js")).render(vista, resto);
  }
  if (!u.accesos.includes(seccion)) return sinAcceso(u);
  clear(vista);
  if (seccion === "bodega") (await import("./bodega.js")).render(vista, resto);
  else if (seccion === "calidad") (await import("./calidad.js")).render(vista, resto);
  else if (seccion === "planta") (await import("./planta.js")).render(vista, resto);
  else if (seccion === "config") (await import("./configuracion.js")).render(vista);
  else if (seccion === "pesos") (await import("./pesos.js")).render(vista, resto);
  else if (seccion === "temp") (await import("./temperaturas.js")).render(vista, resto);
  else if (seccion === "averias") (await import("./averias.js")).render(vista);
}

function inicio(u) {
  clear(vista);
  // Solo los módulos con tarjeta (los registros R04/R05 van en la barra).
  const deps = u.accesos.filter((k) => DEPTOS[k]);
  if (deps.length === 1) {
    // Un solo departamento (ej. bodega2): directo, sin pantalla intermedia.
    location.replace(DEPTOS[deps[0]].ruta);
    return;
  }
  if (!deps.length) return puedeVerRegistros(u) ? location.replace("#/registros") : sinAcceso(u);
  vista.appendChild(
    el("section", { class: "inicio" }, [
      el("h1", { class: "titulo" }, `Hola, ${u.nombre.split(" ")[0]}`),
      el("p", { class: "sub" }, "Elige el área"),
      el(
        "div",
        { class: "deptos" },
        deps.map((k) =>
          el("a", { class: "depto", href: DEPTOS[k].ruta }, [
            el("span", { class: "depto-ico" }, DEPTOS[k].icono === "balanza" ? iconoBalanza("ico-depto") : DEPTOS[k].icono === "termometro" ? iconoTermometro("ico-depto") : DEPTOS[k].icono),
            el("strong", {}, DEPTOS[k].titulo),
            el("small", {}, DEPTOS[k].sub),
          ])
        )
      ),
    ])
  );
}

function pintarAvisoVerComo(u) {
  document.getElementById("aviso-vercomo")?.remove();
  if (!u.verComo) return;
  document.getElementById("barra").after(
    el("div", { id: "aviso-vercomo", class: "aviso-vercomo" }, [
      `👁 Viendo la app como ${u.verComo} (${u.accesos.length ? u.accesos.join(", ") : "sin módulos"}). Solo cambia lo que se muestra: lo que guardes queda con tu cuenta. `,
      el("button", { class: "btn btn-sec btn-mini", onclick: () => { try { sessionStorage.removeItem(K_VERCOMO); } catch {} location.hash = "#/"; location.reload(); } }, "Volver a mi cuenta"),
    ])
  );
}

// Registros de Calidad: los ven quienes tienen Calidad, Calidad - Planta o Configuración.
const puedeVerRegistros = (u) => u.accesos.includes("r04") || u.accesos.includes("r05");

function sinAcceso(u) {
  clear(vista);
  vista.appendChild(
    el("div", { class: "vacio" }, [
      el("h2", {}, "Sin acceso"),
      store.errorConfig
        ? el("p", {}, `La cuenta ${u.correo} no pudo leer la configuración en SharePoint${store.errorConfig.status ? ` (error ${store.errorConfig.status})` : ""}. Lo más probable es que no tenga permiso en el sitio EspacioColaborativo: pide a Sistemas que la agregue (miembros del sitio) y vuelve a abrir la app.`)
        : el("p", {}, `La cuenta ${u.correo} no tiene asignado este departamento. Pide a Sistemas que te dé acceso en Configuración → Cuentas con acceso.`),
    ])
  );
}

main().catch((e) => {
  console.error(e);
  vista.textContent = "Error al iniciar: " + e.message;
});
