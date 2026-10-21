// Temperaturas de contenedores (Bodega). Tres veces al día (06:00, 14:30,
// 22:00) el bodeguero recorre los contenedores y anota la temperatura del
// panel. Una tarjeta por contenedor en una sola pantalla con scroll; cada
// lectura se guarda en el equipo al instante y se sube sola (sin internet no
// se pierde nada). El valor se elige con dos ruedas (grados y décima) que
// arrancan en la última lectura; foto del panel obligatoria.
// Contenedores, tipos, rangos y horarios se configuran en Configuración.

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, vacio, comprimirFoto, aNumero, imagen } from "./ui.js";

const fmtT = (t) => (t === null || t === undefined || isNaN(t) ? "—" : `${String(Math.round(t * 10) / 10).replace(".", ",")} °C`);
const activos = () => CONFIG.contenedores.filter((c) => c.activo !== false);
// append() de DOM escribe "null" si recibe null: se filtran los vacíos.
const poner = (nodo, ...hijos) => nodo.append(...hijos.filter((h) => h !== null && h !== undefined && h !== false));
const claseTipo = (c) => (/refriger/i.test(c.tipo || "") ? "refri" : /congel/i.test(c.tipo || "") ? "congel" : "otro");

export function render(vista, resto) {
  if (resto[0] === "historial") return historial(vista, resto[1]);
  // Regla: solo se registra el turno que detecta el sistema por la hora, del
  // día en curso. No se elige otro turno ni se registran días anteriores
  // (aunque se escriba otra fecha en la dirección).
  const { dia, turno } = st.turnoActual();
  return pantallaTurno(vista, dia, turno);
}

// ---------------- registro del turno ----------------

async function pantallaTurno(vista, dia, turno) {
  const bodeguero = el("select", { class: "dias" }, [el("option", { value: "" }, "Bodeguero…"), ...CONFIG.bodegueros.map((b) => el("option", { value: b }, b))]);
  bodeguero.value = (await kv.get("ultimoBodeguero", "")) || "";
  const progreso = el("div", { class: "temp-progreso" });
  const lista = el("div", { class: "temp-lista" }, el("div", { class: "cargando" }, "Cargando…"));

  vista.append(
    el("div", { class: "cab" }, [
      el("div", { class: "cab-titulo-ico" }, [iconoTermometro("ico-titulo"), el("div", {}, [el("h1", { class: "titulo" }, "Temperaturas"), el("p", { class: "sub" }, `Contenedores · ${st.fmtDia(dia)}`)])]),
      el("div", { class: "cab-botones" }, [
        el("a", { class: "btn btn-sec", href: `#/temp/historial/${dia}` }, "📈 Historial"),
      ]),
    ]),
    el("div", { class: "turnos" }, CONFIG.turnosTemperatura.map((t) => el("div", { class: `turno ${t === turno ? "activo" : "bloqueado"}`, title: t === turno ? "Turno actual" : "Solo se registra el turno actual" }, [el("b", {}, t), el("small", { "data-turno": t }, ""), t === turno ? el("span", { class: "turno-tag" }, "Turno actual") : null]))),
    el("div", { class: "temp-barra" }, [progreso, bodeguero]),
    lista
  );

  const vigilar = setInterval(() => {
    if (!document.body.contains(lista)) return clearInterval(vigilar);
    const ahora = st.turnoActual();
    if (ahora.dia !== dia || ahora.turno !== turno) {
      clearInterval(vigilar);
      toast(`Cambió el turno: ${ahora.turno}`);
      location.reload();
    }
  }, 60000);

  let lecturas = await st.temperaturasDelDia(dia);
  const deTurno = (t) => new Map(lecturas.filter((r) => r.Turno === t).map((r) => [r.ContenedorId, r]));

  const pintarProgreso = () => {
    const conts = activos();
    for (const t of CONFIG.turnosTemperatura) {
      const m = deTurno(t);
      const n = conts.filter((c) => m.has(c.id)).length;
      const fuera = conts.filter((c) => m.has(c.id) && m.get(c.id).Estado && m.get(c.id).Estado !== "OK").length;
      const s = vista.querySelector(`[data-turno="${t}"]`);
      if (s) s.textContent = `${n}/${conts.length}${fuera ? ` · ⚠ ${fuera}` : ""}`;
    }
    const m = deTurno(turno);
    const n = conts.filter((c) => m.has(c.id)).length;
    const fuera = conts.filter((c) => m.get(c.id)?.Estado && m.get(c.id).Estado !== "OK").length;
    clear(progreso);
    poner(progreso, 
      el("b", {}, `${n} de ${conts.length} registrados`),
      fuera ? el("span", { class: "estado estado-rojo" }, `${fuera} fuera de rango`) : n === conts.length ? el("span", { class: "estado estado-verde" }, "Turno completo ✓") : null
    );
  };

  const ultimos = {};
  for (const c of activos()) {
    const x = await kv.get(`temp:ultimo:${c.id}`, null);
    if (x !== null && !isNaN(Number(x))) ultimos[c.id] = Number(x);
  }
  for (const r of [...lecturas].sort((x, y) => String(x.HoraRegistro || "").localeCompare(String(y.HoraRegistro || ""))))
    if (r.Temperatura !== null && r.Temperatura !== undefined) ultimos[r.ContenedorId] = Number(r.Temperatura);

  clear(lista);
  if (!activos().length) return vacio(lista, "No hay contenedores configurados (Configuración → Contenedores).");
  for (const c of activos()) lista.appendChild(tarjeta(c));
  pintarProgreso();

  function tarjeta(c) {
    const card = el("article", { class: `temp-card ${claseTipo(c)}` });
    const pintar = () => {
      const r = deTurno(turno).get(c.id);
      clear(card);
      card.classList.remove("ok", "fuera", "pend");
      const cab = el("div", { class: "temp-cab" }, [
        el("div", {}, [el("strong", {}, c.nombre), el("small", {}, `${c.tipo || ""} · rango ${c.min ?? "—"} a ${c.max ?? "—"} °C`)]),
        el("span", { class: "temp-ico" }, claseTipo(c) === "refri" ? "💧" : "❄"),
      ]);
      card.appendChild(cab);
      if (r && !card.dataset.editando) {
        const fuera = r.Estado && r.Estado !== "OK";
        card.classList.add(fuera ? "fuera" : "ok");
        poner(card, 
          el("div", { class: "temp-hecho" }, [
            el("div", { class: "temp-valor" }, fmtT(r.Temperatura)),
            el("div", { class: "temp-info" }, [
              el("b", {}, fuera ? `${r.Estado === "Alto" ? "Sobre" : "Bajo"} el rango` : "Dentro de rango"),
              el("small", {}, `${st.fmtHora(r.HoraRegistro)} · ${r.Bodeguero || r.Operario || ""}${r.pendiente ? " · ↻ subiendo" : ""}`),
              r.Observaciones ? el("small", { class: "temp-obs" }, r.Observaciones) : null,
            ]),
            el("button", { class: "btn btn-sec btn-mini", onclick: () => ((card.dataset.editando = "1"), pintar()) }, "Corregir"),
          ])
        );
        return;
      }
      // --- captura con ruedas (scroll): grados enteros + décima ---
      // Arranca en la lectura de este turno (si se corrige), si no en la última
      // registrada de ese contenedor, si no en el centro de su rango.
      const centro = c.min != null && c.max != null ? (c.min + c.max) / 2 : c.max ?? c.min ?? 0;
      let v = r ? r.Temperatura : ultimos[c.id] ?? Math.round(centro * 2) / 2;
      const lo = Math.floor(c.min ?? (c.max ?? 0) - 15) - 10;
      const hi = Math.ceil(c.max ?? (c.min ?? 0) + 15) + 10;
      // Enteros con signo explícito: incluye "−0" y "0" para lecturas como −0,4.
      const enteros = [];
      for (let k = lo; k <= hi; k++) {
        if (k < 0) enteros.push({ s: -1, a: -k, t: `−${-k}` });
        else if (k === 0) {
          if (lo < 0) enteros.push({ s: -1, a: 0, t: "−0" });
          enteros.push({ s: 1, a: 0, t: "0" });
        } else enteros.push({ s: 1, a: k, t: String(k) });
      }
      const decimas = Array.from({ length: 10 }, (_, d) => ({ d, t: `,${d}` }));
      const partes = (x) => {
        const s = x < 0 || Object.is(x, -0) ? -1 : 1;
        const abs = Math.round(Math.abs(x) * 10) / 10;
        return { s, a: Math.floor(abs), d: Math.round((abs - Math.floor(abs)) * 10) };
      };
      let sel = partes(v);
      const valor = () => sel.s * (sel.a + sel.d / 10);

      const display = el("input", { type: "text", inputmode: "decimal", class: "temp-display", autocomplete: "off", title: "Toca para escribir" });
      const aviso = el("div", { class: "temp-aviso" });
      const obs = el("textarea", { rows: "2", placeholder: "Observación (opcional)" }, r?.Observaciones || "");
      const evaluar = (desdeTeclado = false) => {
        const x = valor();
        if (!desdeTeclado) display.value = `${x < 0 || (sel.s < 0 && x === 0) ? "−" : ""}${String(Math.abs(x).toFixed(1)).replace(".", ",")}`;
        const e = st.estadoTemp(x, c);
        display.className = `temp-display ${e === "OK" ? "ok" : e ? "fuera" : ""}`;
        aviso.textContent = e === "Alto" ? `⚠ Sobre el máximo (${c.max} °C)` : e === "Bajo" ? `⚠ Bajo el mínimo (${c.min} °C)` : "";
      };

      const rEnt = rueda(
        enteros.map((x) => x.t),
        enteros.findIndex((x) => x.s === sel.s && x.a === sel.a),
        (i) => {
          sel = { ...sel, s: enteros[i].s, a: enteros[i].a };
          evaluar();
        }
      );
      const rDec = rueda(
        decimas.map((x) => x.t),
        sel.d,
        (i) => {
          sel = { ...sel, d: i };
          evaluar();
        },
        "decimas"
      );
      // Escribir a mano (opcional): mueve las ruedas al valor escrito.
      display.addEventListener("focus", () => display.select());
      display.addEventListener("input", () => {
        const txt = display.value.trim().replace("−", "-");
        const n = aNumero(txt.replace(/^-/, ""));
        if (n === null) return;
        const x = /^-/.test(txt) ? -n : n;
        const p = partes(x);
        const i = enteros.findIndex((e) => e.s === (x < 0 || /^-/.test(txt) ? -1 : 1) && e.a === p.a);
        if (i < 0) return;
        sel = { s: enteros[i].s, a: p.a, d: p.d };
        rEnt.ir(i, false);
        rDec.ir(p.d, false);
        evaluar(true);
      });
      display.addEventListener("blur", () => evaluar());

      let foto = null;
      const fileIn = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
      const btnFoto = el("button", { class: "btn temp-foto", type: "button", onclick: () => fileIn.click() }, "📷 Tomar foto del panel (obligatoria)");
      fileIn.addEventListener("change", async () => {
        if (!fileIn.files[0]) return;
        foto = await comprimirFoto(fileIn.files[0]);
        btnFoto.textContent = "📷 Foto lista ✓ (tocar para cambiar)";
        btnFoto.classList.remove("falta");
        btnFoto.classList.add("lista");
      });
      const btn = el("button", { class: "btn btn-verde temp-guardar", type: "button" }, r ? "Guardar corrección" : "Registrar");
      btn.addEventListener("click", async () => {
        const x = valor();
        if (Math.abs(x) > 60) return toast(`${c.nombre}: ${fmtT(x)} no parece una lectura válida`, "err");
        // Foto del panel obligatoria siempre (también al corregir).
        if (!foto) return toast(`${c.nombre}: falta la foto del panel`, "err"), btnFoto.classList.add("falta");
        if (!bodeguero.value) return toast("Elige el bodeguero arriba", "err"), bodeguero.focus();
        btn.disabled = true;
        const nuevo = await st.registrarTemperatura({ dia, turno, contenedor: c, temperatura: x, observaciones: obs.value.trim(), bodeguero: bodeguero.value, existente: !!r }, foto);
        ultimos[c.id] = x;
        kv.set(`temp:ultimo:${c.id}`, x);
        lecturas = [...lecturas.filter((y) => y.Title !== nuevo.Title), nuevo];
        delete card.dataset.editando;
        pintar();
        pintarProgreso();
        if (navigator.vibrate) navigator.vibrate(40);
        // siguiente contenedor sin registrar
        const sig = [...lista.querySelectorAll(".temp-card:not(.ok):not(.fuera)")][0];
        if (sig) sig.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      poner(
        card,
        el("div", { class: "temp-lectura" }, [el("div", { class: "temp-campo" }, [display, el("span", {}, "°C")]), aviso]),
        el("div", { class: "temp-ruedas" }, [rEnt.nodo, rDec.nodo]),
        el("p", { class: "temp-ayuda" }, "Desliza los grados y el decimal hasta lo que marca el panel (o toca el número para escribir)."),
        btnFoto,
        fileIn,
        el("details", { class: "temp-mas", ...(r?.Observaciones ? { open: "" } : {}) }, [el("summary", {}, "Observación (opcional)"), obs]),
        btn,
        r ? el("button", { class: "btn btn-sec btn-mini", type: "button", onclick: () => (delete card.dataset.editando, pintar()) }, "Cancelar corrección") : null
      );
      evaluar();
      // Las ruedas se ubican en el valor inicial cuando ya tienen tamaño en pantalla.
      requestAnimationFrame(() => {
        rEnt.ir(enteros.findIndex((x) => x.s === sel.s && x.a === sel.a), false);
        rDec.ir(sel.d, false);
      });
    };
    pintar();
    return card;
  }
}

// ---------------- historial ----------------

async function historial(vista, hasta) {
  hasta = /^\d{4}-\d{2}-\d{2}$/.test(hasta || "") ? hasta : st.hoyISO();
  const dias = el("select", { class: "dias" }, [["1", "Ese día"], ["7", "7 días"], ["14", "14 días"], ["30", "30 días"]].map(([v, t]) => el("option", { value: v, ...(v === "7" ? { selected: "" } : {}) }, t)));
  const cont = el("div", { class: "reporte-wrap" }, el("div", { class: "cargando" }, "Cargando…"));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("a", { href: "#/temp", class: "volver" }, "← Registrar"), el("h1", { class: "titulo" }, "Historial de temperaturas"), el("p", { class: "sub" }, `Hasta el ${st.fmtDia(hasta)}`)]),
      el("div", { class: "cab-botones" }, [dias, el("button", { class: "btn btn-azul", onclick: () => window.print() }, "🖨 Imprimir")]),
    ]),
    cont
  );
  async function cargar() {
    const n = Number(dias.value);
    const desde = st.sumarDias(hasta, -(n - 1));
    let rows = [];
    try {
      rows = await st.temperaturasRango(desde, hasta);
    } catch (e) {
      return vacio(cont, "No se pudo leer SharePoint: " + e.message);
    }
    const mapa = new Map(rows.map((r) => [r.Title, r]));
    // Más reciente primero (a la izquierda).
    const fechas = Array.from({ length: n }, (_, i) => st.sumarDias(hasta, -i));
    const conts = CONFIG.contenedores;
    clear(cont);
    const tabla = el("table", { class: "doc-tabla temp-tabla" }, [
      el("tr", {}, [el("th", {}, "Contenedor"), ...fechas.flatMap((f) => CONFIG.turnosTemperatura.map((t, i) => el("th", { class: i === 0 ? "sep" : "" }, [el("small", {}, st.fmtDia(f).slice(0, 5)), el("br"), t])))]),
      ...conts.map((c) =>
        el("tr", {}, [
          el("td", { class: "td-prod" }, [el("b", {}, c.nombre), el("br"), el("small", {}, `${c.min ?? "—"} a ${c.max ?? "—"} °C`)]),
          ...fechas.flatMap((f) =>
            CONFIG.turnosTemperatura.map((t, i) => {
              const r = mapa.get(st.claveTemp(f, t, c.id));
              return el("td", { class: `${i === 0 ? "sep" : ""} ${r ? (r.Estado === "OK" ? "t-ok" : "t-fuera") : "t-falta"}`, title: r?.Observaciones || "" }, r ? String(Math.round(r.Temperatura * 10) / 10).replace(".", ",") : "·");
            })
          ),
        ])
      ),
    ]);
    const faltan = conts.filter((c) => c.activo !== false).length * fechas.length * CONFIG.turnosTemperatura.length - rows.length;
    const fuera = rows.filter((r) => r.Estado && r.Estado !== "OK");
    poner(cont, 
      el("p", { class: "nota pad" }, `${rows.length} lecturas · ${fuera.length} fuera de rango · ${Math.max(0, faltan)} sin registrar (·). Pasa el dedo o el mouse sobre una celda roja para ver la observación.`),
      tabla,
      fuera.length
        ? el("div", { class: "pad" }, [
            el("h2", {}, "Lecturas fuera de rango"),
            el("ul", { class: "lista-prod" }, fuera.map((r) => el("li", {}, `${st.fmtDia(st.diaISO(r.Fecha))} ${r.Turno} · ${r.Contenedor}: ${String(r.Temperatura).replace(".", ",")} °C (${r.Estado}) — ${r.Observaciones || "sin observación"} · ${r.Bodeguero || r.Operario || ""}`))),
          ])
        : null
    );
  }
  dias.addEventListener("change", cargar);
  cargar();
}

// Rueda horizontal con scroll-snap: el elemento centrado es el elegido.
// ir(i, suave) la mueve sin avisar; al deslizar con el dedo (o la rueda del
// mouse) avisa onCambio(i).
function rueda(textos, inicial, onCambio, clase = "") {
  const sc = el("div", { class: "rueda-sc" });
  const items = textos.map((t, i) => el("div", { class: "rueda-item", "data-i": String(i) }, t));
  sc.append(el("div", { class: "rueda-esp" }), ...items, el("div", { class: "rueda-esp" }));
  let actual = inicial;
  const marcar = () => items.forEach((x, k) => x.classList.toggle("sel", k === actual));
  const cercano = () => {
    const centro = sc.scrollLeft + sc.clientWidth / 2;
    let mejor = 0, d = Infinity;
    items.forEach((x, k) => {
      const dx = Math.abs(x.offsetLeft + x.offsetWidth / 2 - centro);
      if (dx < d) (d = dx), (mejor = k);
    });
    return mejor;
  };
  const ir = (i, suave = true) => {
    if (i < 0 || i >= items.length) return;
    actual = i;
    marcar();
    const x = items[i];
    sc.scrollTo({ left: x.offsetLeft + x.offsetWidth / 2 - sc.clientWidth / 2, behavior: suave ? "smooth" : "auto" });
  };
  let raf = 0;
  sc.addEventListener("scroll", () => {
    clearTimeout(raf);
    raf = setTimeout(() => {
      const k = cercano();
      if (k === actual) return;
      actual = k;
      marcar();
      onCambio(k);
      if (navigator.vibrate) navigator.vibrate(5);
    }, 40);
  }, { passive: true });
  sc.addEventListener("click", (e) => {
    const it = e.target.closest(".rueda-item");
    if (!it) return;
    const k = Number(it.dataset.i);
    ir(k);
    onCambio(k);
  });
  // Rueda del mouse (PC): un paso por muesca.
  sc.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault();
    const k = Math.min(items.length - 1, Math.max(0, actual + (e.deltaY > 0 ? 1 : -1)));
    if (k === actual) return;
    ir(k);
    onCambio(k);
  }, { passive: false });
  marcar();
  return { nodo: el("div", { class: `rueda ${clase}` }, sc), ir };
}

// Ícono de termómetro (SVG propio, toma el color del texto).
export function iconoTermometro(clase = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 64 64");
  s.setAttribute("class", clase);
  s.innerHTML =
    '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M26 38V12a6 6 0 0 1 12 0v26a11 11 0 1 1-12 0z"/><path d="M32 22v24"/><circle cx="32" cy="47" r="4" fill="currentColor"/>' +
    '<path d="M44 14h6M44 22h6M44 30h6"/></g>';
  return s;
}
