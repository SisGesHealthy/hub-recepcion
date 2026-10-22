// Configuración (solo el administrador): cuentas con acceso y a qué módulos,
// responsables de liberación y bodegueros. Se guarda en SharePoint
// (Documentos compartidos/HubRecepcion/configuracion.json) y la toman todas
// las tablets al abrir la app; no hay que tocar el código.
//
// Ojo: esto decide qué MÓDULOS ve cada cuenta en la app. Para que pueda
// guardar datos, la cuenta también necesita permiso en las listas de
// SharePoint (Editar en las listas del módulo).

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, confirmar, aNumero } from "./ui.js";

const NOMBRES = { bodega: "Bodega", calidad: "Calidad (MP)", planta: "Calidad - Planta", pesos: "Control de pesos", temp: "Temperaturas", averias: "Averías", config: "Configuración" };

export async function render(vista) {
  await st.cargarConfig({ esperar: true });

  // ---- cuentas con acceso ----
  const filas = Object.entries(CONFIG.accesos)
    .filter(([c]) => c !== CONFIG.administrador)
    .map(([correo, mods]) => ({ correo, mods: new Set(mods) }));
  const tabla = el("table", { class: "doc-tabla tabla-accesos" });
  const pintarTabla = () => {
    clear(tabla);
    tabla.appendChild(el("tr", {}, [el("th", {}, "Cuenta (correo)"), ...st.MODULOS.map((m) => el("th", {}, NOMBRES[m])), el("th", {}, "")]));
    tabla.appendChild(
      el("tr", { class: "fila-admin" }, [
        el("td", {}, [el("b", {}, CONFIG.administrador), el("small", {}, " · administrador, siempre todo")]),
        ...st.MODULOS.map(() => el("td", {}, "✓")),
        el("td", {}, ""),
      ])
    );
    filas.forEach((f, i) => {
      const correo = el("input", { type: "email", value: f.correo, placeholder: "usuario@healthyfood.com.ec", class: "in-correo" });
      correo.addEventListener("input", () => (f.correo = correo.value.trim().toLowerCase()));
      tabla.appendChild(
        el("tr", {}, [
          el("td", {}, correo),
          ...st.MODULOS.map((m) => {
            const cb = el("input", { type: "checkbox", ...(f.mods.has(m) ? { checked: "" } : {}) });
            cb.addEventListener("change", () => (cb.checked ? f.mods.add(m) : f.mods.delete(m)));
            return el("td", { class: "td-check" }, cb);
          }),
          el(
            "td",
            {},
            el("button", {
              class: "icon-btn rojo",
              title: "Quitar acceso",
              onclick: async () => {
                if (f.correo && !(await confirmar("Quitar acceso", `${f.correo} dejará de entrar a la app al volver a abrirla. Sus registros anteriores se conservan.`, { si: "Quitar", peligro: true }))) return;
                filas.splice(i, 1);
                pintarTabla();
              },
            }, "✕")
          ),
        ])
      );
    });
  };
  pintarTabla();
  const agregar = el("button", { class: "btn btn-sec", type: "button", onclick: () => (filas.push({ correo: "", mods: new Set() }), pintarTabla(), tabla.querySelector("tr:last-child input")?.focus()) }, "+ Agregar cuenta");

  // ---- responsables y bodegueros ----
  const lista = (arr) => el("textarea", { rows: String(Math.max(4, arr.length + 1)) }, arr.join("\n"));
  const resp = lista(CONFIG.responsablesPlanta);
  const bod = lista(CONFIG.bodegueros);
  const lineas = (t) => [...new Set(t.value.split("\n").map((x) => x.trim()).filter(Boolean))];

  // ---- contenedores (Temperaturas) ----
  const conts = CONFIG.contenedores.map((c) => ({ ...c }));
  const tCont = el("table", { class: "doc-tabla tabla-accesos tabla-cont" });
  const num = (v) => el("input", { type: "text", inputmode: "decimal", value: v === null || v === undefined ? "" : String(v).replace(".", ","), class: "in-num" });
  const pintarCont = () => {
    clear(tCont);
    tCont.appendChild(el("tr", {}, ["Nombre", "Tipo", "Mín °C", "Máx °C", "Activo", ""].map((x) => el("th", {}, x))));
    conts.forEach((c, i) => {
      const nombre = el("input", { type: "text", value: c.nombre || "", class: "in-correo" });
      nombre.addEventListener("input", () => (c.nombre = nombre.value.trim()));
      const tipo = el("select", {}, ["Congelación", "Refrigeración", "Otro"].map((t) => el("option", { value: t }, t)));
      tipo.value = c.tipo || "Congelación";
      tipo.addEventListener("change", () => (c.tipo = tipo.value));
      const mn = num(c.min);
      mn.addEventListener("input", () => (c.min = aNumero(mn.value.replace("−", "-"))));
      const mx = num(c.max);
      mx.addEventListener("input", () => (c.max = aNumero(mx.value.replace("−", "-"))));
      const act = el("input", { type: "checkbox", ...(c.activo !== false ? { checked: "" } : {}) });
      act.addEventListener("change", () => (c.activo = act.checked));
      tCont.appendChild(
        el("tr", {}, [
          el("td", {}, nombre),
          el("td", {}, tipo),
          el("td", {}, mn),
          el("td", {}, mx),
          el("td", { class: "td-check" }, act),
          el("td", {}, el("button", {
            class: "icon-btn rojo",
            title: "Quitar contenedor",
            onclick: async () => {
              if (!(await confirmar("Quitar contenedor", `${c.nombre} deja de aparecer en el registro. Sus lecturas anteriores se conservan (para pausarlo sin quitarlo, desmarca «Activo»).`, { si: "Quitar", peligro: true }))) return;
              conts.splice(i, 1);
              pintarCont();
            },
          }, "✕")),
        ])
      );
    });
  };
  pintarCont();
  const agregarCont = el("button", {
    class: "btn btn-sec",
    type: "button",
    onclick: () => {
      const n = Math.max(0, ...conts.map((c) => Number(String(c.id).replace(/\D/g, "")) || 0)) + 1;
      conts.push({ id: `C${n}`, nombre: `Contenedor ${n}`, tipo: "Congelación", min: -30, max: -15, activo: true });
      pintarCont();
    },
  }, "+ Agregar contenedor");
  // ---- turnos de temperatura: inicio y hasta qué hora se puede registrar ----
  const turnosEd = CONFIG.turnosTemperatura.map((t) => ({ inicio: t, fin: st.finTurno(t) }));
  const tTurnos = el("table", { class: "doc-tabla tabla-accesos" });
  const pintarTurnos = () => {
    clear(tTurnos);
    tTurnos.appendChild(el("tr", {}, ["Turno (inicio)", "Se puede registrar hasta", ""].map((x) => el("th", {}, x))));
    turnosEd.forEach((x, i) => {
      const ini = el("input", { type: "time", value: x.inicio, class: "in-hora" });
      ini.addEventListener("input", () => (x.inicio = ini.value));
      const fin = el("input", { type: "time", value: x.fin, class: "in-hora" });
      fin.addEventListener("input", () => (x.fin = fin.value));
      tTurnos.appendChild(
        el("tr", {}, [
          el("td", {}, ini),
          el("td", {}, fin),
          el("td", {}, el("button", { class: "icon-btn rojo", title: "Quitar turno", onclick: () => (turnosEd.splice(i, 1), pintarTurnos()) }, "✕")),
        ])
      );
    });
  };
  pintarTurnos();
  const agregarTurno = el("button", { class: "btn btn-sec", type: "button", onclick: () => (turnosEd.push({ inicio: "", fin: "" }), pintarTurnos()) }, "+ Agregar turno");

  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Guardar configuración");
  btn.addEventListener("click", async () => {
    const r = lineas(resp);
    const b = lineas(bod);
    if (!r.length || !b.length) return toast("Debe haber al menos un responsable y un bodeguero", "err");
    const cuentas = filas.filter((f) => f.correo);
    const malos = cuentas.filter((f) => !/^[^\s@]+@[^\s@]+\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(f.correo)).map((f) => f.correo);
    if (malos.length) return toast(`Correo no válido: ${malos.join(", ")}`, "err");
    const repetidos = cuentas.map((f) => f.correo).filter((c, i, a) => a.indexOf(c) !== i);
    if (repetidos.length) return toast(`Cuenta repetida: ${[...new Set(repetidos)].join(", ")}`, "err");
    const sinModulo = cuentas.filter((f) => !f.mods.size).map((f) => f.correo);
    if (sinModulo.length && !(await confirmar("Cuentas sin módulos", `${sinModulo.join(", ")} no tiene ningún módulo marcado: verá "Sin acceso". ¿Guardar igual?`, { si: "Guardar" }))) return;
    const externos = cuentas.filter((f) => !f.correo.endsWith("@healthyfood.com.ec")).map((f) => f.correo);
    if (externos.length && !(await confirmar("Cuentas externas", `${externos.join(", ")} no es del dominio healthyfood.com.ec. ¿Darle acceso igual?`, { si: "Sí" }))) return;
    const hora = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t || "");
    const ts = turnosEd.filter((x) => x.inicio || x.fin);
    if (!ts.length) return toast("Debe haber al menos un turno de temperaturas", "err");
    if (ts.some((x) => !hora(x.inicio) || !hora(x.fin))) return toast("Turnos: completa la hora de inicio y hasta qué hora se registra", "err");
    if (ts.some((x) => x.inicio === x.fin)) return toast("Turnos: el inicio y el fin no pueden ser iguales", "err");
    if (new Set(ts.map((x) => x.inicio)).size !== ts.length) return toast("Turnos: hay dos turnos con la misma hora de inicio", "err");
    // Que los horarios no se pisen (en minutos del día, los que pasan medianoche se parten).
    const tramos = ts.flatMap((x) => {
      const a = st.aMinutos(x.inicio), b = st.aMinutos(x.fin);
      return b > a ? [[a, b, x.inicio]] : [[a, 1440, x.inicio], [0, b, x.inicio]];
    }).sort((p, q) => p[0] - q[0]);
    for (let k = 1; k < tramos.length; k++) if (tramos[k][0] < tramos[k - 1][1]) return toast(`Turnos: el horario de ${tramos[k][2]} se cruza con el de ${tramos[k - 1][2]}`, "err");
    if (conts.some((c) => !c.nombre)) return toast("Hay un contenedor sin nombre", "err");
    if (conts.some((c) => c.min != null && c.max != null && c.min > c.max)) return toast("En un contenedor el mínimo es mayor que el máximo", "err");
    const accesos = { [CONFIG.administrador]: [...st.MODULOS], ...Object.fromEntries(cuentas.map((f) => [f.correo, st.MODULOS.filter((m) => f.mods.has(m))])) };
    btn.disabled = true;
    try {
      await st.guardarConfig({ accesos, responsablesPlanta: r, bodegueros: b, inicialesHistoricas: CONFIG.inicialesHistoricas, contenedores: conts, turnosTemperatura: ts.map((x) => x.inicio).sort(), ventanasTemperatura: Object.fromEntries(ts.map((x) => [x.inicio, x.fin])) });
      toast("Configuración guardada: cada equipo la toma al volver a abrir la app");
    } catch (e) {
      toast("No se pudo guardar en SharePoint: " + e.message, "err");
    }
    btn.disabled = false;
  });

  vista.append(
    el("div", { class: "cab" }, [el("div", {}, [el("h1", { class: "titulo" }, "Configuración"), el("p", { class: "sub" }, "Los cambios los toma cada equipo al volver a abrir la app.")])]),
    el("section", { class: "card config" }, [
      el("h2", {}, "Cuentas con acceso"),
      el("p", { class: "nota" }, "Marca los módulos que ve cada cuenta Microsoft. Para que pueda GUARDAR datos, la cuenta también necesita permiso «Editar» en las listas de SharePoint de ese módulo."),
      el("div", { class: "reporte-wrap" }, tabla),
      el("div", { class: "fila-botones izq" }, agregar),
    ]),
    el("section", { class: "card config" }, [
      el("h2", {}, "Responsables y bodegueros"),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Responsables de liberación (Calidad - Planta y Control de pesos) · uno por línea"), resp]),
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Bodegueros (iniciales, Bodega) · uno por línea"), bod]),
      el("p", { class: "nota" }, `Registros antiguos con iniciales se muestran con nombre: ${Object.entries(CONFIG.inicialesHistoricas).map(([k, v]) => `${k} = ${v}`).join(" · ")}. Quitar a alguien no borra sus registros.`),
    ]),
    el("section", { class: "card config" }, [
      el("h2", {}, "Contenedores (Temperaturas)"),
      el("p", { class: "nota" }, "Cada contenedor activo aparece como una tarjeta en el registro de temperaturas, en este orden. El rango define cuándo una lectura queda en rojo."),
      el("div", { class: "reporte-wrap" }, tCont),
      el("div", { class: "fila-botones izq" }, agregarCont),
      el("h3", {}, "Turnos y horario de registro"),
      el("p", { class: "nota" }, "Bodega solo puede registrar un turno entre su inicio y su «hasta». Fuera de esos horarios la pantalla no deja registrar. Si el «hasta» es menor que el inicio, el horario pasa la medianoche (ej. 22:00 → 00:30)."),
      el("div", { class: "reporte-wrap" }, tTurnos),
      el("div", { class: "fila-botones izq" }, agregarTurno),
    ]),
    btn
  );
}
