// Modo demo: misma interfaz que sp.js, guardando en IndexedDB del
// dispositivo. Los datos de ejemplo copian la forma real de las listas
// (mismos nombres de propiedad, mismo código ID_N) para que lo que se pruebe
// aquí se comporte igual contra SharePoint.

import { idb, kv } from "./db.js";

const S = (lista) => "m_" + lista;

function cumple(item, [c, op, v]) {
  let a = item[c];
  let b = v;
  if (b instanceof Date) {
    a = a ? new Date(a).getTime() : null;
    b = b.getTime();
  }
  switch (op) {
    case "eq": return a === b;
    case "ne": return a !== b;
    case "ge": return a !== null && a !== undefined && a >= b;
    case "le": return a !== null && a !== undefined && a <= b;
    case "gt": return a !== null && a !== undefined && a > b;
    case "lt": return a !== null && a !== undefined && a < b;
  }
  return true;
}

async function nextId(lista) {
  const k = "mockseq:" + lista;
  const n = (await kv.get(k, 1000)) + 1;
  await kv.set(k, n);
  return n;
}

export const api = {
  async items(lista, { where = [], orderby, top = 5000 } = {}) {
    let rows = (await idb.getAll(S(lista))).filter((it) => where.every((w) => cumple(it, w)));
    if (orderby) {
      const [campo, dir] = orderby.split(" ");
      rows.sort((x, y) => (x[campo] > y[campo] ? 1 : x[campo] < y[campo] ? -1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return rows.slice(0, top);
  },
  async add(lista, campos) {
    const ID = await nextId(lista);
    const item = { ...campos, ID, Created: new Date().toISOString() };
    await idb.put(S(lista), item);
    return item;
  },
  async update(lista, id, campos) {
    const it = await idb.get(S(lista), id);
    if (!it) throw new Error(`Ítem ${id} no existe en ${lista}`);
    await idb.put(S(lista), { ...it, ...campos });
  },
  async remove(lista, id) {
    await idb.delete(S(lista), id);
  },
  async attachImage(lista, id, campo, blob) {
    const key = `img:${lista}:${id}:${campo}`;
    await idb.put("blobs", { id: key, blob });
    await this.update(lista, id, { [campo]: JSON.stringify({ mockKey: key }) });
    return key;
  },
  imageUrl(lista, id, valor) {
    try {
      return JSON.parse(valor).mockKey || null;
    } catch {
      return null;
    }
  },
  async leerTexto() {
    return "demo";
  },
  async propiedadDeCampo(lista, nombre) {
    return nombre;
  },
  async fetchImage(key) {
    const r = await idb.get("blobs", key);
    if (!r) throw new Error("sin imagen");
    return r.blob;
  },
};

// ---------- datos de ejemplo ----------

function hoyA(h, m = 0, diasDelta = 0) {
  const d = new Date();
  d.setDate(d.getDate() + diasDelta);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function idn(n, diasDelta = 0) {
  const d = new Date();
  d.setDate(d.getDate() + diasDelta);
  return Number(`${n}${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`);
}

export async function sembrarDemo() {
  if (await kv.get("demoSembrado")) return;
  const ordenes = [
    ["CampoVivo", "MARACUYA-MP00014", 1200, 7, 0, 1, "Liberado"],
    ["Yoffre Noguera", "MARACUYA-MP00014", 13000, 6, 30, 2, "Liberado"],
    ["Luis Silva", "MORA DE CASTILLA-MP00016", 400, 9, 30, 3, "Pendiente"],
    ["Cesar Lisintuña", "MORA CATEGORIA 1-MP00242", 250, 11, 0, 4, "Pendiente"],
    ["Pedro Diaz", "MOTA GUANÁBANA-MP00028", 1100, 13, 0, 5, "Rechazado"],
    ["Marlene Chavez", "NARANJILLA-MP00019", 2000, 15, 30, 6, "Pendiente"],
  ];
  for (const [prov, fruta, cant, h, m, n, cal] of ordenes) {
    await api.add("ordenes", {
      Title: null, Proveedor: prov, Fruta: fruta, CantidadProgramada: cant, Unidad: "KG",
      EmailBodega: "bodega@healthyfood.com.ec", FechaProgramada: hoyA(h, m), Estado: "Programada",
      OData__x0049_D2: idn(n), Estado_calidad: cal,
    });
  }
  // Una orden atrasada (como las de agosto que hoy siguen en la lista).
  await api.add("ordenes", {
    Proveedor: "Pedro Diaz", Fruta: "TAMARINDO-MP00027", CantidadProgramada: 1800, Unidad: "KG",
    FechaProgramada: hoyA(8, 30, -40), Estado: "Programada", OData__x0049_D2: idn(1, -40), Estado_calidad: "Liberado",
  });
  // Historial: recepciones pasadas → correo/conductor/placa sugeridos.
  const hist = [
    ["CampoVivo", "Yoffre_noguera@hotmail.com", "Yoffre Noguera", "PCH-6490"],
    ["Yoffre Noguera", "yoffre_noguera@hotmail.com", "Jofe Noguera", "PCH-6490"],
    ["Luis Silva", "luissilv1984@gmail.com", "Luis Silva", "PBX-1123"],
    ["Pedro Diaz", "macanchamine2@hotmail.com", "Adonis Romero", "PFV-7054"],
  ];
  for (const [prov, correo, cond, placa] of hist) {
    await api.add("recepciones", {
      Title: "Recepción histórica", Proveedor: prov, Fruta: "MARACUYA-MP00014", Correo: correo, Conductor: cond,
      Placa: placa, Estado: "Finalizada", EstadoAnterior: "Finalizada", ID_1: 1, HoraLlegada: hoyA(9, 0, -7),
    });
  }
  // Liberaciones previas de la misma fruta (referencia para Calidad).
  for (const [bx, ph, ac, d] of [[13.8, 2.91, 3.41, -3], [14.2, 3.05, 3.3, -6], [9.1, 3.1, 2.4, -9]]) {
    await api.add("liberaciones", {
      Title: "Liberación demo", ID_1: 1, Proveedor: "Luis Silva", Fruta: d === -9 ? "MORA DE CASTILLA-MP00016" : "MARACUYA-MP00014",
      Estado: "Liberado", OData__x00b0_Brix: bx, PH: ph, Acidez: ac, HoraLlegada: hoyA(8, 0, d), HoraCierre: hoyA(8, 5, d),
      Operario: "Analista Calidad Healthy Food",
    });
  }
  // Calidad - Planta: catálogo + lotes + algunas paradas.
  const cat = [
    ["PTEC002", "PULPA DE GUANABANA GOYA USA UNIDAD 397 g", "GOYA USA", 11, 16, 3.3, 4.2, 0.6, 1.2, null, null],
    ["PTEC014", "PULPA DE MORA 150 g", "AXIONLOG ECUADOR S.A", 6, 10, 2.8, 3.6, 1.5, 2.6, null, null],
    ["PTEC015", "PULPA DE MARACUYA 150 g", "AXIONLOG ECUADOR S.A", 12, 16, 2.7, 3.4, 3, 5, null, null],
  ];
  const catIds = [];
  for (const [cod, nom, cli, b1, b2, p1, p2, a1, a2, r1, r2] of cat) {
    const it = await api.add("catalogo", {
      Title: cod, field_1: nom, field_2: cli, field_3: b1, field_4: b2, field_5: p1, field_6: p2,
      field_7: a1, field_8: a2, field_9: r1, field_10: r2, Ordenamiento: `${cli}  - ${nom} - ${cli}`,
    });
    catIds.push(it.ID);
  }
  const lotes = [["HF PB 265 26", 0], ["L2782615", 1], ["L2722615", 2]];
  for (const [t, i] of lotes) {
    await api.add("lotes", {
      Title: t, field_2: hoyA(0, 0, -1), field_3: hoyA(0, 0, 730), field_4: "Programado",
      Producto_x002d_CODId: catIds[i], Fechadeproducci_x00f3_n: hoyA(0, 0),
    });
  }
  for (const [n, bx, ph, ac] of [[1, 13.5, 3.56, 0.89], [2, 12.6, 3.75, 0.96]]) {
    await api.add("registros", {
      Title: "HF PB 265 26", field_1: n, field_2: bx, field_3: ph, field_4: ac, field_8: bx / ac, field_9: "ET",
      Repeticion: false, Fecha_produccion: hoyA(0, 0), COD_Producto: `GOYA USA  - ${cat[0][1]} - GOYA USA`,
    });
  }
  await kv.set("demoSembrado", true);
}

// OF de ejemplo con la misma forma que data/of_produccion.json (ya descifrado).
export function ofsDemo() {
  const dia = (d) => {
    const x = new Date();
    x.setDate(x.getDate() + d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  return {
    generado: new Date().toISOString(),
    ofs: [
      { of: "SEM/MO/01790", id: 1, fecha: dia(0), codigo: "PTEC015", producto: "PULPA DE MARACUYA 150 g", cantidad: 12000, unidad: "Units", estado: "En proceso", lote_odoo: "" },
      { of: "SEM/MO/01791", id: 2, fecha: dia(0), codigo: "PTEC002", producto: "PULPA DE GUANABANA GOYA USA UNIDAD 397 g", cantidad: 8800, unidad: "Units", estado: "Confirmada", lote_odoo: "" },
      { of: "SEM/MO/01792", id: 3, fecha: dia(0), codigo: "SALS007", producto: "SALSA DE CHOCOLATE 1 KG", cantidad: 2000, unidad: "kg", estado: "En proceso", lote_odoo: "L2802604" },
      { of: "SEM/MO/01793", id: 4, fecha: dia(1), codigo: "PTEC014", producto: "PULPA DE MORA 150 g", cantidad: 5000, unidad: "Units", estado: "Confirmada", lote_odoo: "" },
    ],
  };
}

export async function borrarDemo() {
  const { CONFIG } = await import("./config.js");
  for (const l of Object.keys(CONFIG.sp.listas)) await idb.clear(S(l));
  await idb.clear("blobs");
  await idb.clear("kv");
  await idb.clear("outbox");
}
