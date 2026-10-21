// Temperaturas de contenedores (Bodega). Tres veces al día (06:00, 14:30,
// 22:00) el bodeguero recorre los contenedores y anota la temperatura del
// panel. Una tarjeta por contenedor en una sola pantalla con scroll; cada
// lectura se guarda en el equipo al instante y se sube sola (sin internet no
// se pierde nada). Fuera de rango → tarjeta en rojo y se pide la acción tomada.
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
  const def = st.turnoActual();
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(resto[0] || "") ? resto[0] : def.dia;
  const turno = CONFIG.turnosTemperatura.includes(decodeURIComponent(resto[1] || "")) ? decodeURIComponent(resto[1]) : def.turno;
  return pantallaTurno(vista, dia, turno);
}

// ---------------- registro del turno ----------------

async function pantallaTurno(vista, dia, turno) {
  const ir = (d, t) => (location.hash = `#/temp/${d}/${encodeURIComponent(t)}`);
  const bodeguero = el("select", { class: "dias" }, [el("option", { value: "" }, "Bodeguero…"), ...CONFIG.bodegueros.map((b) => el("option", { value: b }, b))]);
  bodeguero.value = (await kv.get("ultimoBodeguero", "")) || "";
  const progreso = el("div", { class: "temp-progreso" });
  const lista = el("div", { class: "temp-lista" }, el("div", { class: "cargando" }, "Cargando…"));

  vista.append(
    el("div", { class: "cab" }, [
      el("div", { class: "cab-titulo-ico" }, [iconoTermometro("ico-titulo"), el("div", {}, [el("h1", { class: "titulo" }, "Temperaturas"), el("p", { class: "sub" }, `Contenedores · ${st.fmtDia(dia)}`)])]),
      el("div", { class: "cab-botones" }, [
        el("button", { class: "btn btn-sec", onclick: () => ir(st.sumarDias(dia, -1), turno) }, "‹"),
        el("input", { type: "date", class: "dias", value: dia, onchange: (e) => e.target.value && ir(e.target.value, turno) }),
        el("button", { class: "btn btn-sec", onclick: () => ir(st.sumarDias(dia, 1), turno) }, "›"),
        el("a", { class: "btn btn-sec", href: `#/temp/historial/${dia}` }, "📈 Historial"),
      ]),
    ]),
    el("div", { class: "turnos" }, CONFIG.turnosTemperatura.map((t) => el("button", { class: `turno ${t === turno ? "activo" : ""}`, onclick: () => ir(dia, t) }, [el("b", {}, t), el("small", { "data-turno": t }, "")]))),
    el("div", { class: "temp-barra" }, [progreso, bodeguero]),
    lista
  );

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
      // --- captura ---
      const negativo = (c.max ?? 0) <= 0 && claseTipo(c) !== "refri";
      let signo = negativo ? -1 : 1;
      const input = el("input", { type: "text", inputmode: "decimal", class: "temp-input", placeholder: "0,0", autocomplete: "off" });
      if (r) {
        input.value = String(Math.abs(r.Temperatura)).replace(".", ",");
        signo = r.Temperatura < 0 ? -1 : 1;
      }
      const btnSigno = el("button", { class: "btn temp-signo", type: "button" });
      const aviso = el("div", { class: "temp-aviso" });
      const obs = el("textarea", { rows: "2", placeholder: "Observación (obligatoria si está fuera de rango: ¿qué se hizo?)" }, r?.Observaciones || "");
      const valor = () => {
        const n = aNumero(input.value.replace(/^[-−]/, ""));
        return n === null ? null : signo * Math.abs(n);
      };
      const evaluar = () => {
        btnSigno.textContent = signo < 0 ? "−" : "+";
        const v = valor();
        const e = st.estadoTemp(v, c);
        input.className = `temp-input ${e === "OK" ? "ok" : e ? "fuera" : ""}`;
        aviso.textContent = e === "Alto" ? `⚠ Sobre el máximo (${c.max} °C)` : e === "Bajo" ? `⚠ Bajo el mínimo (${c.min} °C)` : "";
        obs.classList.toggle("requerida", !!e && e !== "OK");
      };
      btnSigno.addEventListener("click", () => ((signo = -signo), evaluar()));
      input.addEventListener("input", () => {
        if (/^[-−]/.test(input.value)) {
          signo = -1;
          input.value = input.value.replace(/^[-−]/, "");
        }
        evaluar();
      });
      let foto = null;
      const fileIn = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
      const btnFoto = el("button", { class: "btn btn-sec btn-mini", type: "button", onclick: () => fileIn.click() }, "📷 Foto del panel");
      fileIn.addEventListener("change", async () => {
        if (!fileIn.files[0]) return;
        foto = await comprimirFoto(fileIn.files[0]);
        btnFoto.textContent = "📷 Foto lista ✓";
      });
      const btn = el("button", { class: "btn btn-verde temp-guardar", type: "button" }, r ? "Guardar corrección" : "Registrar");
      btn.addEventListener("click", async () => {
        const v = valor();
        if (v === null) return toast(`${c.nombre}: escribe la temperatura`, "err"), input.focus();
        if (Math.abs(v) > 60) return toast(`${c.nombre}: ${fmtT(v)} no parece una lectura válida`, "err");
        const e = st.estadoTemp(v, c);
        if (e !== "OK" && !obs.value.trim()) return toast(`${c.nombre} fuera de rango: anota la acción tomada`, "err"), obs.focus();
        if (!bodeguero.value) return toast("Elige el bodeguero arriba", "err"), bodeguero.focus();
        btn.disabled = true;
        const nuevo = await st.registrarTemperatura({ dia, turno, contenedor: c, temperatura: v, observaciones: obs.value.trim(), bodeguero: bodeguero.value, existente: !!r }, foto);
        lecturas = [...lecturas.filter((x) => x.Title !== nuevo.Title), nuevo];
        delete card.dataset.editando;
        pintar();
        pintarProgreso();
        if (navigator.vibrate) navigator.vibrate(40);
        // siguiente contenedor sin registrar
        const sig = [...lista.querySelectorAll(".temp-card:not(.ok):not(.fuera) .temp-input")][0];
        if (sig) sig.closest(".temp-card").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      poner(card, 
        el("div", { class: "temp-captura" }, [btnSigno, el("div", { class: "temp-campo" }, [input, el("span", {}, "°C")]), btn]),
        aviso,
        el("details", { class: "temp-mas", ...(r?.Observaciones ? { open: "" } : {}) }, [el("summary", {}, "Observación / foto"), obs, el("div", { class: "fila-botones izq" }, [btnFoto]), fileIn]),
        r ? el("button", { class: "btn btn-sec btn-mini", type: "button", onclick: () => (delete card.dataset.editando, pintar()) }, "Cancelar corrección") : null
      );
      evaluar();
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
