// Control de pesos en dosificado (Calidad). Toma las órdenes de fabricación
// del día (mismo archivo de Odoo que Calidad - Planta). Cada control es una
// VISITA a la zona de dosificado: parada, lote, equipo que dosifica, muestras
// de peso (precargadas con el peso de la presentación y ajustables con
// botones), recomendaciones y una foto opcional de la visita. Se guarda en la
// lista ControlPesos. Los rangos (nominal/mín/máx por producto y cliente) los
// administra solo Sistemas en ParametrosPeso.

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, hoja, confirmar, vacio, comprimirFoto, aNumero } from "./ui.js";

const esAdmin = () => st.getUsuario()?.accesos.includes("config");
const num = (v, u) => (v === null || v === undefined ? "—" : `${String(Math.round(v * 100) / 100).replace(".", ",")} ${u}`);

export async function render(vista, resto) {
  if (resto[0] === "parametros") return esAdmin() ? parametros(vista) : vacio(vista, "Solo Sistemas administra los parámetros de peso.");
  if (resto[0] === "visita") return pantallaVisita(vista, resto[1]);
  if (resto[0] === "control" && resto[1]) return pantallaControl(vista, Number(resto[1]));
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(resto[0] || "") ? resto[0] : st.hoyISO();
  return pantallaDia(vista, dia);
}

// Clientes del catálogo de liberación por código (para mostrar y para los parámetros).
async function clientePorCodigo() {
  const cat = await st.catalogo();
  return (codigo) => cat.find((c) => (c.Title || "").trim().toUpperCase() === (codigo || "").trim().toUpperCase())?.field_2 || "";
}

// ---------------- día ----------------

async function pantallaDia(vista, dia) {
  const ir = (d) => (location.hash = `#/pesos/${d}`);
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando producción…"));
  const sub = el("p", { class: "sub" });
  const enCurso = await st.visitasEnCurso();
  vista.append(
    el("div", { class: "cab" }, [
      el("div", { class: "cab-titulo-ico" }, [iconoBalanza("ico-titulo"), el("div", {}, [el("h1", { class: "titulo" }, "Control de pesos"), sub])]),
      el("div", { class: "cab-botones" }, [
        el("button", { class: "btn btn-sec", onclick: () => ir(st.sumarDias(dia, -1)) }, "‹"),
        el("input", { type: "date", class: "dias", value: dia, onchange: (e) => e.target.value && ir(e.target.value) }),
        el("button", { class: "btn btn-sec", onclick: () => ir(st.sumarDias(dia, 1)) }, "›"),
        dia !== st.hoyISO() ? el("button", { class: "btn btn-sec", onclick: () => ir(st.hoyISO()) }, "Hoy") : null,
        el("button", { class: "btn btn-azul", onclick: () => controlManual(dia) }, "+ Control sin orden"),
        esAdmin() ? el("a", { class: "btn btn-sec", href: "#/pesos/parametros" }, "⚙ Parámetros de peso") : null,
      ]),
    ]),
    enCurso.length
      ? el("div", { class: "aviso en-curso" }, [
          el("b", {}, enCurso.length === 1 ? "Control en curso" : `${enCurso.length} controles en curso`),
          ...enCurso.map((v) =>
            el("div", { class: "en-curso-fila" }, [
              el("span", {}, `${v.of.codigo} · parada ${v.parada || "—"}${v.lote ? ` · ${v.lote}` : ""} · ${v.muestras.length} muestras · ${st.fmtHora(v.inicio)}`),
              el("a", { href: `#/pesos/visita/${v.id}`, class: "btn btn-azul btn-mini" }, "Continuar"),
              el("button", {
                class: "btn btn-sec btn-mini",
                onclick: async () => {
                  if (!(await confirmar("Descartar control en curso", `Se borran las ${v.muestras.length} muestras de ${v.of.codigo} · parada ${v.parada || "—"} (no guardado). Un control ya guardado no se borra.`, { si: "Descartar", peligro: true }))) return;
                  await st.descartarVisita(v.id);
                  location.reload();
                },
              }, "Descartar"),
            ])
          ),
        ])
      : el("div"),
    lista
  );

  const [datos, params, controles, clienteDe] = await Promise.all([st.cargarOF(), st.parametrosPeso(), st.controlesDelDia(dia), clientePorCodigo()]);
  const ofs = (datos.ofs || []).filter((o) => o.fecha === dia && !/^REP-/i.test(o.codigo));
  // Días más antiguos que la exportación de Odoo (60 días): las OF se rearman
  // desde los controles guardados, así el histórico nunca se pierde.
  for (const c of controles)
    if (c.OrdenFabricacion && !ofs.some((o) => o.of === c.OrdenFabricacion))
      ofs.push({ of: c.OrdenFabricacion, codigo: c.CodigoProducto || "", producto: c.Producto || "", fecha: dia, estado: "histórico", peso_kg: 0, uom_producto: "", cantidad: null, unidad: "" });
  sub.textContent = `Producción del ${st.fmtDia(dia)} · ${ofs.length} ${ofs.length === 1 ? "orden" : "órdenes"} · ${controles.length} ${controles.length === 1 ? "control registrado" : "controles registrados"}`;
  clear(lista);
  if (datos.error) lista.appendChild(el("div", { class: "aviso" }, datos.error));
  if (!ofs.length) return lista.appendChild(el("div", { class: "vacio chico" }, "Sin órdenes de fabricación ni controles de peso con esta fecha de producción."));

  for (const o of ofs) {
    const esp = st.especPeso(o, params);
    const suyos = controles.filter((c) => c.OrdenFabricacion === o.of);
    const rango = esp.nominal
      ? esp.min !== null || esp.max !== null
        ? `Nominal ${num(esp.nominal, esp.unidad)} · rango ${num(esp.min, "")}– ${num(esp.max, esp.unidad)}`
        : `Nominal ${num(esp.nominal, esp.unidad)} (de Odoo) · sin rango configurado`
      : "Presentación desconocida: se escribe al iniciar el control";
    lista.appendChild(
      el("article", { class: `orden of-card ${suyos.length ? "con-lote" : "sin-lote"}` }, [
        el("div", { class: "of-cab" }, [
          el("div", { class: "orden-info" }, [
            el("strong", { class: "orden-prov" }, `${o.codigo} · ${o.producto}`),
            el("span", { class: "orden-fecha" }, `${o.of} · ${clienteDe(o.codigo) || "—"} · ${o.estado}`),
            el("span", { class: esp.min === null && esp.max === null ? "sin-rango" : "orden-fecha" }, rango),
          ]),
          el("div", { class: "orden-accion" }, el("button", { class: "btn btn-verde", onclick: () => iniciar(o, esp, clienteDe(o.codigo), dia) }, "Nuevo control")),
        ]),
        suyos.length
          ? el(
              "div",
              { class: "of-lotes" },
              suyos.map((c) =>
                el(c.ID ? "a" : "div", { class: "of-lote control-fila", ...(c.ID ? { href: `#/pesos/control/${c.ID}` } : {}) }, [
                  el("div", { class: "orden-info" }, [
                    el("strong", {}, `${st.fmtHora(c.HoraInicio)} · Parada ${c.Parada || "—"}${c.Lote ? ` · ${c.Lote}` : ""}${c.pendiente ? " ↻" : ""}`),
                    el("span", { class: "orden-fecha" }, `${c.NMuestras} muestras · promedio ${num(c.Promedio, c.Unidad)} · ${c.FueraDeRango || 0} fuera de rango · ${c.Analista || ""}`),
                  ]),
                  el("div", { class: "control-der" }, [
                    el("span", { class: `estado ${c.Resultado === "Conforme" ? "estado-verde" : c.Resultado === "No conforme" ? "estado-rojo" : "estado-ambar"}` }, c.Resultado || ""),
                    c.ID ? el("span", { class: "btn btn-sec btn-mini" }, "Ver / editar / imprimir") : el("span", { class: "nota" }, "subiendo…"),
                  ]),
                ])
              )
            )
          : null,
      ])
    );
  }
}

// ---------------- control sin orden de fabricación ----------------
// Para lo que se dosifica sin OF en Odoo (o aún no creada): cliente y producto
// salen del catálogo de Odoo (productos terminados con lista de materiales).
async function controlManual(dia) {
  const [datos, params, cat] = await Promise.all([st.cargarOF(), st.parametrosPeso(), st.catalogo()]);
  const productos = datos.productos || [];
  if (!productos.length) return toast("Aún no llega el catálogo de productos de Odoo (se actualiza cada hora). Intenta más tarde.", "err");
  // Cliente por producto: el del catálogo de liberación y los que lo compraron en Odoo.
  const clienteCat = (codigo) => cat.find((c) => (c.Title || "").trim().toUpperCase() === codigo.toUpperCase())?.field_2 || "";
  const clientesDe = (p) => [...new Set([clienteCat(p.codigo), ...(p.clientes || [])].filter(Boolean))];
  const clientes = [...new Set([...(datos.clientes || []), ...productos.flatMap(clientesDe)])].sort((a, b) => a.localeCompare(b));

  const cliente = el("select", {}, [el("option", { value: "" }, "— Todos los clientes —"), ...clientes.map((c) => el("option", { value: c }, c))]);
  const todos = el("input", { type: "checkbox" });
  const lista = el("datalist", { id: "dl-prod-manual" });
  const prod = el("input", { type: "text", list: "dl-prod-manual", placeholder: "Escribe código o nombre…", autocomplete: "off" });
  const ref = el("input", { type: "text", placeholder: "Opcional: n.º de orden o referencia" });
  const info = el("p", { class: "nota" });
  const visibles = () => {
    const c = cliente.value;
    const suyos = c ? productos.filter((p) => clientesDe(p).includes(c)) : productos;
    return c && !todos.checked && suyos.length ? suyos : productos;
  };
  const pintarLista = () => {
    clear(lista);
    const v = visibles();
    v.forEach((p) => lista.appendChild(el("option", { value: `${p.codigo} · ${p.producto}` })));
    info.textContent = cliente.value && !todos.checked && v.length < productos.length ? `${v.length} productos de ${cliente.value} (marca «ver todos» si no aparece).` : `${v.length} productos.`;
  };
  const elegido = () => {
    const cod = prod.value.split("·")[0].trim().toUpperCase();
    return productos.find((p) => p.codigo.toUpperCase() === cod) || null;
  };
  cliente.addEventListener("change", () => ((prod.value = ""), pintarLista()));
  todos.addEventListener("change", pintarLista);
  prod.addEventListener("change", () => {
    const p = elegido();
    if (p && !cliente.value) {
      const cs = clientesDe(p);
      if (cs.length === 1) cliente.value = cs[0];
    }
  });
  pintarLista();

  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Continuar");
  const campo = (l, x) => el("label", { class: "campo" }, [el("span", { class: "campo-label" }, l), x]);
  const h = hoja("Control sin orden de Odoo", [
    el("p", { class: "sub" }, "Para un producto que se está dosificando y no tiene orden de fabricación en Odoo."),
    campo("Cliente", cliente),
    campo("Producto", el("div", {}, [prod, lista])),
    el("label", { class: "check-linea" }, [todos, " Ver todos los productos"]),
    info,
    campo("Orden / referencia", ref),
    btn,
  ]);
  setTimeout(() => prod.focus(), 250);
  btn.addEventListener("click", () => {
    const p = elegido();
    if (!p) return toast("Elige un producto de la lista", "err");
    const of = {
      of: ref.value.trim() || `SIN OF · ${p.codigo}`,
      codigo: p.codigo,
      producto: p.producto,
      fecha: dia,
      estado: "sin orden",
      peso_kg: p.peso_kg,
      uom_producto: p.uom_producto,
      cantidad: null,
      unidad: "",
    };
    h.cerrar();
    iniciar(of, st.especPeso(of, params), cliente.value || clientesDe(p)[0] || "", dia);
  });
}

// ---------------- inicio de la visita ----------------

async function iniciar(of, esp, cliente, dia) {
  const { lotes, prop } = await st.lotesDelDia(dia);
  const lotesOF = lotes.filter((l) => prop && (l[prop] || "") === of.of).map((l) => l.Title);
  const parada = el("input", { type: "text", inputmode: "numeric", placeholder: "Ej. 1, 2, 3.1" });
  const lote = lotesOF.length
    ? el("select", {}, [...lotesOF.map((t) => el("option", { value: t }, t)), el("option", { value: "" }, "— Sin lote —")])
    : el("input", { type: "text", placeholder: "Lote (si ya está asignado)" });
  const equipo = el("textarea", { rows: "3", placeholder: "Operadores en el dosificador (uno por línea)" }, await kv.get("pesos:ultimoEquipo", ""));
  const analista = el("select", {}, CONFIG.responsablesPlanta.map((r) => el("option", { value: r }, r)));
  const ult = await kv.get("ultimoResponsablePlanta", "");
  if (CONFIG.responsablesPlanta.includes(ult)) analista.value = ult;
  const sellado = el("select", {}, [el("option", { value: "" }, "No aplica"), ...["Termosellado", "Cuello de ganso"].map((t) => el("option", { value: t }, t))]);
  sellado.value = await st.selladoRecordado(of.codigo);
  // Presentación desconocida (nombre sin peso y Odoo "por kilo"): la escribe
  // la analista para este control.
  const sinPres = !esp.nominal;
  const presVal = el("input", { type: "text", inputmode: "decimal", placeholder: "Ej. 5", class: "in-num" });
  const presU = el("select", {}, ["kg", "g"].map((x) => el("option", { value: x }, x)));
  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Iniciar control");
  const campo = (l, x) => el("label", { class: "campo" }, [el("span", { class: "campo-label" }, l), x]);
  const h = hoja("Nuevo control de pesos", [
    el("p", { class: "sub" }, `${of.of} · ${of.codigo} · ${of.producto}`),
    el("div", { class: "campos-2" }, [campo("Parada", parada), campo("Lote", lote)]),
    campo("Equipo dosificando", equipo),
    el("div", { class: "campos-2" }, [campo("Analista", analista), campo("Sellado (opcional)", sellado)]),
    sinPres
      ? el("div", { class: "aviso" }, [
          "Este producto no tiene presentación conocida. Escribe el peso de la presentación que se está dosificando: ",
          el("div", { class: "fila-botones izq" }, [presVal, presU]),
        ])
      : null,
    el("p", { class: "nota" }, `Peso de referencia: ${num(esp.nominal, esp.unidad)}${esp.min !== null || esp.max !== null ? ` · rango ${num(esp.min, "")}– ${num(esp.max, esp.unidad)}` : " · sin rango configurado (avisar a Sistemas)"}`),
    btn,
  ]);
  setTimeout(() => parada.focus(), 250);
  btn.addEventListener("click", async () => {
    if (!parada.value.trim()) return toast("Indica la parada", "err");
    if (sinPres) {
      const n = aNumero(presVal.value);
      if (!n || n <= 0) return toast("Escribe el peso de la presentación (ej. 5 kg)", "err");
      esp = { nominal: n, min: null, max: null, unidad: presU.value, origen: "analista", param: null, clave: null };
    }
    if (!equipo.value.trim()) return toast("Indica quién está dosificando", "err");
    const id = crypto.randomUUID();
    await st.guardarVisitaLocal({
      id,
      dia,
      inicio: new Date().toISOString(),
      of,
      esp,
      cliente,
      parada: parada.value.trim(),
      lote: lote.value.trim(),
      equipo: equipo.value.trim(),
      analista: analista.value,
      sellado: sellado.value,
      muestras: [],
    });
    await kv.set("ultimoResponsablePlanta", analista.value);
    h.cerrar();
    location.hash = `#/pesos/visita/${id}`;
  });
}

// ---------------- toma de muestras ----------------

async function pantallaVisita(vista, id) {
  const abiertas = await st.visitasEnCurso();
  const v = (id && abiertas.find((x) => x.id === id)) || (!id && abiertas[0]) || null;
  if (!v) {
    location.hash = "#/pesos";
    return;
  }
  const esp = v.esp;
  const u = esp.unidad;
  // Pasos de los botones según la presentación: gramos (397 g) o kilos (14 kg).
  const pasos = u === "kg" ? [0.1, 0.05, 0.01] : esp.nominal >= 500 ? [10, 5, 1] : [5, 1, 0.1];
  const dec = (x) => (String(x).split(".")[1] || "").length;
  const precision = Math.max(...pasos.map(dec));
  let valor = v.muestras.length ? v.muestras[v.muestras.length - 1].peso : esp.nominal;

  const pantalla = el("input", { type: "text", inputmode: "decimal", class: "peso-grande", autocomplete: "off" });
  const estado = el("div", { class: "peso-estado" });
  const pintar = () => {
    pantalla.value = String(Math.round(valor * 10 ** precision) / 10 ** precision).replace(".", ",");
    const e = st.estadoPeso(valor, esp);
    pantalla.className = `peso-grande ${e || ""}`;
    estado.textContent = e === "ok" ? "Dentro de rango" : e === "bajo" ? `Bajo el mínimo (${num(esp.min, u)})` : e === "alto" ? `Sobre el máximo (${num(esp.max, u)})` : "Sin rango configurado";
    estado.className = `peso-estado ${e || ""}`;
  };
  pantalla.addEventListener("input", () => {
    const n = aNumero(pantalla.value);
    if (n !== null) {
      valor = n;
      const e = st.estadoPeso(valor, esp);
      pantalla.className = `peso-grande ${e || ""}`;
      estado.textContent = e === "ok" ? "Dentro de rango" : e === "bajo" ? "Bajo el mínimo" : e === "alto" ? "Sobre el máximo" : "Sin rango configurado";
      estado.className = `peso-estado ${e || ""}`;
    }
  });
  pantalla.addEventListener("focus", () => pantalla.select());
  const paso = (d) =>
    el("button", { class: `btn paso ${d < 0 ? "menos" : "mas"}`, type: "button", onclick: () => ((valor = Math.round((valor + d) * 10 ** precision) / 10 ** precision), pintar()) }, `${d > 0 ? "+" : "−"}${String(Math.abs(d)).replace(".", ",")}`);

  const lista = el("div", { class: "muestras" });
  const resumen = el("div", { class: "resumen-tot" });
  const pintarMuestras = () => {
    const r = st.resumenMuestras(v.muestras, esp);
    clear(resumen);
    resumen.append(
      el("div", {}, [el("small", {}, "Muestras"), el("b", {}, String(r.n))]),
      el("div", {}, [el("small", {}, "Promedio"), el("b", {}, num(r.promedio, u))]),
      el("div", {}, [el("small", {}, "Menor / mayor"), el("b", {}, r.n ? `${num(r.menor, "")}/ ${num(r.mayor, u)}` : "—")]),
      el("div", { class: r.fuera ? "fuera" : "" }, [el("small", {}, "Fuera de rango"), el("b", {}, String(r.fuera))])
    );
    clear(lista);
    [...v.muestras].reverse().forEach((m, i) =>
      lista.appendChild(
        el("div", { class: `muestra ${m.estado || ""}` }, [
          el("b", {}, `#${v.muestras.length - i}`),
          el("span", {}, num(m.peso, u)),
          el("small", {}, st.fmtHora(m.hora)),
          i === 0 ? el("button", { class: "icon-btn rojo", title: "Quitar última muestra", onclick: () => (v.muestras.pop(), st.guardarVisitaLocal(v), pintarMuestras()) }, "✕") : null,
        ])
      )
    );
  };

  const registrar = el("button", { class: "btn btn-verde btn-xl", type: "button" }, "Registrar muestra");
  registrar.addEventListener("click", async () => {
    const n = aNumero(pantalla.value);
    if (n === null || n <= 0) return toast("Peso no válido", "err");
    valor = n;
    v.muestras.push({ peso: n, hora: new Date().toISOString(), estado: st.estadoPeso(n, esp) });
    await st.guardarVisitaLocal(v);
    pintarMuestras();
    pintar();
    if (navigator.vibrate) navigator.vibrate(40);
  });

  vista.append(
    el("section", { class: "rec-cab" }, [
      el("a", { href: `#/pesos/${v.dia}`, class: "volver" }, "← Control de pesos"),
      abiertas.length > 1
        ? el("div", { class: "otros-controles" }, [
            el("span", {}, "Cambiar a:"),
            ...abiertas.filter((x) => x.id !== v.id).map((x) => el("a", { href: `#/pesos/visita/${x.id}`, class: "btn btn-sec btn-mini" }, `${x.of.codigo} · parada ${x.parada || "—"} (${x.muestras.length})`)),
          ])
        : null,
      el("div", { class: "rec-titulo" }, [
        el("h1", {}, `${v.of.codigo} · Parada ${v.parada}`),
        el("span", {}, `${v.of.producto}${v.lote ? ` · Lote ${v.lote}` : ""} · inicio ${st.fmtHora(v.inicio)} · ${v.analista}`),
      ]),
      el("div", { class: "especif" }, [
        el("span", {}, ["Nominal ", el("b", {}, num(esp.nominal, u))]),
        el("span", {}, ["Mínimo ", el("b", {}, num(esp.min, u))]),
        el("span", {}, ["Máximo ", el("b", {}, num(esp.max, u))]),
        el("span", {}, ["Equipo ", el("b", {}, v.equipo.replace(/\n/g, ", "))]),
        v.sellado ? el("span", {}, ["Sellado ", el("b", {}, v.sellado)]) : null,
      ]),
    ]),
    el("div", { class: "rec-grid" }, [
      el("section", { class: "card balanza" }, [
        el("h2", {}, "Peso de la muestra"),
        el("div", { class: "peso-centro" }, [pantalla, el("span", { class: "peso-u" }, u)]),
        el("div", { class: "peso-fila" }, [...pasos.map((d) => paso(-d)), ...[...pasos].reverse().map((d) => paso(d))]),
        estado,
        registrar,
        el("p", { class: "nota" }, "Ajusta con los botones o escribe el peso exacto que marca la balanza. El siguiente valor parte del último registrado."),
      ]),
      el("section", { class: "card" }, [
        el("h2", {}, "Muestras"),
        resumen,
        lista,
        el("div", { class: "fin-wrap" }, [
          el("button", { class: "btn btn-azul btn-xl", onclick: () => terminar(v) }, "Terminar control"),
          el("button", {
            class: "btn btn-sec cancelar-rec",
            onclick: async () => {
              if (await confirmar("Descartar control", "Se borran las muestras tomadas en esta visita.", { si: "Descartar", peligro: true })) {
                await st.descartarVisita(v.id);
                location.hash = `#/pesos/${v.dia}`;
              }
            },
          }, "Descartar"),
        ]),
      ]),
    ])
  );
  pintar();
  pintarMuestras();
}

async function terminar(v) {
  if (!v.muestras.length) return toast("Registra al menos una muestra", "err");
  const r = st.resumenMuestras(v.muestras, v.esp);
  // Hubo muestras fuera de rango pero las 2 últimas ya están bien → se
  // corrigió en el momento ("Con ajustes"); si siguen fuera → "No conforme".
  const ultimas = v.muestras.slice(-2);
  const finalOk = ultimas.length === 2 && ultimas.every((m) => m.estado !== "bajo" && m.estado !== "alto");
  const sugerido = r.fuera === 0 ? "Conforme" : finalOk ? "Con ajustes" : "No conforme";
  const resultado = el("select", {}, ["Conforme", "Con ajustes", "No conforme"].map((x) => el("option", { value: x }, x)));
  resultado.value = sugerido;
  const reco = el("textarea", { rows: "3", placeholder: "Indicaciones al personal (ej. subir dosificación 2 g)" }, v.recomendaciones || "");
  const atajos = ["Peso dentro de rango, sin novedad", "Se indicó subir la dosificación", "Se indicó bajar la dosificación", "Se calibró el dosificador"].map((t) =>
    el("button", { class: "chip", type: "button", onclick: () => (reco.value = reco.value ? `${reco.value}. ${t}` : t) }, t)
  );
  let foto = null;
  const fileIn = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
  const fotoBtn = el("button", { class: "btn btn-sec", type: "button", onclick: () => fileIn.click() }, "📷 Foto de la visita (opcional)");
  fileIn.addEventListener("change", async () => {
    if (!fileIn.files[0]) return;
    foto = await comprimirFoto(fileIn.files[0]);
    fotoBtn.textContent = "📷 Foto lista ✓ (tocar para cambiar)";
  });
  const estadoSellado = el("select", {}, [el("option", { value: "" }, "— Elegir —"), ...["Conforme", "No conforme"].map((x) => el("option", { value: x }, x))]);
  estadoSellado.value = v.estadoSellado || "";
  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Guardar control");
  const h = hoja("Terminar control de pesos", [
    el("div", { class: "resumen-tot" }, [
      el("div", {}, [el("small", {}, "Muestras"), el("b", {}, String(r.n))]),
      el("div", {}, [el("small", {}, "Promedio"), el("b", {}, num(r.promedio, v.esp.unidad))]),
      el("div", {}, [el("small", {}, "Menor / mayor"), el("b", {}, `${num(r.menor, "")}/ ${num(r.mayor, v.esp.unidad)}`)]),
      el("div", { class: r.fuera ? "fuera" : "" }, [el("small", {}, "Fuera de rango"), el("b", {}, String(r.fuera))]),
    ]),
    el("div", { class: "campos-2" }, [
      el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Resultado de pesos"), resultado]),
      v.sellado ? el("label", { class: "campo" }, [el("span", { class: "campo-label" }, `Sellado (${v.sellado})`), estadoSellado]) : null,
    ]),
    el("label", { class: "campo" }, [el("span", { class: "campo-label" }, "Recomendaciones al personal"), reco]),
    el("div", { class: "chips" }, atajos),
    el("div", { class: "fila-botones" }, [fotoBtn]),
    fileIn,
    btn,
  ]);
  btn.addEventListener("click", async () => {
    if (v.sellado && !estadoSellado.value) return toast(`Indica si el sellado (${v.sellado}) es conforme`, "err");
    if ((resultado.value !== "Conforme" || estadoSellado.value === "No conforme") && !reco.value.trim()) return toast("Escribe la recomendación dada al personal", "err");
    btn.disabled = true;
    await st.finalizarVisita(v, { resultado: resultado.value, recomendaciones: reco.value.trim(), estadoSellado: estadoSellado.value }, foto);
    h.cerrar();
    toast("Control de pesos guardado");
    location.hash = `#/pesos/${v.dia}`;
  });
}

// ---------------- control guardado: ver, editar, seguir, imprimir ----------------

async function pantallaControl(vista, id) {
  vista.appendChild(el("div", { class: "cargando" }, "Cargando control…"));
  let c = null;
  try {
    c = await st.getControl(id);
  } catch {}
  clear(vista);
  if (!c) return vacio(vista, "Control no encontrado (sin conexión o eliminado).");
  const dia = st.diaISO(c.Fecha);
  const u = c.Unidad || "g";
  const esp = { nominal: c.PesoNominal, min: c.PesoMinimo ?? null, max: c.PesoMaximo ?? null, unidad: u };
  const muestras = st.muestrasDeTexto(c.Muestras, dia, esp);
  const r = st.resumenMuestras(muestras, esp);
  const yaAbierto = await st.getVisita(c.Title);
  const fila = (k, v) => el("div", { class: "dato" }, [el("span", {}, k), el("b", {}, v || "—")]);

  // Control hecho sin rango y hoy el producto ya tiene rango configurado.
  let rangoHoy = null;
  if (c.PesoMinimo == null && c.PesoMaximo == null) {
    const e = st.especPeso({ codigo: c.CodigoProducto, producto: c.Producto }, await st.parametrosPeso());
    if (e.min != null && e.max != null) rangoHoy = e;
  }
  const aplicarRango = async () => {
    const espN = { ...esp, min: rangoHoy.min, max: rangoHoy.max };
    const ms = st.muestrasDeTexto(c.Muestras, dia, espN);
    const rn = st.resumenMuestras(ms, espN);
    const res = st.resultadoSugerido(ms, espN);
    const altas = ms.filter((m) => m.estado === "alto").length;
    const bajas = ms.filter((m) => m.estado === "bajo").length;
    const ok = await confirmar(
      "Aplicar rango actual",
      `Rango ${num(rangoHoy.min, "")}– ${num(rangoHoy.max, u)} (configurado después de este control).\n\n` +
        `Con ese rango: ${rn.fuera} de ${rn.n} muestras fuera (${altas} altas, ${bajas} bajas); promedio ${num(rn.promedio, u)}.\n` +
        `Resultado: ${c.Resultado || "—"} → ${res}.\n\nQueda anotado en Recomendaciones que el rango se aplicó después.`,
      { si: "Aplicar rango" }
    );
    if (!ok) return;
    await st.aplicarRangoActual(c, rangoHoy);
    toast("Rango aplicado y control recalculado");
    location.reload();
  };

  const seguir = async () => {
    // Si ya se estaba continuando en este equipo, se retoma tal cual (sin perder muestras nuevas).
    if (!yaAbierto) await st.reabrirControl(c);
    location.hash = `#/pesos/visita/${c.Title}`;
  };

  vista.append(
    el("div", { class: "no-print acciones-resumen" }, [
      el("a", { href: `#/pesos/${dia}`, class: "volver" }, "← Control de pesos"),
      el("div", { class: "fila-botones" }, [
        rangoHoy ? el("button", { class: "btn btn-amarillo", onclick: aplicarRango }, `Aplicar rango actual (${num(rangoHoy.min, "")}– ${num(rangoHoy.max, u)})`) : null,
        el("button", { class: "btn btn-sec", onclick: () => editarDatos(c) }, "✎ Editar datos"),
        el("button", { class: "btn btn-verde", onclick: seguir }, "➕ Seguir tomando muestras"),
        el("button", { class: "btn btn-azul", onclick: () => window.print() }, "🖨 Imprimir"),
      ]),
    ]),
    el("article", { class: "resumen-doc" }, [
      el("header", { class: "doc-cab" }, [
        el("img", { src: "icons/logo.png", alt: "Healthy Food" }),
        el("div", {}, [el("h1", {}, "Registro de control de pesos"), el("span", {}, `${c.OrdenFabricacion} · ${st.fmtDia(dia)} · ${st.fmtHora(c.HoraInicio)}–${st.fmtHora(c.HoraFin)}`)]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Datos"),
        el("div", { class: "datos" }, [
          fila("Producto", `${c.CodigoProducto} · ${c.Producto}`),
          fila("Cliente", c.Cliente),
          fila("Lote", c.Lote),
          fila("Parada", c.Parada),
          fila("Analista", c.Analista),
          fila("Equipo dosificando", (c.Equipo || "").replace(/\n/g, ", ")),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Especificación y resultado"),
        el("div", { class: "datos" }, [
          fila("Peso nominal", num(c.PesoNominal, u)),
          fila("Rango", c.PesoMinimo == null && c.PesoMaximo == null ? "Sin rango configurado" : `${num(c.PesoMinimo, "")}– ${num(c.PesoMaximo, u)}`),
          fila("Muestras", String(r.n)),
          fila("Promedio", num(r.promedio, u)),
          fila("Menor / mayor", `${num(r.menor, "")}/ ${num(r.mayor, u)}`),
          fila("Fuera de rango", String(r.fuera)),
          fila("Resultado", c.Resultado),
          ...(c.TipoSellado ? [fila("Sellado", `${c.TipoSellado} · ${c.EstadoSellado || "sin verificar"}`)] : []),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Muestras"),
        el("table", { class: "doc-tabla muestras-tabla" }, [
          el("tr", {}, ["N°", "Hora", `Peso (${u})`, "Estado"].map((x) => el("th", {}, x))),
          ...muestras.map((m, i) =>
            el("tr", { class: m.estado === "bajo" || m.estado === "alto" ? "fuera-fila" : "" }, [
              el("td", {}, String(i + 1)),
              el("td", {}, st.fmtHora(m.hora)),
              el("td", {}, String(m.peso).replace(".", ",")),
              el("td", {}, m.estado === "ok" ? "OK" : m.estado === "bajo" ? "BAJO" : m.estado === "alto" ? "ALTO" : "—"),
            ])
          ),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [el("h2", {}, "Recomendaciones al personal"), el("p", {}, c.Recomendaciones || "—")]),
      c.Foto
        ? el("section", { class: "doc-sec" }, [el("h2", {}, "Foto de la visita"), imagenSP({ lista: "controlPesos", id: c.ID, valor: c.Foto })])
        : null,
      el("section", { class: "doc-sec firmas" }, [
        el("div", {}, [el("span", { class: "linea-firma" }), el("small", {}, `Analista: ${c.Analista || ""}`)]),
        el("div", {}, [el("span", { class: "linea-firma" }), el("small", {}, "Supervisor de producción")]),
      ]),
    ])
  );
}

// Foto guardada en SharePoint (se baja con el token del usuario).
function imagenSP(remota) {
  const img = el("img", { class: "firma-img", alt: "Foto de la visita" });
  (async () => {
    try {
      const api = st.getApi();
      const url = api.imageUrl(remota.lista, remota.id, remota.valor);
      if (url) img.src = URL.createObjectURL(await api.fetchImage(url));
    } catch {}
  })();
  return img;
}

function editarDatos(c) {
  const campo = (l, x) => el("label", { class: "campo" }, [el("span", { class: "campo-label" }, l), x]);
  const parada = el("input", { type: "text", value: c.Parada || "" });
  const lote = el("input", { type: "text", value: c.Lote || "" });
  const equipo = el("textarea", { rows: "3" }, c.Equipo || "");
  const analista = el("select", {}, [...new Set([...CONFIG.responsablesPlanta, c.Analista].filter(Boolean))].map((r) => el("option", { value: r }, r)));
  analista.value = c.Analista || CONFIG.responsablesPlanta[0];
  const resultado = el("select", {}, ["Conforme", "Con ajustes", "No conforme"].map((x) => el("option", { value: x }, x)));
  resultado.value = c.Resultado || "Conforme";
  const reco = el("textarea", { rows: "3" }, c.Recomendaciones || "");
  const sellado = el("select", {}, [el("option", { value: "" }, "No aplica"), ...["Termosellado", "Cuello de ganso"].map((t) => el("option", { value: t }, t))]);
  sellado.value = c.TipoSellado || "";
  const estadoSel = el("select", {}, [el("option", { value: "" }, "—"), ...["Conforme", "No conforme"].map((x) => el("option", { value: x }, x))]);
  estadoSel.value = c.EstadoSellado || "";
  const btn = el("button", { class: "btn btn-verde btn-xl" }, "Guardar cambios");
  const h = hoja("Editar datos del control", [
    el("div", { class: "campos-2" }, [campo("Parada", parada), campo("Lote", lote)]),
    campo("Equipo dosificando", equipo),
    el("div", { class: "campos-2" }, [campo("Analista", analista), campo("Resultado", resultado)]),
    el("div", { class: "campos-2" }, [campo("Sellado", sellado), campo("Estado del sellado", estadoSel)]),
    campo("Recomendaciones al personal", reco),
    el("p", { class: "nota" }, "Las muestras no se editan aquí: para agregar más usa «Seguir tomando muestras»."),
    btn,
  ]);
  btn.addEventListener("click", async () => {
    if (!parada.value.trim()) return toast("La parada no puede quedar vacía", "err");
    if (sellado.value && !estadoSel.value) return toast("Indica si el sellado es conforme", "err");
    btn.disabled = true;
    await st.editarControl(c, { parada: parada.value.trim(), lote: lote.value.trim(), equipo: equipo.value.trim(), analista: analista.value, resultado: resultado.value, recomendaciones: reco.value.trim(), sellado: sellado.value, estadoSellado: estadoSel.value });
    h.cerrar();
    toast("Control actualizado");
    location.reload();
  });
}

// ---------------- parámetros (solo Sistemas) ----------------

// Se configuran por PRESENTACIÓN (397 g, 250 g, 15 kg…): todos los productos
// de igual peso comparten el rango. Una excepción por producto solo si hace falta.
async function parametros(vista) {
  const cont = el("div", {}, el("div", { class: "cargando" }, "Cargando…"));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: "#/pesos", class: "volver" }, "← Control de pesos"),
        el("h1", { class: "titulo" }, "Parámetros de peso"),
        el("p", { class: "sub" }, "Un rango por presentación: aplica a todos los productos de ese peso. Las excepciones por producto son opcionales."),
      ]),
    ]),
    cont
  );
  const [datos, params, cat] = await Promise.all([st.cargarOF(), st.parametrosPeso(), st.catalogo()]);

  // Productos conocidos: catálogo de liberación + órdenes de Odoo recientes.
  const productos = new Map();
  for (const c of cat) if (c.Title) productos.set(c.Title.toUpperCase(), { codigo: c.Title, producto: c.field_1 || "", cliente: c.field_2 || "" });
  for (const o of datos.ofs || []) if (o.codigo && !/^REP-/i.test(o.codigo)) productos.set(o.codigo.toUpperCase(), { ...(productos.get(o.codigo.toUpperCase()) || {}), codigo: o.codigo, producto: o.producto, of: o });

  // Agrupar por presentación.
  const grupos = new Map();
  for (const p of productos.values()) {
    const pres = st.presentacionEfectiva(p.of || { codigo: p.codigo, producto: p.producto }, params);
    const clave = st.clavePresentacion(pres);
    if (!clave) continue;
    if (!grupos.has(clave)) grupos.set(clave, { clave, pres, productos: [] });
    grupos.get(clave).productos.push(p);
  }
  const deClave = (t) => params.find((x) => (x.Title || "").toUpperCase() === t) || null;
  const esAsig = (x) => x.PesoNominal && x.PesoMinimo == null && x.PesoMaximo == null;
  const esExcepcion = (codigo) => {
    const x = deClave(codigo.toUpperCase());
    return x && !esAsig(x);
  };
  for (const x of params) {
    const t = (x.Title || "").toUpperCase();
    if (t.startsWith("PRESENTACION ") && !grupos.has(t)) grupos.set(t, { clave: t, pres: { nominal: x.PesoNominal, unidad: x.Unidad || "g" }, productos: [] });
  }

  const inp = (v, cls = "in-num") => el("input", { type: "text", inputmode: "decimal", value: v === null || v === undefined ? "" : String(v).replace(".", ","), class: cls });
  const r2 = (x) => String(Math.round(x * 100) / 100).replace(".", ",");
  const conTolerancia = (nominal, tol, min, max) =>
    tol.addEventListener("input", () => {
      const t = aNumero(tol.value);
      const n = aNumero(nominal.value);
      if (t === null || n === null) return;
      min.value = r2(n - (n * t) / 100);
      max.value = r2(n + (n * t) / 100);
    });
  const validar = (etq, n, a, b) => {
    if (!n) return toast(`${etq}: falta el peso nominal`, "err"), false;
    if (a === null || b === null) return toast(`${etq}: falta mínimo o máximo`, "err"), false;
    if (!(a <= n && n <= b)) return toast(`${etq}: debe cumplirse mínimo ≤ nominal ≤ máximo`, "err"), false;
    return true;
  };

  // ---- tabla de presentaciones ----
  const tPres = el("table", { class: "doc-tabla param-peso" }, [
    el("tr", {}, ["Presentación", "Productos", "Nominal", "Tolerancia ±%", "Mínimo", "Máximo", ""].map((x) => el("th", {}, x))),
  ]);
  const ordenados = [...grupos.values()].sort((a, b) => (a.pres.unidad === b.pres.unidad ? a.pres.nominal - b.pres.nominal : a.pres.unidad === "g" ? -1 : 1));
  for (const g of ordenados) {
    const p = deClave(g.clave);
    const u = p?.Unidad || g.pres.unidad;
    const nominal = inp(p?.PesoNominal ?? g.pres.nominal);
    const tol = inp("", "in-num in-tol");
    tol.placeholder = "%";
    const min = inp(p?.PesoMinimo);
    const max = inp(p?.PesoMaximo);
    conTolerancia(nominal, tol, min, max);
    const excepciones = g.productos.filter((x) => esExcepcion(x.codigo));
    const guardar = el("button", { class: `btn ${p ? "btn-sec" : "btn-verde"} btn-mini` }, p ? "Guardar" : "Configurar");
    guardar.addEventListener("click", async () => {
      const n = aNumero(nominal.value);
      const a = aNumero(min.value);
      const b = aNumero(max.value);
      if (!validar(st.etiquetaPresentacion(g.clave), n, a, b)) return;
      guardar.disabled = true;
      await st.guardarParametroPeso({ id: p?.ID, codigo: g.clave, producto: `Presentación ${st.etiquetaPresentacion(g.clave)}`, cliente: "", nominal: n, min: a, max: b, unidad: u });
      guardar.disabled = false;
      guardar.textContent = "Guardado ✓";
      guardar.className = "btn btn-sec btn-mini";
      toast(`Presentación ${st.etiquetaPresentacion(g.clave)} guardada: aplica a ${g.productos.length - excepciones.length} productos`);
    });
    tPres.appendChild(
      el("tr", { class: p ? "" : "sin-config" }, [
        el("td", {}, el("b", { class: "pres" }, `${st.etiquetaPresentacion(g.clave)}`)),
        el("td", { class: "td-prod" }, [
          el("details", {}, [
            el("summary", {}, `${g.productos.length} producto${g.productos.length === 1 ? "" : "s"}${excepciones.length ? ` · ${excepciones.length} con excepción` : ""}`),
            el("ul", { class: "lista-prod" }, g.productos.map((x) => el("li", {}, `${x.codigo} · ${x.producto}${x.cliente ? ` (${x.cliente})` : ""}${esExcepcion(x.codigo) ? " · excepción" : deClave(x.codigo.toUpperCase()) ? " · presentación asignada" : ""}`))),
          ]),
        ]),
        el("td", {}, [nominal, el("small", {}, ` ${u}`)]),
        el("td", {}, tol),
        el("td", {}, min),
        el("td", {}, max),
        el("td", {}, guardar),
      ])
    );
  }

  // ---- excepciones por producto ----
  const exc = params.filter((x) => x.Title && !x.Title.toUpperCase().startsWith("PRESENTACION ") && !esAsig(x));
  const tExc = el("table", { class: "doc-tabla param-peso" }, [el("tr", {}, ["Producto", "Nominal", "Mínimo", "Máximo", "Presentación", ""].map((x) => el("th", {}, x)))]);
  for (const x of exc) {
    const prod = productos.get(x.Title.toUpperCase());
    const clave = st.clavePresentacion(st.presentacionDe(prod?.of || { codigo: x.Title, producto: prod?.producto || x.Producto }));
    const general = clave ? deClave(clave) : null;
    const u = x.Unidad || "g";
    const nominal = inp(x.PesoNominal);
    const min = inp(x.PesoMinimo);
    const max = inp(x.PesoMaximo);
    const guardar = el("button", { class: "btn btn-sec btn-mini" }, "Guardar");
    guardar.addEventListener("click", async () => {
      const n = aNumero(nominal.value);
      const a = aNumero(min.value);
      const b = aNumero(max.value);
      if (!validar(x.Title, n, a, b)) return;
      guardar.disabled = true;
      await st.guardarParametroPeso({ id: x.ID, codigo: x.Title, producto: x.Producto, cliente: x.Cliente, nominal: n, min: a, max: b, unidad: u });
      guardar.disabled = false;
      toast(`${x.Title} guardado`);
    });
    const quitar = el("button", { class: "btn btn-sec btn-mini rojo" }, "Quitar excepción");
    quitar.addEventListener("click", async () => {
      const txt = general
        ? `${x.Title} pasará a usar el rango de su presentación (${st.etiquetaPresentacion(clave)}: ${num(general.PesoMinimo, "")}– ${num(general.PesoMaximo, general.Unidad || "g")}).`
        : `${x.Title} quedará sin rango hasta que configures su presentación${clave ? ` (${st.etiquetaPresentacion(clave)})` : ""}.`;
      if (!(await confirmar("Quitar excepción", txt + " Los controles ya hechos no cambian.", { si: "Quitar", peligro: true }))) return;
      await st.eliminarParametroPeso(x);
      toast("Excepción quitada");
      location.reload();
    });
    tExc.appendChild(
      el("tr", {}, [
        el("td", { class: "td-prod" }, `${x.Title} · ${x.Producto || prod?.producto || ""}`),
        el("td", {}, [nominal, el("small", {}, ` ${u}`)]),
        el("td", {}, min),
        el("td", {}, max),
        el("td", {}, clave ? `${st.etiquetaPresentacion(clave)}${general ? ` (${num(general.PesoMinimo, "")}– ${num(general.PesoMaximo, "")})` : " (sin configurar)"}` : "—"),
        el("td", {}, el("div", { class: "fila-botones izq" }, [guardar, quitar])),
      ])
    );
  }

  // Nueva excepción: elegir un producto.
  const selProd = el("select", {}, [el("option", { value: "" }, "— Elegir producto —"), ...[...productos.values()].filter((x) => !deClave(x.codigo.toUpperCase())).sort((a, b) => a.codigo.localeCompare(b.codigo)).map((x) => el("option", { value: x.codigo }, `${x.codigo} · ${x.producto}`))]);
  const nuevaExc = el("button", { class: "btn btn-sec", type: "button" }, "+ Agregar excepción");
  nuevaExc.addEventListener("click", async () => {
    const x = productos.get((selProd.value || "").toUpperCase());
    if (!x) return toast("Elige un producto", "err");
    const pres = st.presentacionEfectiva(x.of || { codigo: x.codigo, producto: x.producto }, params);
    const general = deClave(st.clavePresentacion(pres) || "");
    await st.guardarParametroPeso({ codigo: x.codigo, producto: x.producto, cliente: x.cliente, nominal: general?.PesoNominal ?? pres?.nominal ?? 0, min: general?.PesoMinimo ?? pres?.nominal ?? 0, max: general?.PesoMaximo ?? pres?.nominal ?? 0, unidad: general?.Unidad || pres?.unidad || "g" });
    toast(`Excepción creada para ${x.codigo}: ajusta su rango`);
    location.reload();
  });

  // ---- presentación asignada a mano ----
  const asignadas = params.filter((x) => x.Title && !x.Title.toUpperCase().startsWith("PRESENTACION ") && esAsig(x));
  const sinPresentacion = [...productos.values()].filter((x) => !st.presentacionEfectiva(x.of || { codigo: x.codigo, producto: x.producto }, params));
  const tAsig = el("table", { class: "doc-tabla param-peso" }, [el("tr", {}, ["Producto", "Presentación", ""].map((x) => el("th", {}, x)))]);
  for (const x of asignadas) {
    const quitar = el("button", { class: "btn btn-sec btn-mini rojo" }, "Quitar");
    quitar.addEventListener("click", async () => {
      if (!(await confirmar("Quitar presentación asignada", `${x.Title} volverá a no tener presentación conocida (la analista la escribirá al iniciar cada control).`, { si: "Quitar", peligro: true }))) return;
      await st.eliminarParametroPeso(x);
      location.reload();
    });
    tAsig.appendChild(el("tr", {}, [el("td", { class: "td-prod" }, `${x.Title} · ${x.Producto || ""}`), el("td", {}, num(x.PesoNominal, x.Unidad || "g")), el("td", {}, quitar)]));
  }
  for (const x of sinPresentacion) {
    const val = el("input", { type: "text", inputmode: "decimal", placeholder: "Ej. 5", class: "in-num" });
    const uni = el("select", {}, ["kg", "g"].map((u) => el("option", { value: u }, u)));
    const asignar = el("button", { class: "btn btn-verde btn-mini" }, "Asignar");
    asignar.addEventListener("click", async () => {
      const n = aNumero(val.value);
      if (!n || n <= 0) return toast(`${x.codigo}: escribe el peso de la presentación`, "err");
      asignar.disabled = true;
      await st.guardarParametroPeso({ codigo: x.codigo, producto: x.producto, cliente: x.cliente, nominal: n, min: null, max: null, unidad: uni.value, notas: "Presentación asignada" });
      toast(`${x.codigo}: presentación ${String(n).replace(".", ",")} ${uni.value}`);
      location.reload();
    });
    tAsig.appendChild(el("tr", { class: "sin-config" }, [el("td", { class: "td-prod" }, `${x.codigo} · ${x.producto}`), el("td", {}, el("div", { class: "fila-botones izq" }, [val, uni])), el("td", {}, asignar)]));
  }

  clear(cont);
  cont.append(
    el("section", { class: "card config" }, [
      el("h2", {}, "Por presentación"),
      el("p", { class: "nota" }, "Escribe la tolerancia ±% y se calculan mínimo y máximo desde el nominal (o escríbelos directo). En amarillo: presentaciones sin configurar. 14 oz se agrupa con 397 g."),
      el("div", { class: "reporte-wrap" }, tPres),
    ]),
    asignadas.length || sinPresentacion.length
      ? el("section", { class: "card config" }, [
          el("h2", {}, "Presentación de productos sin peso en el nombre"),
          el("p", { class: "nota" }, "Productos cuyo nombre no dice el peso y que Odoo tiene «por kilo». Al asignarles la presentación pasan a su grupo y toman su rango. Si no se asigna, la analista escribe el peso al iniciar cada control."),
          el("div", { class: "reporte-wrap" }, tAsig),
        ])
      : null,
    el("section", { class: "card config" }, [
      el("h2", {}, "Excepciones por producto (opcional)"),
      el("p", { class: "nota" }, "Solo para un producto que deba tener un rango distinto al de su presentación. Una excepción tiene prioridad sobre la presentación."),
      exc.length ? el("div", { class: "reporte-wrap" }, tExc) : el("p", { class: "nota" }, "No hay excepciones: todos los productos usan el rango de su presentación."),
      el("div", { class: "fila-botones izq" }, [selProd, nuevaExc]),
    ])
  );
}

// Ícono de balanza (SVG propio, se adapta al color del texto).
export function iconoBalanza(clase = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 64 64");
  s.setAttribute("class", clase);
  s.innerHTML =
    '<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M32 10v40M20 54h24M14 18h36"/><circle cx="32" cy="10" r="3"/>' +
    '<path d="M14 18 6 36h16zM50 18l-8 18h16z"/><path d="M6 36a8 5 0 0 0 16 0M42 36a8 5 0 0 0 16 0"/></g>';
  return s;
}
