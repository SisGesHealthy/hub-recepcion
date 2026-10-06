// Bodega: órdenes liberadas por Calidad → recepción pallet por pallet → cierre
// con firma. Reemplaza las pantallas "Órdenes de recepción", "Recepción en
// proceso", "Nuevo pallet" y "Resumen de recepción" de la Power App.

import { CONFIG } from "./config.js";
import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { kv } from "./db.js";
import { toast, hoja, confirmar, comprimirFoto, imagen, panelFirma, campoNum, vacio } from "./ui.js";

let timer = null;

export function render(vista, resto) {
  clearInterval(timer);
  if (resto[0] === "rec" && resto[1]) return pantallaRecepcion(vista, Number(resto[1]));
  return pantallaOrdenes(vista);
}

// ---------------- lista de órdenes ----------------

async function pantallaOrdenes(vista) {
  const lista = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando órdenes…"));
  const aviso = el("div", { class: "aviso hidden" });
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [el("h1", { class: "titulo" }, "Órdenes de recepción"), el("p", { class: "sub" }, "Se habilitan cuando Calidad libera la fruta")]),
      el("button", { class: "btn btn-sec", onclick: () => cargar() }, "↻ Actualizar"),
    ]),
    aviso,
    lista
  );

  async function cargar() {
    const [{ rows, offline }, enProceso, locales] = await Promise.all([st.listarOrdenes(), st.recepcionesEnProceso(), st.listarRecepcionesLocales()]);
    const localPorIdn = new Map(locales.map((r) => [r.idn, r]));
    aviso.className = offline ? "aviso" : "aviso hidden";
    aviso.textContent = offline ? "Sin conexión: mostrando la última lista descargada. Lo que registres se sube al volver la señal." : "";
    const vivas = rows.filter((o) => o.Estado === "Programada");
    const g = st.clasificarOrdenes(vivas);
    clear(lista);
    if (!vivas.length) return vacio(lista, "No hay órdenes programadas.");
    const tarjeta = (o) => tarjetaOrden(o, localPorIdn.get(st.idnDe(o)), enProceso.has(st.idnDe(o)));
    if (g.hoy.length) lista.append(el("h3", { class: "grupo" }, `Hoy · ${g.hoy.length}`), ...g.hoy.map(tarjeta));
    if (g.proximas.length) lista.append(el("h3", { class: "grupo" }, `Próximas · ${g.proximas.length}`), ...g.proximas.map(tarjeta));
    if (g.atrasadas.length) {
      const det = el("details", { class: "atrasadas" }, [
        el("summary", {}, `Atrasadas (más de ${CONFIG.diasAtraso} días sin recibir) · ${g.atrasadas.length}`),
        el("p", { class: "nota" }, "Si ya no van a llegar, Compras debe marcarlas como Canceladas para que no se acumulen aquí."),
        ...g.atrasadas.map(tarjeta),
      ]);
      lista.append(det);
    }
  }
  await cargar();
  // Se refresca sola: cuando Calidad libera, el botón se activa sin tocar nada.
  timer = setInterval(() => document.body.contains(lista) && cargar(), 45000);
}

function tarjetaOrden(o, local, enServidor) {
  const cal = o.Estado_calidad || "Pendiente";
  const idn = st.idnDe(o);
  let accion;
  if (local || enServidor) {
    const n = local?.pallets.length;
    accion = el("a", { class: "btn btn-azul", href: `#/bodega/rec/${idn}` }, n ? `Continuar · ${n} pallet${n > 1 ? "s" : ""}` : "Continuar recepción");
  } else if (cal === "Liberado") {
    accion = el("button", { class: "btn btn-verde", onclick: (e) => iniciar(o, e.currentTarget) }, "Iniciar recepción");
  } else if (cal === "Rechazado") {
    accion = el("span", { class: "estado estado-rojo" }, "Rechazada por Calidad");
  } else {
    accion = el("span", { class: "estado estado-ambar" }, "Esperando liberación de Calidad");
  }
  return el("article", { class: `orden cal-${cal.toLowerCase()}` }, [
    el("div", { class: "orden-info" }, [
      el("strong", { class: "orden-prov" }, o.Proveedor?.trim()),
      el("span", { class: "orden-fruta" }, o.Fruta),
      el("span", { class: "orden-fecha" }, `${st.fmtFecha(o.FechaProgramada)} · #${idn}`),
    ]),
    el("div", { class: "orden-cant" }, [el("b", {}, st.fmtKg(o.CantidadProgramada)), el("small", {}, o.Unidad || "KG")]),
    el("div", { class: "orden-accion" }, accion),
  ]);
}

async function iniciar(orden, btn) {
  btn.disabled = true;
  btn.textContent = "Abriendo…";
  const previa = await st.recepcionPrevia(orden);
  let elegida = null;
  if (previa) {
    elegida = await elegirPrevia(previa);
    if (!elegida) {
      btn.disabled = false;
      btn.textContent = "Iniciar recepción";
      return;
    }
  }
  await st.iniciarRecepcion(orden, elegida === "continuar" ? previa : null);
  location.hash = `#/bodega/rec/${st.idnDe(orden)}`;
}

// La orden volvió a "Programada" pero ya tiene una recepción cerrada:
// lo normal es seguir agregando pallets a esa misma recepción.
function elegirPrevia(previa) {
  return new Promise((resolve) => {
    let r = null;
    const it = previa.item;
    const h = hoja(
      "Esta orden ya tiene una recepción cerrada",
      [
        el("p", {}, [
          `Recepción del ${st.fmtFecha(it.HoraLlegada)} · `,
          el("b", {}, `${previa.pallets.length} pallet${previa.pallets.length === 1 ? "" : "s"} · ${st.fmtKg(previa.neto)} kg`),
        ]),
        el("button", { class: "btn btn-azul btn-xl", onclick: () => ((r = "continuar"), h.cerrar()) }, "Continuar esa recepción y agregar pallets"),
        el("p", { class: "nota" }, "Los pallets nuevos siguen la numeración y, al finalizar, se recalculan los totales y se reenvía el resumen completo."),
        el("button", { class: "btn btn-sec btn-xl", onclick: () => ((r = "nueva"), h.cerrar()) }, "Es otra entrega: empezar una recepción nueva"),
      ],
      { ancho: 520, onCerrar: () => resolve(r) }
    );
  });
}

// ---------------- recepción en proceso ----------------

async function pantallaRecepcion(vista, idn) {
  let rec = await st.getRecepcionLocal(idn);
  if (!rec) {
    const orden = (await kv.get("cache:ordenes", [])).find((o) => st.idnDe(o) === idn);
    if (!orden) {
      vacio(vista, "No se encontró la orden. Vuelve a la lista y actualiza.");
      return;
    }
    rec = await st.iniciarRecepcion(orden);
  }
  const o = rec.orden;
  const tara = await st.getTaraRecordada(o);

  // --- cabecera + avance ---
  const barra = el("div", { class: "avance-barra" }, el("div", { class: "avance-fill" }));
  const avanceTxt = el("div", { class: "avance-txt" });
  const cab = el("section", { class: "rec-cab" }, [
    el("a", { href: "#/bodega", class: "volver" }, "← Órdenes"),
    el("div", { class: "rec-titulo" }, [
      el("h1", {}, o.Proveedor?.trim()),
      el("span", {}, `${o.Fruta} · #${idn} · inicio ${rec.reabierta ? st.fmtFecha(rec.inicio) : st.fmtHora(rec.inicio)}`),
      rec.reabierta ? el("span", { class: "estado estado-ambar chip-reabierta" }, "Reabierta") : null,
    ]),
    el("div", { class: "avance" }, [avanceTxt, barra]),
  ]);

  // --- formulario de pallet (en la misma pantalla, sin cambiar de vista) ---
  let fotoBlob = null;
  let editando = null;
  const fileInput = el("input", { type: "file", accept: "image/*", capture: "environment", class: "hidden" });
  const fotoBox = el("button", { type: "button", class: "foto-box", onclick: () => fileInput.click() }, el("span", {}, "📷  Tomar foto del pallet"));
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    fotoBox.classList.add("cargando");
    fotoBlob = await comprimirFoto(f);
    clear(fotoBox);
    fotoBox.classList.remove("cargando");
    fotoBox.appendChild(el("img", { src: URL.createObjectURL(fotoBlob), alt: "Foto del pallet" }));
    fotoBox.classList.add("con-foto");
    fileInput.value = "";
    bruto.input.focus();
  });

  const netoVivo = el("div", { class: "neto-vivo" });
  const recalcular = () => {
    const n = st.calcNeto({ bruto: bruto.val(), taraPallet: taraP.val(), envases: env.val(), pUnit: pu.val() });
    const tEnv = (env.val() || 0) * (pu.val() || 0);
    netoVivo.innerHTML = "";
    netoVivo.append(
      el("span", {}, "Peso neto"),
      el("b", { class: n < 0 ? "neg" : "" }, `${st.fmtKg(n)} kg`),
      el("small", {}, tEnv ? `tara envases ${st.fmtKg(tEnv)} kg${taraP.val() ? ` + pallet ${st.fmtKg(taraP.val())} kg` : ""}` : "sin tara")
    );
  };
  const bruto = campoNum("Peso bruto", { sufijo: "kg", oninput: recalcular });
  const env = campoNum("N° envases", { paso: "1", oninput: recalcular });
  const pu = campoNum("Peso por envase", { valor: tara.pUnit || "", sufijo: "kg", oninput: recalcular });
  const taraP = campoNum("Tara pallet", { valor: tara.taraPallet || "", sufijo: "kg", oninput: recalcular });
  const obs = el("input", { type: "text", class: "obs", placeholder: "Observación (opcional)" });
  const btnGuardar = el("button", { class: "btn btn-verde btn-xl", type: "submit" }, "Guardar pallet");
  const btnCancelarEd = el("button", { class: "btn btn-sec hidden", type: "button", onclick: () => limpiarForm() }, "Cancelar edición");
  const tituloForm = el("h2", {}, "Nuevo pallet");

  const form = el("form", { class: "pallet-form", novalidate: "" }, [
    tituloForm,
    fotoBox,
    fileInput,
    el("div", { class: "campos-grid" }, [bruto.wrap, env.wrap, pu.wrap, el("details", { class: "tara-pallet" }, [el("summary", {}, "Tara de pallet"), taraP.wrap])]),
    netoVivo,
    obs,
    el("div", { class: "fila-botones" }, [btnCancelarEd, btnGuardar]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const datos = { bruto: bruto.val(), envases: env.val() || 0, pUnit: pu.val() || 0, taraPallet: taraP.val() || 0, obs: obs.value.trim() };
    if (!editando && !fotoBlob) return toast("Falta la foto del pallet", "err");
    if (!datos.bruto || datos.bruto <= 0) {
      bruto.input.focus();
      return toast("Ingresa el peso bruto", "err");
    }
    if (st.calcNeto(datos) <= 0) return toast("El neto queda en cero o negativo: revisa envases y peso por envase", "err");
    btnGuardar.disabled = true;
    const p = await st.guardarPallet(rec, editando ? { ...datos, idLocal: editando } : datos, fotoBlob);
    btnGuardar.disabled = false;
    toast(editando ? `Pallet ${p.numero} actualizado` : `Pallet ${p.numero} guardado · ${st.fmtKg(p.neto)} kg`);
    limpiarForm();
    pintarPallets();
  });

  function limpiarForm() {
    editando = null;
    fotoBlob = null;
    clear(fotoBox);
    fotoBox.className = "foto-box";
    fotoBox.appendChild(el("span", {}, "📷  Tomar foto del pallet"));
    bruto.input.value = "";
    env.input.value = "";
    obs.value = "";
    // peso por envase y tara se mantienen: casi siempre son iguales en toda la carga
    tituloForm.textContent = `Pallet ${rec.pallets.length + 1}`;
    btnGuardar.textContent = "Guardar pallet";
    btnCancelarEd.classList.add("hidden");
    recalcular();
  }

  function editar(p) {
    editando = p.idLocal;
    tituloForm.textContent = `Editando pallet ${p.numero}`;
    btnGuardar.textContent = "Guardar cambios";
    btnCancelarEd.classList.remove("hidden");
    bruto.input.value = p.bruto;
    env.input.value = p.envases || "";
    pu.input.value = p.pUnit || "";
    taraP.input.value = p.taraPallet || "";
    obs.value = p.obs || "";
    fotoBlob = null;
    clear(fotoBox);
    fotoBox.className = "foto-box con-foto";
    fotoBox.appendChild(imagenPallet(p));
    recalcular();
    form.scrollIntoView({ behavior: "smooth" });
  }

  // --- pallets registrados ---
  const listaPallets = el("div", { class: "pallets" });
  const btnFin = el("button", { class: "btn btn-azul btn-xl", onclick: () => cierre(rec) }, "Finalizar recepción");
  const btnCancelar = el("button", {
    class: "btn btn-sec cancelar-rec",
    onclick: async () => {
      const txt = rec.reabierta
        ? "La recepción vuelve a quedar cerrada como estaba, sin reenviar el resumen."
        : "Se quita la recepción vacía y la orden vuelve a mostrar \"Iniciar recepción\".";
      if (!(await confirmar("Cancelar esta recepción", txt, { si: "Cancelar recepción", no: "Volver", peligro: true }))) return;
      await st.cancelarRecepcionVacia(rec);
      toast("Recepción cancelada");
      location.hash = "#/bodega";
    },
  }, rec.reabierta ? "No agregar nada: dejarla cerrada" : "Cancelar recepción (abierta por error)");

  async function pintarPallets() {
    const t = st.totales(rec);
    const pct = t.programado ? Math.min(100, (t.neto / t.programado) * 100) : 0;
    barra.firstChild.style.width = pct + "%";
    barra.classList.toggle("exceso", t.desvio > CONFIG.toleranciaCantidad);
    clear(avanceTxt);
    avanceTxt.append(
      el("b", {}, `${st.fmtKg(t.neto)} kg`),
      el("span", {}, ` de ${st.fmtKg(t.programado)} programados · ${t.n} pallet${t.n === 1 ? "" : "s"} · ${t.restante > 0 ? `faltan ${st.fmtKg(t.restante)} kg` : `excede ${st.fmtKg(-t.restante)} kg`}`)
    );
    clear(listaPallets);
    btnFin.disabled = !rec.pallets.length;
    btnCancelar.classList.toggle("hidden", !st.puedeCancelar(rec));
    if (!rec.pallets.length) {
      listaPallets.appendChild(el("div", { class: "vacio chico" }, "Aún no hay pallets. Toma la foto y pesa el primero."));
      return;
    }
    for (const p of [...rec.pallets].reverse()) {
      listaPallets.appendChild(
        el("div", { class: "pallet" }, [
          imagenPallet(p, "pallet-foto"),
          el("div", { class: "pallet-num" }, `#${p.numero}`),
          el("div", { class: "pallet-datos" }, [
            el("b", {}, `${st.fmtKg(p.neto)} kg neto`),
            el("small", {}, `Bruto ${st.fmtKg(p.bruto)} · ${p.envases || 0} env × ${st.fmtKg(p.pUnit)} kg${p.taraPallet ? ` · pallet ${st.fmtKg(p.taraPallet)}` : ""}`),
            p.obs ? el("small", { class: "pallet-obs" }, p.obs) : null,
          ]),
          el("button", { class: "icon-btn", title: "Editar", onclick: () => editar(p) }, "✎"),
          el("button", {
            class: "icon-btn rojo",
            title: "Eliminar",
            onclick: async () => {
              if (await confirmar(`Eliminar pallet ${p.numero}`, `${st.fmtKg(p.neto)} kg neto. Esta acción no se puede deshacer.`, { si: "Eliminar", peligro: true })) {
                await st.eliminarPallet(rec, p.idLocal);
                pintarPallets();
              }
            },
          }, "🗑"),
        ])
      );
    }
  }

  vista.append(
    cab,
    el("div", { class: "rec-grid" }, [
      el("section", { class: "card" }, form),
      el("section", { class: "card" }, [el("h2", {}, "Pallets registrados"), listaPallets, el("div", { class: "fin-wrap" }, [btnFin, btnCancelar])]),
    ])
  );
  limpiarForm();
  pintarPallets();
}

function imagenPallet(p, clase = "") {
  if (p.fotoLocal) {
    const img = el("img", { class: clase, alt: "" });
    import("./db.js").then(async ({ idb }) => {
      const r = await idb.get("blobs", p.fotoLocal);
      if (r) img.src = URL.createObjectURL(r.blob);
    });
    return img;
  }
  if (p.fotoRemota) return imagen({ remota: p.fotoRemota }, clase);
  return el("div", { class: `${clase} sin-foto` }, "sin foto");
}

// ---------------- cierre ----------------

async function cierre(rec) {
  const t = st.totales(rec);
  const o = rec.orden;
  const hist = (await st.historialProveedores())[st.norm(o.Proveedor)] || {};
  const ultimoBod = await kv.get("ultimoBodeguero", "");

  const correo = el("input", { type: "email", inputmode: "email", value: hist.correo || "", placeholder: "correo@proveedor.com", autocomplete: "off" });
  const sug = el("div", { class: "sugerencia hidden" });
  const validarCorreo = () => {
    const s = st.sugerirCorreo(correo.value);
    sug.className = s ? "sugerencia" : "sugerencia hidden";
    clear(sug);
    if (s) sug.append("¿Quisiste decir ", el("button", { type: "button", onclick: () => ((correo.value = s), validarCorreo()) }, s), "?");
  };
  correo.addEventListener("input", validarCorreo);
  const conductor = el("input", { type: "text", value: hist.conductor || "", placeholder: "Nombre del conductor" });
  const placa = el("input", { type: "text", value: hist.placa || "", placeholder: "ABC-1234", style: "text-transform:uppercase" });
  const bodeguero = el("select", {}, [el("option", { value: "" }, "— Elegir —"), ...CONFIG.bodegueros.map((b) => el("option", { value: b, ...(b === ultimoBod ? { selected: "" } : {}) }, b))]);
  const fruta = o.Fruta.split("-")[0].trim().toLowerCase();
  const obs = el("textarea", { rows: "2" }, `Se reciben ${t.envases ? `${t.envases} envases` : `${t.n} pallets`} de ${fruta}.`);
  const firma = panelFirma();
  const desvioPct = Math.round(t.desvio * 100);

  const f = (label, input, extra) => el("label", { class: "campo" }, [el("span", { class: "campo-label" }, label), input, extra || null]);
  const btn = el("button", { class: "btn btn-azul btn-xl" }, "Cerrar recepción y enviar resumen");
  const h = hoja(
    "Resumen de recepción",
    [
      el("div", { class: "resumen-tot" }, [
        el("div", {}, [el("small", {}, "Neto recibido"), el("b", {}, `${st.fmtKg(t.neto)} kg`)]),
        el("div", {}, [el("small", {}, "Bruto"), el("b", {}, `${st.fmtKg(t.bruto)} kg`)]),
        el("div", {}, [el("small", {}, "Tara"), el("b", {}, `${st.fmtKg(t.tara)} kg`)]),
        el("div", {}, [el("small", {}, "Pallets"), el("b", {}, String(t.n))]),
      ]),
      Math.abs(t.desvio) > CONFIG.toleranciaCantidad
        ? el("div", { class: "aviso" }, `Ojo: lo recibido difiere ${desvioPct > 0 ? "+" : ""}${desvioPct}% de lo programado (${st.fmtKg(t.programado)} kg).`)
        : null,
      el("div", { class: "campos-2" }, [
        f("Correo del proveedor", correo, sug),
        f("Bodeguero", bodeguero),
        f("Conductor", conductor),
        f("Placa", placa),
      ]),
      f("Comentarios de la recepción", obs),
      firma.nodo,
      btn,
    ],
    { ancho: 720 }
  );

  btn.addEventListener("click", async () => {
    const c = correo.value.trim().toLowerCase();
    if (!st.correoValido(c)) return toast("Correo del proveedor no válido", "err");
    if (st.sugerirCorreo(c) && !(await confirmar("¿Correo correcto?", `"${c}" parece tener un error. ¿Enviar igual a esa dirección?`, { si: "Sí, es correcto", no: "Corregir" }))) return;
    if (!bodeguero.value) return toast("Elige el bodeguero", "err");
    if (!conductor.value.trim()) return toast("Falta el conductor", "err");
    if (firma.vacio()) return toast("Falta la firma del proveedor", "err");
    btn.disabled = true;
    btn.textContent = "Guardando…";
    await st.finalizarRecepcion(
      rec,
      { correo: c, conductor: conductor.value.trim(), placa: placa.value.trim().toUpperCase(), bodeguero: bodeguero.value, observaciones: obs.value.trim() },
      await firma.blob()
    );
    h.cerrar();
    toast(`Recepción cerrada · ${st.fmtKg(t.neto)} kg. El resumen se envía a ${c}`);
    location.hash = "#/bodega";
  });
}
