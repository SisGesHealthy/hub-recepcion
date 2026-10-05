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
    const accounts = app.getAllAccounts();
    if (accounts.length > 0) account = accounts[0];
  }
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
