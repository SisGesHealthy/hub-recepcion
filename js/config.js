// Configuración del Hub Recepción (reemplazo de la Power App "Tipo de
// recepción": Bodega / Calidad / Calidad - Planta).
//
// Trabaja SOBRE LAS MISMAS LISTAS de la Power App en EspacioColaborativo —
// no crea nada nuevo en SharePoint. Las listas se ubican por su URL (no por
// título: "RECEPCIONES" se titula "ÓRDENES DE RECEPCIÓN" y "Recepciones1" se
// titula "Recepciones", así que buscar por título confunde una con otra).
//
// useMock: true  → modo demo, datos de ejemplo en IndexedDB del dispositivo.
// useMock: false → SharePoint real (requiere el permiso de SharePoint en el
//                  registro de Entra, ver README.md).

export const CONFIG = {
  // ?demo en la URL fuerza el modo demo (base local separada) sin tocar este archivo.
  useMock: new URLSearchParams(location.search).has("demo"),

  msal: {
    // Registro propio "Hub Recepción" en Entra ID (SPA + permiso delegado
    // SharePoint AllSites.Write con consentimiento de admin, ver README).
    clientId: "c1ddf8ec-9c41-4bfa-9a02-0fa51f74d328",
    authority: "https://login.microsoftonline.com/8f9b210d-f5e5-404f-9fed-a0a827154105",
    // Siempre la carpeta, sin "index.html": instalada en el celular la app
    // abre como .../hub-recepcion/index.html y Entra solo tiene registrada
    // .../hub-recepcion/ (error AADSTS50011).
    redirectUri: window.location.origin + window.location.pathname.replace(/index\.html$/, ""),
  },

  sp: {
    host: "https://marcalman.sharepoint.com",
    sitePath: "/sites/EspacioColaborativo",
    // clave interna → URL de la lista dentro del sitio
    listas: {
      ordenes: "Lists/RECEPCIONES", // "ÓRDENES DE RECEPCIÓN" (las crea Compras)
      liberaciones: "Lists/Liberaciones", // liberación de MP por Calidad
      pallets: "Lists/PalletsRecepcion", // un ítem por pallet pesado
      recepciones: "Lists/Recepciones1", // "Recepciones": resumen de la recepción
      lotes: "Lists/Lotes", // lotes de producción (Calidad - Planta)
      registros: "Lists/Registros", // mediciones por parada (Calidad - Planta)
      catalogo: "Lists/CatalogoParametrosLiberacion", // rangos por producto
      parametrosPeso: "Lists/ParametrosPeso", // Control de pesos: nominal/mín/máx por producto
      controlPesos: "Lists/ControlPesos", // Control de pesos: una fila por visita
    },
  },

  // Acceso por correo de la cuenta Microsoft con la que se inicia sesión
  // (igual que la pantalla principal de la Power App). Correo no listado →
  // sin acceso.
  // Administrador fijo: siempre tiene todo, aunque se edite la lista de
  // accesos en Configuración (así nadie queda fuera de Configuración por error).
  administrador: "sistemasdegestion@healthyfood.com.ec",
  // Valor inicial; la lista vigente se edita en la app (Configuración →
  // Cuentas con acceso) y se guarda en configuracion.json.
  accesos: {
    "bodega2@healthyfood.com.ec": ["bodega"],
    "calidad@healthyfood.com.ec": ["calidad", "planta", "pesos"],
    "calidad2@healthyfood.com.ec": ["calidad", "planta", "pesos"],
    // "config" = administrador: configuración y parámetros de peso
    "sistemasdegestion@healthyfood.com.ec": ["bodega", "calidad", "planta", "pesos", "config"],
  },

  // Bodegueros activos (iniciales que se guardan en Recepciones.Bodeguero).
  bodegueros: ["AC", "BC", "JT", "JC"],
  // Responsables de liberación (Calidad - Planta). Valor por defecto: la lista
  // vigente se edita en la app (Configuración, solo Sistemas) y se guarda en
  // SharePoint, sin tocar este archivo.
  responsablesPlanta: ["Edwin Tulcán", "Samantha Fajardo", "Paula Granja"],
  // Registros viejos guardaban iniciales: se muestran con el nombre completo.
  inicialesHistoricas: { ET: "Edwin Tulcán", SF: "Samantha Fajardo", JG: "John Guanochanga" },
  // Archivo de configuración editable (responsables, bodegueros).
  archivoConfig: { carpeta: "/sites/EspacioColaborativo/Documentos compartidos/HubRecepcion", nombre: "configuracion.json" },

  // Columnas agregadas a la lista Registros para cubrir el Excel
  // "MODELO LIBERACIONES 2026" (clave interna → nombre de la columna).
  registrosExtra: {
    color: "Color",
    olor: "Olor",
    sabor: "Sabor",
    aerobios: "Aerobios",
    mohos: "MohosLevaduras",
    coliformes: "Coliformes",
    ecoli: "EColi",
    salmonella: "Salmonella",
    pproDesinf: "PPRODesinfeccion",
    pproFiltrado: "PPROFiltrado",
    pcc1: "PCC1Pasteurizado",
    pcc2: "PCC2Pernos",
    liberacion: "Liberacion",
    incidente: "DetalleIncidente",
    correcciones: "Correcciones",
    numRep: "NumRepeticion",
  },
  opciones: {
    sensorial: ["OK", "No conforme"],
    control: ["Cumple", "No cumple", "N/A"],
    pcc1: ["Cumple", "No cumple", "N/A", "N/A PNP"],
    liberacion: ["Liberado", "No liberado", "Bloqueo parcial"],
  },

  // Órdenes "Programada" más viejas que esto se muestran aparte como
  // atrasadas (en la Power App seguían mezcladas con las de hoy).
  diasAtraso: 2,
  // Lotes de planta visibles: producidos en los últimos N días y sin cerrar.
  diasLotes: 5,

  // Órdenes de fabricación de Odoo (Calidad - Planta). Las exporta cada hora
  // scripts/exportar_of.py (GitHub Actions) CIFRADAS junto a la app; la clave
  // vive en SharePoint, así solo un usuario con sesión puede leerlas.
  of: {
    datos: "data/of_produccion.json",
    clave: "/sites/EspacioColaborativo/Documentos compartidos/HubRecepcion/clave_of.txt",
    columnaLotes: "OrdenFabricacion", // columna agregada a la lista Lotes
    horasVigencia: 3, // más viejo que esto → aviso "datos de Odoo desactualizados"
  },
  // Aviso si el neto recibido se aleja de lo programado más que esto.
  toleranciaCantidad: 0.1,

  // Foto del pallet: se redimensiona antes de subir (≈150 KB en vez de 2-4 MB
  // de la cámara de la tablet).
  foto: { ladoMax: 1280, calidad: 0.75 },

  // Correo de relleno que se usaba cuando no había el del proveedor: no se
  // sugiere como correo del proveedor.
  correosRelleno: ["sistemasdegestionhf@gmail.com"],

  // Rangos de sanidad para MP (detectan errores de tipeo, ej. pH 31 en vez de 3.1).
  rangosMP: { brix: [0, 40], ph: [1.5, 7.5], acidez: [0, 8] },
};
