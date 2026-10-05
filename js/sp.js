// Cliente mínimo de la API REST de SharePoint para las listas existentes de
// la Power App. Misma interfaz que mock.js (modo demo), así store.js no sabe
// contra qué está hablando.
//
// Los nombres de campo son los nombres de PROPIEDAD que devuelve REST, que
// para columnas cuyo nombre interno empieza con "_" llevan el prefijo
// "OData_" (ej. ID_N → OData__x0049_D2, bx → OData__x00b0_Brix). Se usan
// tal cual en lecturas, filtros y escrituras.
//
// Consultas: { where: [[campo, op, valor], ...] (AND), orderby, top, select }
//   op ∈ eq | ne | ge | le | gt | lt ; valor Date → datetime'ISO'.

import { CONFIG } from "./config.js";
import { getAccessToken } from "./auth.js";

const SITE = CONFIG.sp.host + CONFIG.sp.sitePath;
const JSON_NM = "application/json;odata=nometadata";

function listUrl(lista) {
  const rel = `${CONFIG.sp.sitePath}/${CONFIG.sp.listas[lista]}`;
  return `${SITE}/_api/web/GetList('${encodeURIComponent(rel)}')`;
}

async function spFetch(url, { method = "GET", headers = {}, body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: JSON_NM, ...headers },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`SharePoint ${method} ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function odataValor(v) {
  if (v instanceof Date) return `datetime'${v.toISOString()}'`;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function construirQuery({ where = [], orderby, top = 5000, select } = {}) {
  const p = [];
  if (where.length) p.push("$filter=" + encodeURIComponent(where.map(([c, op, v]) => `${c} ${op} ${odataValor(v)}`).join(" and ")));
  if (orderby) p.push("$orderby=" + encodeURIComponent(orderby));
  if (select) p.push("$select=" + select.join(","));
  p.push(`$top=${Math.min(top, 5000)}`);
  return "?" + p.join("&");
}

export const api = {
  async items(lista, q = {}) {
    let url = `${listUrl(lista)}/items${construirQuery(q)}`;
    const out = [];
    while (url && out.length < (q.top || 5000)) {
      const data = await spFetch(url);
      out.push(...(data.value || []));
      url = data["odata.nextLink"] || null;
    }
    return out;
  },

  async add(lista, campos) {
    return spFetch(`${listUrl(lista)}/items`, {
      method: "POST",
      headers: { "Content-Type": JSON_NM },
      body: JSON.stringify(campos),
    });
  },

  async update(lista, id, campos) {
    await spFetch(`${listUrl(lista)}/items(${id})`, {
      method: "POST",
      headers: { "Content-Type": JSON_NM, "X-HTTP-Method": "MERGE", "IF-MATCH": "*" },
      body: JSON.stringify(campos),
    });
  },

  async remove(lista, id) {
    await spFetch(`${listUrl(lista)}/items(${id})`, {
      method: "POST",
      headers: { "X-HTTP-Method": "DELETE", "IF-MATCH": "*" },
    });
  },

  // Guarda una imagen igual que la Power App: como adjunto del ítem con
  // nombre "Reserved_ImageAttachment_…" (SharePoint los oculta de la lista de
  // adjuntos) y apunta la columna de imagen a ese archivo.
  async attachImage(lista, id, campo, blob, ext) {
    const guid = crypto.randomUUID().replace(/-/g, "");
    const fileName = `Reserved_ImageAttachment_[1]_[${campo}][1]_[${guid}][1]_[1].${ext}`;
    const fileUrl = `${CONFIG.sp.sitePath}/${CONFIG.sp.listas[lista]}/Attachments/${id}/${fileName}`;
    await spFetch(`${listUrl(lista)}/items(${id})/AttachmentFiles/add(FileName='${encodeURIComponent(fileName)}')`, {
      method: "POST",
      body: blob,
    });
    const valor = JSON.stringify({
      type: "thumbnail",
      fileName,
      fieldName: campo,
      serverUrl: CONFIG.sp.host,
      serverRelativeUrl: fileUrl,
    });
    const r = await spFetch(`${listUrl(lista)}/items(${id})/ValidateUpdateListItem()`, {
      method: "POST",
      headers: { "Content-Type": JSON_NM },
      body: JSON.stringify({ formValues: [{ FieldName: campo, FieldValue: valor }], bNewDocumentUpdate: false }),
    });
    const fallo = (r?.value || []).find((x) => x.HasException);
    if (fallo) throw new Error(`No se pudo enlazar la imagen: ${fallo.ErrorMessage}`);
    return fileUrl;
  },

  // URL para mostrar una imagen ya guardada (columna de imagen en JSON).
  imageUrl(lista, id, valorCampo) {
    if (!valorCampo) return null;
    try {
      const v = typeof valorCampo === "string" ? JSON.parse(valorCampo) : valorCampo;
      if (v.serverRelativeUrl) return CONFIG.sp.host + v.serverRelativeUrl;
      if (v.fileName) return `${CONFIG.sp.host}${CONFIG.sp.sitePath}/${CONFIG.sp.listas[lista]}/Attachments/${id}/${v.fileName}`;
    } catch {}
    return null;
  },

  // Las imágenes de SharePoint piden el token: se bajan como blob.
  async fetchImage(url) {
    const token = await getAccessToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Imagen ${res.status}`);
    return res.blob();
  },
};
