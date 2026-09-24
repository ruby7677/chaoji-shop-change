// 登入工作階段：執行設定、LIFF 啟動情境判斷、登入回呼擷取、session 保存／還原（LIFF vault 與一般瀏覽器 HttpOnly cookie）與 LIFF 橋接。
import { initializeLiffClient, liffState } from "./liff-auth.js";
import { accessTokenExpiresSoon } from "./auth-expiry.js";
import { refreshWebSession, startWebSession } from "./web-session.js";
import { auth } from "./app-core.js";
import { forgetCartSyncUser } from "./cart.js";
import { clearMemberStateCache } from "./member-benefits.js";
import { captureAuthReturn } from "./auth-return-state.js";
import { beginLineLogin } from "./member-profile.js";

export let liffSessionMatches = false;
export const LIFF_AUTO_LOGIN_KEY = "chaoji:liff-oauth-attempt";
const LIFF_AUTO_LOGIN_MAX_AGE_MS = 2 * 60 * 1000;
export const LIFF_AUTO_CALLBACK_PARAM = "cj_liff_oauth";
const LIFF_CONTEXT_KEY = "chaoji:liff-context";
let liffBridgeInFlight = null;
let liffBridgeResolved = false;
let liffBridgeResult = false;
export let liffOAuthCallbackSeen = false;
let liffAutoLoginAttemptAt = 0;
export let liffPrimaryRedirectPending = false;

function stripLiffCallbackMarker() {
  const url = new URL(location.href);
  if (!url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) return;
  url.searchParams.delete(LIFF_AUTO_CALLBACK_PARAM);
  history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
}

export function captureAuthSession() {
  const currentUrl = new URL(location.href);
  if (currentUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    // The marker makes the OAuth handoff one-shot even when a browser or
    // LINE webview does not preserve sessionStorage across the handoff.
    liffOAuthCallbackSeen = true;
    markLiffLaunchContext("oauth-callback");
    stripLiffCallbackMarker();
  }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  captureAuthReturn(fragment);
  if (fragment.get("error")) {
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  if (fragment.get("access_token")) {
    // A new LINE Login callback is a new member session boundary. Do not
    // carry points/coupons or friendship state across it, even on the same
    // page lifecycle.
    clearMemberStateCache();
    auth.accessToken = fragment.get("access_token");
    auth.refreshToken = fragment.get("refresh_token");
    auth.lineProviderToken = fragment.get("provider_token");
    persistEphemeralAuthSession();
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem("cj-auth") || "null");
    auth.accessToken = saved?.accessToken ?? null;
    auth.refreshToken = saved?.refreshToken ?? null;
    auth.lineProviderToken = saved?.lineProviderToken ?? null;
  } catch {
    clearMemberStateCache();
    sessionStorage.removeItem("cj-auth");
  }
}













export async function loadRuntimeConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return false;
    auth.config = await response.json();
    return true;
  } catch {
    auth.config = null;
    return false;
  }
}

export function readLiffLaunchContext() {
  try {
    const raw = sessionStorage.getItem(LIFF_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      sessionStorage.removeItem(LIFF_CONTEXT_KEY);
      return null;
    }
    return parsed;
  } catch {
    try { sessionStorage.removeItem(LIFF_CONTEXT_KEY); } catch { /* restricted storage */ }
    return null;
  }
}

function markLiffLaunchContext(source = "redirect") {
  try {
    sessionStorage.setItem(LIFF_CONTEXT_KEY, JSON.stringify({ createdAt: Date.now(), source }));
  } catch { /* sessionStorage may be unavailable in restricted previews. */ }
}

export function clearLiffLaunchContext() {
  try { sessionStorage.removeItem(LIFF_CONTEXT_KEY); }
  catch { /* sessionStorage may be unavailable in restricted previews. */ }
  liffPrimaryRedirectPending = false;
}

function hasLiffCredentialFragment(url = new URL(location.href)) {
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const hasSupabaseSessionFields = fragment.has("refresh_token") || fragment.has("provider_token");
  return fragment.has("context_token")
    || fragment.has("feature_token")
    || (!hasSupabaseSessionFields && fragment.has("id_token") && fragment.has("client_id"));
}

export function hasLiffPrimaryRedirectParams(url = new URL(location.href)) {
  // LINE may omit liff.state for a plain LIFF URL, but the primary redirect
  // can still carry LIFF-only credential fields in the hash until liff.init()
  // resolves. Never treat access_token alone as LIFF: Supabase uses it too.
  const hasLiffQuery = [...url.searchParams.keys()].some((key) => key.startsWith("liff."));
  return hasLiffQuery || hasLiffCredentialFragment(url);
}

export function hasLiffLaunchIntent(url = new URL(location.href)) {
  const hasPrimaryRedirect = hasLiffPrimaryRedirectParams(url);
  const hasLiffOAuthCallback = url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM);
  if (hasPrimaryRedirect || hasLiffOAuthCallback) {
    markLiffLaunchContext(hasLiffOAuthCallback ? "oauth-callback" : "primary-redirect");
    return true;
  }
  return Boolean(readLiffLaunchContext());
}

export async function initializeLiffStage({ launchIntent = false, explicitLaunch = false } = {}) {
  if (!launchIntent || !auth.config?.liffEnabled || !auth.config?.liffId) {
    return { state: null, primary: false, initialized: false };
  }
  const primaryBeforeInit = hasLiffPrimaryRedirectParams();
  liffPrimaryRedirectPending = primaryBeforeInit;
  try {
    const state = await initializeLiffClient(auth.config.liffId);
    if (!state?.isInClient) {
      clearLiffLaunchContext();
      return { state, primary: false, initialized: true };
    }
    markLiffLaunchContext("in-client");
    // A primary endpoint may navigate while liff.init() is running. If the
    // URL is still carrying the LIFF handoff after init resolves, do not
    // start product/member work on a document that is not the final endpoint.
    const primaryAfterInit = hasLiffPrimaryRedirectParams();
    liffPrimaryRedirectPending = primaryBeforeInit && primaryAfterInit;
    return { state, primary: liffPrimaryRedirectPending, initialized: true };
  } catch (error) {
    liffPrimaryRedirectPending = primaryBeforeInit || explicitLaunch;
    if (primaryBeforeInit || explicitLaunch) throw error;
    clearLiffLaunchContext();
    // A stale same-tab marker must not make the public site depend on LIFF.
    console.warn("Optional LIFF bootstrap unavailable; continuing as web page.", error);
    return { state: null, primary: false, initialized: false };
  }
}

export function clearStoredAuthSession() {
  clearMemberStateCache();
  auth.accessToken = null;
  auth.refreshToken = null;
  auth.lineProviderToken = null;
  auth.user = null;
  auth.profile = null;
  forgetCartSyncUser();
  try { sessionStorage.removeItem("cj-auth"); } catch { /* restricted storage */ }
}

function persistEphemeralAuthSession({ includeRefresh = true } = {}) {
  try {
    sessionStorage.setItem("cj-auth", JSON.stringify({
      accessToken: auth.accessToken,
      refreshToken: includeRefresh ? auth.refreshToken : null,
      lineProviderToken: auth.lineProviderToken
    }));
  } catch { /* restricted storage */ }
}

async function rememberPersistentLiffSession() {
  if (!liffState.isInClient || !liffState.idToken || !auth.refreshToken) return false;
  const response = await fetch("/api/auth/session/remember", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: auth.refreshToken, id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") return false;
  auth.accessToken = result.access_token;
  auth.refreshToken = null;
  liffSessionMatches = true;
  persistEphemeralAuthSession({ includeRefresh: false });
  return true;
}

export async function restorePersistentLiffSession() {
  if (!liffState.isInClient || !liffState.idToken) return false;
  const response = await fetch("/api/auth/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    if (response.status === 409) clearStoredAuthSession();
    return false;
  }
  auth.accessToken = result.access_token;
  auth.refreshToken = null;
  auth.lineProviderToken = null;
  liffSessionMatches = true;
  persistEphemeralAuthSession({ includeRefresh: false });
  return true;
}

// 一般瀏覽器：refresh token 只在 OAuth 回來當下交給 Worker 保存（web-session.js），前端不再留存
function applyWebSession(result) {
  auth.accessToken = result.access_token;
  auth.refreshToken = null;
  persistEphemeralAuthSession({ includeRefresh: false });
}

export async function ensureWebSession() {
  if (!auth.config?.authEnabled) return;
  if (auth.refreshToken) {
    const started = await startWebSession(auth.refreshToken);
    if (started) applyWebSession(started);
    else { auth.refreshToken = null; persistEphemeralAuthSession({ includeRefresh: false }); }
    return;
  }
  if (auth.accessToken && !accessTokenExpiresSoon(auth.accessToken)) return;
  const refreshed = await refreshWebSession();
  if (refreshed) applyWebSession(refreshed);
}

export async function restoreWebSession() {
  const refreshed = await refreshWebSession();
  if (!refreshed || (auth.user?.id && refreshed.user_id !== auth.user.id)) return false;
  applyWebSession(refreshed);
  return true;
}

async function forgetPersistentLiffSession() {
  try { await fetch("/api/auth/session/forget", { method: "POST" }); }
  catch { /* best-effort cleanup */ }
}

export function recentLiffAutoLoginAttempt() {
  if (liffAutoLoginAttemptAt > 0 && Date.now() - liffAutoLoginAttemptAt < LIFF_AUTO_LOGIN_MAX_AGE_MS) return true;
  try {
    const raw = sessionStorage.getItem(LIFF_AUTO_LOGIN_KEY) || "";
    const parsed = JSON.parse(raw);
    const attemptedAt = typeof parsed === "object" ? Number(parsed?.createdAt) : Number(raw);
    return Number.isFinite(attemptedAt) && attemptedAt > 0 && Date.now() - attemptedAt < LIFF_AUTO_LOGIN_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function markLiffAutoLoginAttempt() {
  liffAutoLoginAttemptAt = Date.now();
  const value = { createdAt: liffAutoLoginAttemptAt, nonce: globalThis.crypto?.randomUUID?.() || String(liffAutoLoginAttemptAt) };
  try { sessionStorage.setItem(LIFF_AUTO_LOGIN_KEY, JSON.stringify(value)); }
  catch { /* restricted storage */ }
}

async function verifyCurrentLiffIdentity({ matchSession = false } = {}) {
  if (!liffState.idToken) return null;
  const headers = { "Content-Type": "application/json" };
  if (matchSession && auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  const response = await fetch("/api/auth/liff/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    liffSessionMatches = false;
    const error = new Error(result.error || "LIFF LINE 身分驗證失敗");
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  liffSessionMatches = result.sessionMatch === true;
  return result;
}

async function runInitializeLiffBridge(initialState = null) {
  if (!auth.config?.liffEnabled || !auth.config?.liffId) return false;
  try {
    const state = initialState || await initializeLiffClient(auth.config.liffId);
    // External browsers may still have an active LIFF web session. Keep that
    // separate from the site's normal Supabase LINE OAuth session: only the
    // LINE in-app client is allowed to enter the LIFF session bridge.
    if (!state.initialized || !state.isInClient || !state.loggedIn || !state.idToken) return false;
    if (auth.accessToken && auth.refreshToken && state.isInClient) {
      const remembered = await rememberPersistentLiffSession();
      if (remembered) {
        try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
        return false;
      }
    }
    if (!auth.accessToken && state.isInClient) {
      const restored = await restorePersistentLiffSession();
      if (restored) {
        try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
        return false;
      }
    }
    try {
      await verifyCurrentLiffIdentity({ matchSession: Boolean(auth.accessToken) });
    } catch (error) {
      const status = Number(error.status || 0);
      if (status === 409) {
        clearStoredAuthSession();
        await forgetPersistentLiffSession();
        liffSessionMatches = false;
        // The server-side LIFF session is keyed by the LIFF identity, so the
        // correct member can usually be restored without an OAuth redirect.
        if (state.isInClient && await restorePersistentLiffSession()) return false;
        await verifyCurrentLiffIdentity();
      } else if (auth.accessToken && [401, 403].includes(status) && !recentLiffAutoLoginAttempt()) {
        clearStoredAuthSession();
        if (state.isInClient && await restorePersistentLiffSession()) return false;
        await verifyCurrentLiffIdentity();
      } else {
        throw error;
      }
    }
    if (auth.accessToken) {
      try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
      return false;
    }
    if (!state.isInClient) return false;
    if (liffOAuthCallbackSeen || recentLiffAutoLoginAttempt()) return false;
    return beginLineLogin({ automatic: true });
  } catch (error) {
    console.warn("LIFF initialization failed; falling back to web login.", error);
    return false;
  }
}

export function initializeLiffBridge(initialState = null) {
  if (liffBridgeResolved) return Promise.resolve(liffBridgeResult);
  if (liffBridgeInFlight) return liffBridgeInFlight;
  const promise = runInitializeLiffBridge(initialState).then((result) => {
    liffBridgeResult = result === true;
    liffBridgeResolved = true;
    return liffBridgeResult;
  }).catch((error) => {
    liffBridgeInFlight = null;
    throw error;
  });
  liffBridgeInFlight = promise;
  return promise;
}
