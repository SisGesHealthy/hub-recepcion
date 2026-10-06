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
    redirectUri: window.location.origin + window.location.pathname,
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
    },
  },

  // Acceso por correo de la cuenta Microsoft con la que se inicia sesión
  // (igual que la pantalla principal de la Power App). Correo no listado →
  // sin acceso.
  accesos: {
    "bodega2@healthyfood.com.ec": ["bodega"],
    "calidad@healthyfood.com.ec": ["calidad", "planta"],
    "calidad2@healthyfood.com.ec": ["calidad", "planta"],
    "sistemasdegestion@healthyfood.com.ec": ["bodega", "calidad", "planta"],
  },

  // Iniciales que hoy aparecen en Recepciones.Bodeguero.
  bodegueros: ["AC", "BC", "BE", "CM", "JC", "JT", "WT", "XA"],
  // Iniciales que hoy aparecen en Registros.Responsable de liberación.
  responsablesPlanta: ["ET", "SF", "JG"],

  // Órdenes "Programada" más viejas que esto se muestran aparte como
  // atrasadas (en la Power App seguían mezcladas con las de hoy).
  diasAtraso: 2,
  // Lotes de planta visibles: producidos en los últimos N días y sin cerrar.
  diasLotes: 5,
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
