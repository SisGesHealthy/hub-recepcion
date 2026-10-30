# -*- coding: utf-8 -*-
"""Exporta las órdenes de fabricación de Odoo para Calidad - Planta.

Lee mrp.production por su "Fecha de producción" (production_date) de ayer a
pasado mañana y deja el resultado CIFRADO en data/of_produccion.json, que se
publica junto a la app en GitHub Pages. El repositorio es público: por eso va
cifrado (AES-256-GCM). La clave está en el secret OF_KEY y, para la app, en un
archivo de SharePoint que solo pueden leer los usuarios de Healthy Food.

Variables de entorno (secrets del repositorio):
  ODOO_URL, ODOO_DB, ODOO_USER, ODOO_PASS, OF_KEY (32 bytes en base64)

Uso local de prueba (sin cifrar, imprime el JSON):
  python scripts/exportar_of.py --plano
"""
import base64
import datetime as dt
import json
import os
import sys
import xmlrpc.client
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Guayaquil")
SALIDA = os.path.join(os.path.dirname(__file__), "..", "data", "of_produccion.json")
ESTADOS = {"draft": "Borrador", "confirmed": "Confirmada", "progress": "En proceso", "to_close": "Por cerrar", "done": "Hecha"}


def odoo():
    url, db = os.environ["ODOO_URL"], os.environ["ODOO_DB"]
    user, pw = os.environ["ODOO_USER"], os.environ["ODOO_PASS"]
    uid = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common", allow_none=True).authenticate(db, user, pw, {})
    if not uid:
        sys.exit("Autenticación fallida en Odoo (revisa el secret ODOO_PASS).")
    models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object", allow_none=True)
    return lambda modelo, metodo, *args, **kw: models.execute_kw(db, uid, pw, modelo, metodo, list(args), kw)


DIAS_ATRAS = 60


def leer_ofs(x):
    hoy = dt.datetime.now(TZ).date()
    # 60 días hacia atrás: Control de pesos y Calidad - Planta consultan días
    # anteriores (OF ya terminadas). Son pocas OF por día: el archivo sigue chico.
    desde, hasta = hoy - dt.timedelta(days=DIAS_ATRAS), hoy + dt.timedelta(days=2)
    ofs = x(
        "mrp.production", "search_read",
        [["production_date", ">=", desde.isoformat()], ["production_date", "<=", hasta.isoformat()], ["state", "!=", "cancel"]],
        fields=["name", "product_id", "product_qty", "product_uom_id", "production_date", "state", "lot_producing_id", "date_start"],
        order="production_date, date_start, name",
    )
    prod_ids = list({o["product_id"][0] for o in ofs if o["product_id"]})
    productos = {p["id"]: p for p in x("product.product", "read", prod_ids, fields=["default_code", "name", "weight", "uom_id"])} if prod_ids else {}
    out = []
    for o in ofs:
        p = productos.get(o["product_id"][0], {}) if o["product_id"] else {}
        out.append({
            "of": o["name"],
            "id": o["id"],
            "fecha": o["production_date"],
            "codigo": p.get("default_code") or "",
            "producto": p.get("name") or (o["product_id"][1] if o["product_id"] else ""),
            "cantidad": o["product_qty"],
            "unidad": o["product_uom_id"][1] if o["product_uom_id"] else "",
            "estado": ESTADOS.get(o["state"], o["state"]),
            "lote_odoo": o["lot_producing_id"][1] if o["lot_producing_id"] else "",
            # Para Control de pesos: peso de la presentación (kg) y unidad de
            # medida del producto (en productos a granel "kg" el peso es 1 = por kilo).
            "peso_kg": p.get("weight") or 0,
            "uom_producto": p["uom_id"][1] if p.get("uom_id") else "",
        })
    return {"generado": dt.datetime.now(TZ).isoformat(timespec="seconds"), "desde": desde.isoformat(), "hasta": hasta.isoformat(), "ofs": out, **leer_catalogo(x)}


# Prefijos de productos con lista de materiales que NO se dosifican/venden
# (reprocesos, mezclas intermedias, diluciones).
PREFIJOS_FUERA = ("REP-", "MPI", "DILU", "S_")


def leer_catalogo(x):
    """Productos terminados (con lista de materiales) y clientes empresa, para
    registrar en Control de pesos un control sin orden de fabricación."""
    prods = x(
        "product.product", "search_read",
        [["bom_ids", "!=", False], ["active", "=", True]],
        fields=["default_code", "name", "weight", "uom_id"],
        order="default_code",
    )
    prods = [p for p in prods if p["default_code"] and not p["default_code"].upper().startswith(PREFIJOS_FUERA)]
    # Clientes empresa que compraron cada producto en el último año (orientativo).
    desde = (dt.datetime.now(TZ).date() - dt.timedelta(days=365)).isoformat()
    lineas = x(
        "sale.order.line", "search_read",
        [["order_id.state", "in", ["sale", "done"]], ["order_id.date_order", ">=", desde], ["product_id", "in", [p["id"] for p in prods]]],
        fields=["product_id", "order_partner_id"],
    )
    empresas = x("res.partner", "search_read", [["customer_rank", ">", 0], ["is_company", "=", True]], fields=["name"], order="name")
    nombres = {e["id"]: e["name"] for e in empresas}
    compra = {}
    for l in lineas:
        if l["product_id"] and l["order_partner_id"] and l["order_partner_id"][0] in nombres:
            compra.setdefault(l["product_id"][0], set()).add(nombres[l["order_partner_id"][0]])
    return {
        "productos": [
            {
                "codigo": p["default_code"],
                "producto": p["name"],
                "peso_kg": p.get("weight") or 0,
                "uom_producto": p["uom_id"][1] if p.get("uom_id") else "",
                "clientes": sorted(compra.get(p["id"], [])),
            }
            for p in prods
        ],
        "clientes": [e["name"] for e in empresas],
    }


def cifrar(datos: dict, clave_b64: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    clave = base64.b64decode(clave_b64)
    if len(clave) != 32:
        sys.exit("OF_KEY debe ser de 32 bytes en base64.")
    iv = os.urandom(12)
    ct = AESGCM(clave).encrypt(iv, json.dumps(datos, ensure_ascii=False).encode("utf-8"), None)
    return {"v": 1, "alg": "AES-256-GCM", "iv": base64.b64encode(iv).decode(), "data": base64.b64encode(ct).decode()}


def main():
    datos = leer_ofs(odoo())
    if "--plano" in sys.argv:
        print(json.dumps(datos, ensure_ascii=False, indent=1))
        return
    sobre = cifrar(datos, os.environ["OF_KEY"])
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(sobre, f)
    print(f"{len(datos['ofs'])} OF ({datos['desde']} a {datos['hasta']}), {len(datos['productos'])} productos, {len(datos['clientes'])} clientes -> {os.path.normpath(SALIDA)}")


if __name__ == "__main__":
    main()
