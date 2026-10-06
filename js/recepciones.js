// Consulta de recepciones cerradas: lista de los últimos días y el resumen
// completo de cada una (lo que el bodeguero pasa al registro en papel), con
// botón para imprimir y para reenviar el correo.

import { el, clear } from "./dom.js";
import * as st from "./store.js";
import { toast, confirmar, imagen, vacio } from "./ui.js";

export async function lista(vista) {
  const cont = el("div", { class: "ordenes" }, el("div", { class: "cargando" }, "Cargando recepciones…"));
  const buscar = el("input", { type: "search", class: "obs buscar", placeholder: "Buscar proveedor, fruta u orden…" });
  const dias = el("select", { class: "dias" }, [["1", "Hoy"], ["7", "Últimos 7 días"], ["30", "Últimos 30 días"]].map(([v, t]) => el("option", { value: v, ...(v === "7" ? { selected: "" } : {}) }, t)));
  vista.append(
    el("div", { class: "cab" }, [
      el("div", {}, [
        el("a", { href: "#/bodega", class: "volver" }, "← Órdenes"),
        el("h1", { class: "titulo" }, "Recepciones cerradas"),
        el("p", { class: "sub" }, "Resumen de cada recepción para el registro"),
      ]),
      dias,
    ]),
    buscar,
    cont
  );
  let filas = [];
  const pintar = () => {
    const q = st.norm(buscar.value);
    const vis = filas.filter((r) => !q || st.norm(`${r.Proveedor} ${r.Fruta} ${r.ID_1}`).includes(q));
    clear(cont);
    if (!vis.length) return vacio(cont, "No hay recepciones cerradas en ese período.");
    for (const r of vis) {
      cont.appendChild(
        el("a", { class: "orden cerrada", href: `#/bodega/ver/${r.ID}` }, [
          el("div", { class: "orden-info" }, [
            el("strong", { class: "orden-prov" }, (r.Proveedor || "").trim()),
            el("span", { class: "orden-fruta" }, r.Fruta),
            el("span", { class: "orden-fecha" }, `Cerrada ${st.fmtFecha(r.HoraCierre)} · #${r.ID_1}${r.Bodeguero ? ` · ${r.Bodeguero}` : ""}`),
          ]),
          el("div", { class: "orden-cant" }, [el("b", {}, st.fmtKg(r.TotalNeto)), el("small", {}, "KG neto")]),
          el("div", { class: "orden-accion" }, el("span", { class: "btn btn-sec" }, "Ver resumen")),
        ])
      );
    }
  };
  async function cargar() {
    cont.replaceChildren(el("div", { class: "cargando" }, "Cargando recepciones…"));
    try {
      filas = await st.listarRecepcionesCerradas(Number(dias.value));
    } catch (e) {
      return vacio(cont, "No se pudo leer SharePoint: " + e.message);
    }
    pintar();
  }
  buscar.addEventListener("input", pintar);
  dias.addEventListener("change", cargar);
  cargar();
}

export async function detalle(vista, id) {
  vista.appendChild(el("div", { class: "cargando" }, "Cargando resumen…"));
  let d;
  try {
    d = await st.detalleRecepcion(id);
  } catch (e) {
    return vacio(vista, "No se pudo leer SharePoint: " + e.message);
  }
  clear(vista);
  if (!d) return vacio(vista, "Recepción no encontrada.");
  const { rec, orden, liberacion, pallets } = d;
  const kg = (n) => (n === null || n === undefined ? "—" : `${st.fmtKg(n)} kg`);
  const fila = (k, v) => el("div", { class: "dato" }, [el("span", {}, k), el("b", {}, v ?? "—")]);

  const sumBruto = pallets.reduce((a, p) => a + (+p.bruto || 0), 0);
  const sumNeto = pallets.reduce((a, p) => a + (+p.neto || 0), 0);
  const sumEnv = pallets.reduce((a, p) => a + (+p.envases || 0), 0);
  const prog = orden?.CantidadProgramada;
  const dif = prog ? (rec.TotalNeto ?? 0) - prog : null;

  let envio;
  if (d.pendiente) envio = el("span", { class: "estado estado-ambar" }, "Pendiente de subir: el correo sale al conectarse");
  else if (!rec.Correo) envio = el("span", { class: "estado estado-ambar" }, "Sin correo de proveedor registrado");
  else envio = el("span", { class: "estado estado-verde" }, `Resumen enviado a ${rec.Correo}`);

  const lib = liberacion;
  const libEstado = lib ? lib.Estado : orden?.Estado_calidad || "Sin liberación registrada";

  vista.append(
    el("div", { class: "no-print acciones-resumen" }, [
      el("a", { href: "#/bodega/recepciones", class: "volver" }, "← Recepciones cerradas"),
      el("div", { class: "fila-botones" }, [
        el("button", {
          class: "btn btn-sec",
          onclick: async () => {
            if (!(await confirmar("Reenviar resumen", `Se vuelve a enviar el correo a ${rec.Correo || "(sin correo)"} y a los responsables internos.`, { si: "Reenviar" }))) return;
            await st.reenviarResumen(rec);
            toast("Reenvío solicitado: el correo sale en 1-2 minutos");
          },
        }, "✉ Reenviar correo"),
        el("button", { class: "btn btn-azul", onclick: () => window.print() }, "🖨 Imprimir"),
      ]),
    ]),
    el("article", { class: "resumen-doc" }, [
      el("header", { class: "doc-cab" }, [
        el("img", { src: "icons/logo.png", alt: "Healthy Food" }),
        el("div", {}, [el("h1", {}, "Resumen de recepción de fruta"), el("span", {}, `Orden #${rec.ID_1} · ${rec.Title || ""}`)]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Datos generales"),
        el("div", { class: "datos" }, [
          fila("Proveedor", (rec.Proveedor || "").trim()),
          fila("Fruta", rec.Fruta),
          fila("Fecha programada", orden ? st.fmtFecha(orden.FechaProgramada) : "—"),
          fila("Cantidad programada", prog != null ? `${st.fmtKg(prog)} ${orden.Unidad || "KG"}` : "—"),
          fila("Llegada", st.fmtFecha(rec.HoraLlegada)),
          fila("Cierre", st.fmtFecha(rec.HoraCierre)),
          fila("Conductor", rec.Conductor),
          fila("Placa", rec.Placa),
          fila("Bodeguero", rec.Bodeguero),
          fila("Registrado por", rec.Operario),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Liberación de Calidad"),
        lib
          ? el("div", { class: "datos" }, [
              fila("Estado", lib.Estado),
              fila("°Brix", String(lib.OData__x00b0_Brix ?? "—")),
              fila("pH", String(lib.PH ?? "—")),
              fila("Acidez", String(lib.Acidez ?? "—")),
              fila("Analista", lib.Operario),
              fila("Fecha", st.fmtFecha(lib.HoraCierre || lib.Created)),
            ])
          : el("div", { class: "aviso" }, `No hay registro de liberación para la orden #${rec.ID_1} (estado de calidad en la orden: ${libEstado}).`),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Totales"),
        el("div", { class: "datos" }, [
          fila("Neto recibido", kg(rec.TotalNeto)),
          fila("Neto pesado (suma de pallets)", kg(sumNeto)),
          fila("Bruto", kg(rec.TotalBruto ?? sumBruto)),
          fila("Tara total", kg(rec.TotalTara)),
          fila("Pallets", String(pallets.length)),
          fila("Envases", String(sumEnv)),
          fila("Faltante (−) / excedente (+)", dif === null ? "—" : `${dif > 0 ? "+" : ""}${st.fmtKg(dif)} kg`),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Detalle de pallets"),
        el("table", { class: "doc-tabla" }, [
          el("tr", {}, ["N°", "Foto", "Bruto kg", "Envases", "Peso env. kg", "Tara pallet", "Neto kg", "Hora", "Obs."].map((x) => el("th", {}, x))),
          ...pallets.map((p) =>
            el("tr", {}, [
              el("td", {}, String(p.numero ?? "")),
              el("td", {}, p.fotoRemota ? imagen({ remota: p.fotoRemota }, "doc-foto") : "—"),
              el("td", {}, st.fmtKg(p.bruto)),
              el("td", {}, String(p.envases || 0)),
              el("td", {}, st.fmtKg(p.pUnit)),
              el("td", {}, st.fmtKg(p.taraPallet)),
              el("td", {}, st.fmtKg(p.neto)),
              el("td", {}, st.fmtHora(p.hora)),
              el("td", {}, p.obs || ""),
            ])
          ),
        ]),
      ]),
      el("section", { class: "doc-sec" }, [
        el("h2", {}, "Comentarios"),
        el("p", {}, rec.ObservacionesProveedor || "—"),
      ]),
      el("section", { class: "doc-sec doc-firma" }, [
        el("h2", {}, "Firma del proveedor"),
        rec.FirmaProveedor ? imagen({ remota: { lista: "recepciones", id: rec.ID, valor: rec.FirmaProveedor } }, "firma-img") : el("p", {}, "Sin firma"),
      ]),
      el("section", { class: "doc-sec no-print" }, [el("h2", {}, "Correo"), envio]),
    ])
  );
}
