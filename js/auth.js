// Envoltorio sobre MSAL (vendor/msal-browser.min.js). Solo con useMock false.
//
// A diferencia de los otros hubs, aquí el token es para la API REST de
// SharePoint (no Microsoft Graph): las fotos de pallet y la firma del
// proveedor se guardan como ADJUNTOS del ítem (así las guarda la Power App
// en sus columnas de imagen) y Graph no sabe escribir adjuntos de lista.

import { CONFIG } from "./config.js";

let msalInstance = null;
let account = null;

const SCOPES = [`${CONFIG.sp.host}/AllSites.Write`];

function getMsal() {
  if (!msalInstance) {
    msalInstance = new msal.PublicClientApplication({
      auth: {
        clientId: CONFIG.msal.clientId,
        authority: CONFIG.msal.authority,
        redirectUri: CONFIG.msal.redirectUri,
      },
      cache: { cacheLocation: "localStorage" },
    });
  }
  return msalInstance;
}

export async function initAuth() {
  const app = getMsal();
  await app.initialize();
  const result = await app.handleRedirectPromise().catch(() => null);
  if (result && result.account) account = result.account;
  else {
    // Solo cuentas de la organización (el localStorage es compartido con
    // las otras apps del mismo dominio).
    const tenant = CONFIG.msal.authority.split("/").pop();
    const accounts = app.getAllAccounts().filter((a) => a.tenantId === tenant);
    account = app.getActiveAccount() || accounts[0] || null;
  }
  if (account) app.setActiveAccount(account);
  return account;
}

export function login() {
  return getMsal().loginRedirect({ scopes: SCOPES, prompt: "select_account" });
}

export function logout() {
  return getMsal().logoutRedirect({ account });
}

export function getCurrentUser() {
  return account;
}

export class SesionVencidaError extends Error {}

// Al arrancar: confirma que hay token para SharePoint. Las otras apps de
// sisgeshealthy.github.io comparten el localStorage, así que MSAL puede ver
// una cuenta (dejada por Hub Asistencia, por ej.) sin que esta app tenga aún
// su propio permiso; ahí el silencioso falla y hay que pasar por Microsoft
// una vez. Se hace al abrir la app, cuando no hay nada a medio registrar.
export async function asegurarToken() {
  try {
    await getMsal().acquireTokenSilent({ scopes: SCOPES, account });
    return true;
  } catch (e) {
    console.warn("Token silencioso falló, se pide por redirección:", e);
    // Evita un ciclo de redirecciones si Microsoft vuelve sin token.
    const k = "hub-recepcion:redir";
    const ultimo = Number(sessionStorage.getItem(k) || 0);
    if (Date.now() - ultimo < 60000) throw new SesionVencidaError("No se pudo obtener el permiso de SharePoint. Cierra sesión e inicia de nuevo.");
    sessionStorage.setItem(k, String(Date.now()));
    await getMsal().acquireTokenRedirect({ scopes: SCOPES, account, loginHint: account?.username });
    return false;
  }
}

export async function getAccessToken() {
  if (!account) throw new SesionVencidaError("No hay sesión iniciada.");
  try {
    const r = await getMsal().acquireTokenSilent({ scopes: SCOPES, account });
    return r.accessToken;
  } catch (e) {
    // La sincronización corre en segundo plano: no redirigimos a mitad de
    // una recepción. La barra superior ofrece "Volver a iniciar sesión".
    throw new SesionVencidaError("La sesión de Microsoft venció.");
  }
}
