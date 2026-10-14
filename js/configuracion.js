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
import { toast, confirmar } from "./ui.js";

const NOMBRES = { bodega: "Bodega", calidad: "Calidad (MP)", planta: "Calidad - Planta", pesos: "Control de pesos", config: "Configuración" };

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
    const accesos = { [CONFIG.administrador]: [...st.MODULOS], ...Object.fromEntries(cuentas.map((f) => [f.correo, st.MODULOS.filter((m) => f.mods.has(m))])) };
    btn.disabled = true;
    try {
      await st.guardarConfig({ accesos, responsablesPlanta: r, bodegueros: b, inicialesHistoricas: CONFIG.inicialesHistoricas });
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
    btn
  );
}
