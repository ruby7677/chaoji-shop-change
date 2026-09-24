import { liffState, initializeLiffClient, preloadLiffSdk, canRequestLineFriendship } from "./liff-auth.js";
import { createProductPage } from "./product-page.js";
import { initAnchorScroll, scrollToAnchor } from "./anchor-scroll.js";
import { initAdminProductGallery } from "./admin-product-gallery.js";
import { initAdminProductsTable } from "./admin-products-table.js";
import { initAdminShell } from "./admin-shell.js";
import { accessTokenExpiresSoon, initAuthExpiry, watchSessionExpiry } from "./auth-expiry.js";
import { initAdminTab, openAdminFromRoute, openAdminInNewTab } from "./admin-tab.js";
import { refreshWebSession, startWebSession } from "./web-session.js";
import { adminOrderStatusLabel, auth, closeDialog, formatDateTime, showDialog, showToast, syncPageScrollLock } from "./app-core.js";
import { adminData, adminFetch, applyAdminQuickFilter, changeAdminPage, invalidateAdminManagementOptions, loadAdminData, loadAdminSection, openAdmin, reloadAdminList, switchAdminTab, testTelegramNotification } from "./admin-app.js";
import { submitAdminOrderFulfillment, submitAdminOrderReturn, submitAdminOrderTransition } from "./admin-orders-panel.js";
import { editCoupon, issueBirthdayCouponsNow, resetCouponForm, submitBirthdaySettings, submitCoupon, submitMemberPointAdjustment, submitPointSettings, syncPointMaxHint } from "./admin-members-panel.js";
import { editAccount, requeueAdminNotification, resetAccountForm, submitAdminAccount } from "./admin-system-panel.js";
import { adminCategoryOptions, editAdminCategory, focusAdminCategoryForm, removeLegacyShippingUI, resetAdminCategoryForm, splitPreorderArrival, submitAdminCategory, submitAdminProduct, submitDynamicAdminForm, submitInventoryAdjustment, submitNewVariant, syncDepositField } from "./admin-catalog-panel.js";
import { adminProductImageFallbackMarkup, handleAdminProductImageError, prepareProductImage } from "./admin-product-image.js";
import { addToCartWithFeedback, addVariantQuantityToCart, buyNowFromCard, cart, cartGroups, cartItemsForScope, cartSyncUserId, checkoutCartItems, forgetCartSyncUser, handleCartCheckout, loadLocalCart, loadMemberCart, removeLegacySellerCheckoutOption, renderCart, resetMemberCartSyncState, saveCart, selectedCartDeliveryMethod, selectedDeliveryMethod, setCartDeliveryMethod, setCartGroupDeliveryMethod, syncMemberCartNow, toggleCart } from "./cart.js";
import { bankAccounts, clearCheckoutFieldErrorFor, clearCheckoutFieldErrors, ensurePaymentMethodUI, loadBankAccounts, openCheckoutReview, renderCheckoutBenefits, renderCheckoutSummary, setCheckoutStage, syncCheckoutSellerOption, syncDeliveryFields, syncPaymentFields, validateCheckoutDetails } from "./checkout-form.js";
import { checkLineFriendship, clearMemberStateCache, handleLineFriendRequest, lineFriendshipCache, loadPoints, memberPointsCache, renderMemberPoints, requireLineFriendshipForCheckout, showLineFriendDialog } from "./member-benefits.js";
import { currentOrders, openOrders, showPaymentDialog, submitPayment } from "./member-orders.js";
import { loadProducts, openProductDetail, products, renderHeroSpotlight, renderProducts, search, waitForHeroImageDecode } from "./storefront-catalog.js";

export let liffSessionMatches = false;

const AUTH_RETURN_STATE_KEY = "chaoji:auth-return-state";
const AUTH_RETURN_MAX_AGE_MS = 10 * 60 * 1000;
const LIFF_AUTO_LOGIN_KEY = "chaoji:liff-oauth-attempt";
const LIFF_AUTO_LOGIN_MAX_AGE_MS = 2 * 60 * 1000;
const LIFF_AUTO_CALLBACK_PARAM = "cj_liff_oauth";
const LIFF_CONTEXT_KEY = "chaoji:liff-context";
const AUTH_BOOT_FAILSAFE_MS = 30000;
const AUTH_BOOT_STABLE_MESSAGE = "正在準備潮吉好頑…";

let authBootFailsafe = null;
let authBootFailed = false;
let authBootstrapInFlight = null;
let liffBridgeInFlight = null;
let liffBridgeResolved = false;
let liffBridgeResult = false;
let memberLoadInFlight = null;
let memberLoadResolved = false;
let liffOAuthCallbackSeen = false;
let liffAutoLoginAttemptAt = 0;
let liffPrimaryRedirectPending = false;
let initialPageRendered = false;

let authReturnState = null;
let shouldRestoreAuthReturnState = false;
let authReturnError = null;
let pendingReturnCheckout = null;
export let activeCategory = "all";

export let activeCheckoutScope = null;
export let activeCheckoutItems = null;

let identitySyncUserId = null;
let identitySyncInFlight = null;

function readAuthReturnState() {
  try {
    const raw = sessionStorage.getItem(AUTH_RETURN_STATE_KEY);
    sessionStorage.removeItem(AUTH_RETURN_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || !Number.isFinite(state.createdAt) || Date.now() - state.createdAt > AUTH_RETURN_MAX_AGE_MS) return null;
    if (state.returnPath && state.returnPath !== location.pathname) return null;
    return state;
  } catch {
    try { sessionStorage.removeItem(AUTH_RETURN_STATE_KEY); } catch { /* restricted storage */ }
    return null;
  }
}

function saveAuthReturnState() {
  const drawer = document.querySelector("#cart-drawer");
  const checkoutDialog = document.querySelector("#checkout-dialog");
  const checkoutIntent = Boolean(activeCheckoutScope && activeCheckoutItems?.length);
  const checkoutOpen = Boolean(checkoutDialog?.open || checkoutIntent);
  const value = (selector) => document.querySelector(selector)?.value || "";
  const state = {
    version: 1,
    createdAt: Date.now(),
    returnPath: location.pathname,
    scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
    scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
    cartOpen: Boolean(drawer?.classList.contains("open")),
    checkout: checkoutOpen ? {
      scope: activeCheckoutScope || null,
      stage: document.querySelector("#checkout-form")?.dataset.checkoutStage || "details",
      deliveryMethod: selectedDeliveryMethod(),
      bankAccountId: document.querySelector("input[name='bank_account']:checked")?.value || "",
      fields: {
        name: value("#checkout-name"),
        phone: value("#checkout-phone"),
        address: value("#checkout-address"),
        recipientName: value("#checkout-recipient-name"),
        recipientPhone: value("#checkout-recipient-phone"),
        couponCode: value("#checkout-coupon-code"),
        points: value("#checkout-points")
      }
    } : null
  };
  try { sessionStorage.setItem(AUTH_RETURN_STATE_KEY, JSON.stringify(state)); }
  catch { /* sessionStorage may be unavailable in restricted previews. */ }
}

function restoreCheckoutReturnState(checkout) {
  if (!checkout) return;
  const fields = checkout.fields || {};
  const assign = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && typeof value === "string") node.value = value;
  };
  const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${checkout.deliveryMethod}']`);
  if (deliveryInput) deliveryInput.checked = true;
  assign("#checkout-name", fields.name);
  assign("#checkout-phone", fields.phone);
  assign("#checkout-address", fields.address);
  assign("#checkout-recipient-name", fields.recipientName);
  assign("#checkout-recipient-phone", fields.recipientPhone);
  assign("#checkout-coupon-code", fields.couponCode);
  assign("#checkout-points", fields.points);
  const bankInput = checkout.bankAccountId && document.querySelector(`input[name='bank_account'][value='${checkout.bankAccountId}']`);
  if (bankInput) bankInput.checked = true;
  syncDeliveryFields();
  renderCheckoutBenefits();
  renderCheckoutSummary();
  setCheckoutStage(checkout.stage === "review" ? "review" : "details", { focus: false });
}

async function restoreAuthReturnState() {
  if (!shouldRestoreAuthReturnState) return;
  shouldRestoreAuthReturnState = false;
  const state = authReturnState;
  authReturnState = null;
  if (!state) {
    if (authReturnError) { showToast(authReturnError, "error"); authReturnError = null; }
    return;
  }
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  window.scrollTo(Number(state.scrollX) || 0, Number(state.scrollY) || 0);
  if (state.checkout && auth.user) {
    if (!profileIsComplete()) pendingReturnCheckout = state.checkout;
    else {
      await openCheckout(state.checkout.scope || undefined);
      if (document.querySelector("#checkout-dialog")?.open) restoreCheckoutReturnState(state.checkout);
    }
  } else if (state.checkout) {
    activeCheckoutScope = state.checkout.scope || activeCheckoutScope;
    activeCheckoutItems = cartItemsForScope(activeCheckoutScope);
    if (!document.querySelector("#cart-drawer")?.classList.contains("open")) toggleCart();
  } else if (state.cartOpen && !document.querySelector("#cart-drawer")?.classList.contains("open")) {
    toggleCart();
  }
  if (authReturnError) { showToast(authReturnError, "error"); authReturnError = null; }
}

function setAuthBootMessage(message, { force = false } = {}) {
  const node = document.querySelector("[data-auth-boot-message]");
  if (node && message && (force || authBootFailed)) node.textContent = message;
}

function startAuthBoot() {
  authBootFailed = false;
  const retry = document.querySelector("[data-auth-boot-retry]");
  if (retry && retry.dataset.bound !== "true") {
    retry.dataset.bound = "true";
    retry.addEventListener("click", () => location.reload());
  }
  document.body.classList.add("auth-booting");
  document.body.classList.remove("auth-boot-ready");
  setAuthBootMessage(AUTH_BOOT_STABLE_MESSAGE, { force: true });
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  if (authBootFailsafe) clearTimeout(authBootFailsafe);
  authBootFailsafe = setTimeout(() => failAuthBoot("登入服務回應逾時，請點擊重試"), AUTH_BOOT_FAILSAFE_MS);
}

function failAuthBoot(message) {
  if (authBootFailed) return;
  authBootFailed = true;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  setAuthBootMessage(message);
  document.querySelector("#auth-boot-screen i")?.classList.add("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.remove("hidden");
}

function finishAuthBoot() {
  // A late but successful resource response may arrive after the failsafe.
  // Successful completion must be allowed to clear the retry state.
  authBootFailed = false;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  document.body.classList.remove("auth-booting");
  document.body.classList.add("auth-boot-ready");
  document.querySelector("#auth-boot-screen")?.setAttribute("aria-hidden", "true");
}

function stripLiffCallbackMarker() {
  const url = new URL(location.href);
  if (!url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) return;
  url.searchParams.delete(LIFF_AUTO_CALLBACK_PARAM);
  history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
}

function captureAuthSession() {
  const currentUrl = new URL(location.href);
  if (currentUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    // The marker makes the OAuth handoff one-shot even when a browser or
    // LINE webview does not preserve sessionStorage across the handoff.
    liffOAuthCallbackSeen = true;
    markLiffLaunchContext("oauth-callback");
    stripLiffCallbackMarker();
  }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const hasAuthResponse = fragment.has("access_token") || fragment.has("error") || fragment.has("error_description");
  if (hasAuthResponse) {
    authReturnState = readAuthReturnState();
    shouldRestoreAuthReturnState = Boolean(authReturnState);
  }
  if (fragment.get("error")) {
    authReturnError = fragment.get("error") === "access_denied" ? "你已取消 LINE 登入" : "LINE 登入未完成，請稍後再試";
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













async function loadRuntimeConfig() {
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

function readLiffLaunchContext() {
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

function clearLiffLaunchContext() {
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

function hasLiffPrimaryRedirectParams(url = new URL(location.href)) {
  // LINE may omit liff.state for a plain LIFF URL, but the primary redirect
  // can still carry LIFF-only credential fields in the hash until liff.init()
  // resolves. Never treat access_token alone as LIFF: Supabase uses it too.
  const hasLiffQuery = [...url.searchParams.keys()].some((key) => key.startsWith("liff."));
  return hasLiffQuery || hasLiffCredentialFragment(url);
}

function hasLiffLaunchIntent(url = new URL(location.href)) {
  const hasPrimaryRedirect = hasLiffPrimaryRedirectParams(url);
  const hasLiffOAuthCallback = url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM);
  if (hasPrimaryRedirect || hasLiffOAuthCallback) {
    markLiffLaunchContext(hasLiffOAuthCallback ? "oauth-callback" : "primary-redirect");
    return true;
  }
  return Boolean(readLiffLaunchContext());
}

async function initializeLiffStage({ launchIntent = false, explicitLaunch = false } = {}) {
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

function clearStoredAuthSession() {
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

async function restorePersistentLiffSession() {
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

async function ensureWebSession() {
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

async function restoreWebSession() {
  const refreshed = await refreshWebSession();
  if (!refreshed || (auth.user?.id && refreshed.user_id !== auth.user.id)) return false;
  applyWebSession(refreshed);
  return true;
}

async function forgetPersistentLiffSession() {
  try { await fetch("/api/auth/session/forget", { method: "POST" }); }
  catch { /* best-effort cleanup */ }
}

function recentLiffAutoLoginAttempt() {
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

function markLiffAutoLoginAttempt() {
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

function initializeLiffBridge(initialState = null) {
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

async function syncMemberIdentityOnce() {
  const userId = auth.user?.id;
  if (!auth.accessToken || !userId || !auth.config?.authEnabled) return;
  const storageKey = `cj-identity-sync:${userId}`;
  try {
    if (sessionStorage.getItem(storageKey) === "attempted") return;
  } catch {
    // The in-memory guard below still prevents duplicate calls in restricted previews.
  }
  if (identitySyncUserId === userId && identitySyncInFlight) return identitySyncInFlight;
  identitySyncUserId = userId;
  identitySyncInFlight = fetch("/api/member/identity-sync", { method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}` } })
    .then((response) => {
      try {
        if (response.ok) sessionStorage.setItem(storageKey, "attempted");
        else sessionStorage.removeItem(storageKey);
      } catch { /* sessionStorage may be unavailable in restricted previews. */ }
      return response;
    })
    .catch(() => {
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore restricted storage */ }
      return null;
    })
    .finally(() => { identitySyncInFlight = null; });
  return identitySyncInFlight;
}

function loadMember() {
  if (memberLoadResolved) return Promise.resolve();
  if (memberLoadInFlight) return memberLoadInFlight;
  const promise = (async () => {
    if (!auth.accessToken || !auth.config?.authEnabled) return;
    try {
      const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
      if (!response.ok) throw new Error("expired");
      const user = await response.json();
      if ((auth.user?.id && auth.user.id !== user.id) || (cartSyncUserId && cartSyncUserId !== user.id)) resetMemberCartSyncState();
      if ((memberPointsCache.userId && memberPointsCache.userId !== user.id) || (lineFriendshipCache.userId && lineFriendshipCache.userId !== user.id)) clearMemberStateCache();
      auth.user = user;
      updateMemberButton();
      watchSessionExpiry();
      // Identity binding is an explicit, best-effort operation. A temporary
      // service-role/database failure must not log the member out or block catalog.
      await Promise.all([
        syncMemberIdentityOnce(),
        loadProfile(),
        loadPoints().catch(() => { auth.points = null; }),
        loadMemberCart()
      ]);
      updateMemberButton();
      if (!profileIsComplete()) showProfileDialog(true);
    } catch {
      clearStoredAuthSession();
    }
  })();
  memberLoadInFlight = promise.then((result) => {
    memberLoadResolved = true;
    return result;
  }).finally(() => {
    memberLoadInFlight = null;
  });
  return memberLoadInFlight;
}

async function loadProfile() {
  const url = new URL(`${auth.config.supabaseUrl}/rest/v1/profiles`);
  url.searchParams.set("select", "full_name,phone,birthday,address,is_admin");
  url.searchParams.set("id", `eq.${auth.user.id}`);
  const response = await fetch(url, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
  if (!response.ok) throw new Error("會員資料讀取失敗");
  const rows = await response.json();
  auth.profile = rows[0] ?? { full_name: null, phone: null, birthday: null, address: null };
}

export function profileIsComplete() {
  return Boolean(auth.profile?.full_name?.trim() && auth.profile?.phone?.trim());
}

function updateMemberButton() {
  const displayName = auth.profile?.full_name || auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "會員";
  const button = document.querySelector("[data-demo='login']");
  button.textContent = displayName;
  button.title = "查看或修改會員資料";
  document.querySelector("[data-orders-open]").classList.remove("hidden");
  document.querySelector("[data-admin-open]").classList.toggle("hidden", auth.profile?.is_admin !== true);
  if (auth.profile?.full_name) document.querySelector("#checkout-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-phone").value = auth.profile.phone;
  if (auth.profile?.address) document.querySelector("#checkout-address").value = auth.profile.address;
}

export function showProfileDialog(required = false) {
  const dialog = document.querySelector("#profile-dialog");
  const metadataName = auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "";
  document.querySelector("#profile-name").value = auth.profile?.full_name || metadataName;
  document.querySelector("#profile-phone").value = auth.profile?.phone || "";
  document.querySelector("#profile-birthday").value = auth.profile?.birthday || "";
  document.querySelector("#profile-address").value = auth.profile?.address || "";
  document.querySelector("#profile-birthday").max = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  document.querySelector("#profile-error").classList.add("hidden");
  document.querySelector(".profile-close").classList.toggle("hidden", required);
  document.querySelector("#profile-dialog-title").textContent = required ? "完成會員資料" : "會員資料";
  document.querySelector("[data-profile-copy]").textContent = required
    ? "第一次使用 LINE 登入，請先填寫基本資料。姓名與手機為必填，生日與地址可稍後補上。"
    : "可在這裡更新聯絡資料；生日與地址為選填。";
  renderMemberPoints();
  dialog.dataset.required = String(required);
  showDialog(dialog);
}

export function beginLineLogin({ automatic = false } = {}) {
  if (!auth.config?.authEnabled) {
    showToast("LINE Login 尚未在 Supabase 啟用");
    return false;
  }
  if (automatic && (liffOAuthCallbackSeen || recentLiffAutoLoginAttempt())) return false;
  if (!automatic) {
    try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
  }
  if (automatic) markLiffAutoLoginAttempt();
  saveAuthReturnState();
  saveCart();
  const redirectUrl = new URL(location.origin + location.pathname);
  if (automatic) redirectUrl.searchParams.set(LIFF_AUTO_CALLBACK_PARAM, String(Date.now()));
  const url = new URL(`${auth.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", auth.config.lineProvider);
  url.searchParams.set("redirect_to", redirectUrl.toString());
  url.searchParams.set("bot_prompt", "normal");
  // The automatic LIFF handoff must not add another history entry. Manual
  // login keeps the normal browser navigation semantics.
  if (automatic) location.replace(url.toString());
  else location.assign(url.toString());
  return true;
}

async function saveProfile(profile) {
  const response = await fetch(`${auth.config.supabaseUrl}/rest/v1/profiles?id=eq.${auth.user.id}`, {
    method: "PATCH",
    headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(profile)
  });
  if (!response.ok) throw new Error("會員資料儲存失敗");
  const rows = await response.json();
  if (!rows.length) throw new Error("找不到會員資料，請重新登入後再試");
  auth.profile = rows[0];
  updateMemberButton();
}

async function submitProfile(event) {
  event.preventDefault();
  const submitButton = document.querySelector(".profile-submit");
  const fullName = document.querySelector("#profile-name").value.trim();
  const rawPhone = document.querySelector("#profile-phone").value.trim();
  const phone = rawPhone.replace(/[\s-]/g, "");
  const birthday = document.querySelector("#profile-birthday").value || null;
  const address = document.querySelector("#profile-address").value.trim() || null;
  document.querySelector("#profile-error").classList.add("hidden");
  if (!fullName) return showProfileError("請填寫姓名");
  if (!/^09\d{8}$/.test(phone)) return showProfileError("請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  submitButton.disabled = true;
  submitButton.textContent = "儲存中…";
  try {
    await saveProfile({ full_name: fullName, phone, birthday, address });
    document.querySelector("#checkout-name").value = fullName;
    document.querySelector("#checkout-phone").value = phone;
    closeDialog(document.querySelector("#profile-dialog"));
    showToast("會員資料已儲存", "success");
    const pendingCheckout = pendingReturnCheckout;
    pendingReturnCheckout = null;
    if (pendingCheckout) {
      await openCheckout(pendingCheckout.scope || undefined);
      if (document.querySelector("#checkout-dialog")?.open) restoreCheckoutReturnState(pendingCheckout);
      else pendingReturnCheckout = pendingCheckout;
    }
  } catch (error) {
    showProfileError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "儲存會員資料";
  }
}

function showProfileError(message) {
  const errorNode = document.querySelector("#profile-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

export async function openCheckout(scope = null) {
  const groups = cartGroups();
  const resolvedScope = scope || activeCheckoutScope || (groups.preorder.length ? "preorder" : "in_stock");
  const scopedItems = cartItemsForScope(resolvedScope);
  if (!scopedItems.length) return showToast("請先加入商品");
  activeCheckoutScope = resolvedScope;
  activeCheckoutItems = scopedItems.slice();
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const cartMethod = selectedCartDeliveryMethod(resolvedScope);
  syncCheckoutSellerOption();
  const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${cartMethod}']`);
  if (deliveryInput) deliveryInput.checked = true;
  try { await loadPoints(); } catch { /* 結帳仍可不使用優惠 */ }
  if (document.querySelector("#cart-drawer").classList.contains("open")) toggleCart();
  ensurePaymentMethodUI();
  renderCheckoutBenefits();
  const couponInput = document.querySelector("#checkout-coupon-code");
  const pointsInput = document.querySelector("#checkout-points");
  if (couponInput) couponInput.value = "";
  if (pointsInput) pointsInput.value = "0";
  syncDeliveryFields();
  renderCheckoutSummary();
  setCheckoutStage("details", { focus: false });
  clearCheckoutFieldErrors();
  document.querySelector("#checkout-error").classList.add("hidden");
  showDialog(document.querySelector("#checkout-dialog"));
  await loadBankAccounts();
}

export function showCheckoutError(message) {
  const errorNode = document.querySelector("#checkout-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

async function submitOrder() {
  if (!auth.config?.authEnabled) return showToast("目前為靜態預覽，尚未連接訂單資料庫");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const details = validateCheckoutDetails();
  const itemsForOrder = checkoutCartItems().slice();
  const pickupPlan = "together";
  await saveProfile({ full_name: details.fullName, phone: details.normalizedPhone, birthday: auth.profile?.birthday || null, address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : (auth.profile?.address || null) });
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: itemsForOrder.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, delivery_method: details.deliveryMethod, payment_method: details.paymentMethod, shipping_address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : null, shipping_recipient_name: details.deliveryMethod === "home_delivery" ? details.shippingRecipientName : null, shipping_phone: details.deliveryMethod === "home_delivery" ? details.normalizedShippingPhone : null, bank_account_id: details.bankAccountId, coupon_code: document.querySelector("#checkout-coupon-code")?.value.trim() || null, points_to_redeem: Number(document.querySelector("#checkout-points")?.value || 0) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  await loadPoints({ force: true }).catch(() => {});
  cart.splice(0, cart.length, ...cart.filter((item) => !itemsForOrder.includes(item)));
  saveCart(); await syncMemberCartNow(); renderCart(); activeCheckoutItems = null; activeCheckoutScope = null; closeDialog(document.querySelector("#checkout-dialog"));
  showPaymentDialog(result.order);
}

document.addEventListener("click", (event) => {
  const copyAccount = event.target.closest("[data-copy-bank-account]");
  if (copyAccount) {
    const value = copyAccount.dataset.copyBankAccount || "";
    const copyPromise = navigator.clipboard?.writeText(value);
    if (!copyPromise) return showToast("目前瀏覽器不支援複製帳號", "warning");
    copyPromise.then(() => {
      const original = copyAccount.textContent;
      copyAccount.textContent = "已複製";
      showToast("匯款帳號已複製", "success");
      window.setTimeout(() => { copyAccount.textContent = original; }, 1800);
    }).catch(() => showToast("複製帳號失敗，請手動選取", "warning"));
    return;
  }
  const add = event.target.closest("[data-add]"); if (add) addToCartWithFeedback(add.dataset.add, add);
  const heroAdd = event.target.closest("[data-hero-add]"); if (heroAdd) addToCartWithFeedback(heroAdd.dataset.heroAdd, heroAdd);
  const change = event.target.closest("[data-quantity]"); if (change) { const item = cart.find((entry) => entry.id === change.dataset.quantity); const delta = Number(change.dataset.delta); const max = products.find((product) => product.id === item.id).stock; item.quantity = Math.min(max, item.quantity + delta); if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const remove = event.target.closest("[data-remove]"); if (remove) { const item = cart.find((entry) => entry.id === remove.dataset.remove); cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const detail = event.target.closest("[data-detail]"); if (detail) openProductDetail(detail.dataset.detail);
  const buyNow = event.target.closest("[data-buy-now]"); if (buyNow && !buyNow.disabled) buyNowFromCard(buyNow.dataset.buyNow);
  if (event.target.closest("[data-cart-toggle]")) toggleCart();
  const scopedCheckout = event.target.closest("[data-checkout-scope]");
  if (scopedCheckout) handleCartCheckout(scopedCheckout.dataset.checkoutScope);
  else if (event.target.closest("[data-checkout]")) handleCartCheckout();
  if (event.target.closest("[data-admin-open]") && !openAdminInNewTab()) openAdmin();
  if (event.target.closest("[data-admin-close]")) closeDialog(document.querySelector("#admin-dialog"));
  const adminQuickFilter = event.target.closest("[data-admin-quick-filter]");
  if (adminQuickFilter) applyAdminQuickFilter(adminQuickFilter.dataset.adminQuickFilter);
  const lowStockVariant = event.target.closest("[data-admin-low-stock-variant]");
  if (lowStockVariant) {
    const variantSelect = document.querySelector("#admin-inventory-variant");
    if (variantSelect) variantSelect.value = lowStockVariant.dataset.adminLowStockVariant;
    document.querySelector("#admin-inventory-delta")?.focus();
  }
  if (event.target.closest("[data-checkout-close]")) closeDialog(document.querySelector("#checkout-dialog"));
  if (event.target.closest("[data-checkout-review-next]")) openCheckoutReview();
  if (event.target.closest("[data-checkout-details-back]")) setCheckoutStage("details");
  if (event.target.closest("[data-demo='login']")) auth.user ? showProfileDialog(false) : beginLineLogin();
  if (event.target.closest("[data-profile-close]")) closeDialog(document.querySelector("#profile-dialog"));
  if (event.target.closest("[data-orders-open]")) openOrders();
  if (event.target.closest("[data-orders-close]")) closeDialog(document.querySelector("#orders-dialog"));
  if (event.target.closest("[data-orders-shop]")) { closeDialog(document.querySelector("#orders-dialog")); scrollToAnchor("product-search-bar"); }
  const lineFriendRequest = event.target.closest("[data-line-friend-request]");
  if (lineFriendRequest && canRequestLineFriendship()) {
    event.preventDefault();
    handleLineFriendRequest(lineFriendRequest);
    return;
  }
  if (event.target.closest("[data-payment-close], [data-payment-later]")) closeDialog(document.querySelector("#payment-dialog"));
  const lineFriendCheck = event.target.closest("[data-line-friend-check]");
  if (lineFriendCheck) {
    lineFriendCheck.disabled = true;
    lineFriendCheck.textContent = "檢查中…";
    document.querySelector("#line-friend-error")?.classList.add("hidden");
    checkLineFriendship({ force: true }).then((isFriend) => {
      if (!isFriend) return showLineFriendDialog();
      closeDialog(document.querySelector("#line-friend-dialog"));
      return openCheckout(activeCheckoutScope);
    }).catch((error) => showLineFriendDialog(error.message)).finally(() => {
      lineFriendCheck.disabled = false;
      lineFriendCheck.textContent = "我已加入，重新檢查";
    });
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) switchAdminTab(adminTab.dataset.adminTab);
  if (event.target.closest("[data-admin-refresh]")) loadAdminData().catch((error) => showToast(error.message, "error"));
  if (event.target.closest("[data-telegram-test]")) testTelegramNotification().catch((error) => showToast(error.message, "error"));
  if (event.target.closest("[data-birthday-issue]")) issueBirthdayCouponsNow().catch((error) => showToast(error.message, "error"));
  const adminPageButton = event.target.closest("[data-admin-page]");
  if (adminPageButton) {
    const section = adminPageButton.dataset.adminPage;
    const delta = Number(adminPageButton.dataset.adminPageDelta || 0);
    adminPageButton.disabled = true;
    changeAdminPage(section, delta).catch((error) => showToast(error.message, "error")).finally(() => { adminPageButton.disabled = false; });
    return;
  }
  const notificationRequeueButton = event.target.closest("[data-admin-notification-requeue]");
  if (notificationRequeueButton) {
    requeueAdminNotification(notificationRequeueButton).catch((error) => showToast(error.message, "error"));
    return;
  }
  if (event.target.closest("[data-admin-category-focus]")) focusAdminCategoryForm();
  if (event.target.closest("[data-admin-category-cancel]")) resetAdminCategoryForm();
  const categoryEdit = event.target.closest("[data-admin-category-edit]");
  if (categoryEdit) editAdminCategory(categoryEdit.dataset.adminCategoryEdit);
  const accountEdit = event.target.closest("[data-account-edit]");
  if (accountEdit) editAccount(accountEdit.dataset.accountEdit);
  if (event.target.closest("[data-account-cancel]")) resetAccountForm();
  if (event.target.closest("[data-coupon-reset]")) resetCouponForm();
  const couponEdit = event.target.closest("[data-coupon-edit]");
  if (couponEdit) editCoupon(couponEdit.dataset.couponEdit);
  const paymentOrderButton = event.target.closest("[data-order-payment]");
  if (paymentOrderButton) {
    const order = currentOrders.find((item) => item.id === paymentOrderButton.dataset.orderPayment);
    if (order) { closeDialog(document.querySelector("#orders-dialog")); showPaymentDialog(order); }
  }
});
document.addEventListener("error", handleAdminProductImageError, true);
document.addEventListener("change", (event) => {
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
  if (event.target.matches("#admin-order-status-filter")) reloadAdminList("orders", true);
  if (event.target.matches("#admin-product-status")) reloadAdminList("products", true);
  if (event.target.matches("#admin-audit-resource, #admin-audit-action")) reloadAdminList("audit", true);
  if (event.target.matches("#admin-notification-channel, #admin-notification-status")) reloadAdminList("notifications", true);
  if (event.target.matches("#point-max-mode")) syncPointMaxHint();
  if (event.target.matches("#admin-kind")) syncDepositField(event.target, document.querySelector("#admin-deposit-rate"));
  if (event.target.matches("#admin-new-kind")) syncDepositField(event.target, document.querySelector("#admin-new-deposit-rate"));
  if (event.target.matches("[data-edit-variant-form] select[name='kind']")) syncDepositField(event.target, event.target.form.elements.deposit_rate);
  if (event.target.matches("input[name='delivery_method']")) {
    if (activeCheckoutScope) setCartGroupDeliveryMethod(activeCheckoutScope, event.target.value);
    syncDeliveryFields();
  }
  if (event.target.matches("input[name='cart_delivery_method']")) setCartDeliveryMethod(event.target.value);
  if (event.target.matches("input[data-group-delivery]")) setCartGroupDeliveryMethod(event.target.dataset.groupDelivery, event.target.value);
  if (event.target.matches("input[name='payment_method']")) syncPaymentFields();
});
document.addEventListener("input", (event) => {
  if (event.target.matches("#admin-order-search")) reloadAdminList("orders");
  if (event.target.matches("#admin-member-search")) reloadAdminList("members");
  if (event.target.matches("#admin-product-search")) reloadAdminList("products");
  if (event.target.matches("#checkout-points")) renderCheckoutSummary();
  if (event.target.matches("#checkout-coupon-code")) renderCheckoutSummary();
  if (event.target.matches("#checkout-address")) renderCheckoutSummary();
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
});
document.addEventListener("submit", async (event) => {
  if (event.target.matches("#admin-coupon-form")) {
    try { await submitCoupon(event); } catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("#birthday-coupon-form")) {
    try { await submitBirthdaySettings(event); } catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-points-form]")) {
    try { await submitMemberPointAdjustment(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-order-form]")) {
    try { await submitAdminOrderTransition(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-return-form]")) {
    try { await submitAdminOrderReturn(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-fulfillment-form]")) {
    try { await submitAdminOrderFulfillment(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (!event.target.matches("[data-edit-product-form], [data-edit-variant-form]")) return;
  try { await submitDynamicAdminForm(event); }
  catch (error) { showToast(error.message, "error"); }
});
initAnchorScroll();
export const productPage = createProductPage({
  getProducts: () => products,
  addToCart: addVariantQuantityToCart,
  showToast,
  showDialog,
  closeDialog
});
initAdminProductGallery({
  adminFetch,
  prepareProductImage,
  showToast,
  getProduct: (id) => (adminData?.products || []).find((product) => product.id === id),
  fallbackMarkup: adminProductImageFallbackMarkup
});
initAdminTab({
  isLiffClient: () => Boolean(liffState.isInClient),
  isLoggedIn: () => Boolean(auth.user && auth.accessToken),
  isAdmin: () => auth.profile?.is_admin === true,
  openAdmin,
  showToast
});
initAuthExpiry({
  getAccessToken: () => auth.accessToken,
  // LINE App 內用保存的 LIFF 工作階段、一般瀏覽器用 HttpOnly cookie（web-session.js）換發新 token
  tryRestore: () => (liffState.isInClient ? restorePersistentLiffSession() : restoreWebSession()),
  clearSession: clearStoredAuthSession,
  closeDialog,
  showToast
});
initAdminProductsTable({
  getProducts: () => adminData?.products || [],
  adminFetch,
  showToast,
  adminCategoryOptions,
  splitPreorderArrival,
  fallbackMarkup: adminProductImageFallbackMarkup,
  onCatalogChanged: invalidateAdminManagementOptions
});
initAdminShell({
  getStats: () => (adminData?.stats && Object.keys(adminData.stats).length ? adminData.stats : null),
  getOverview: () => adminData?.overview || null,
  switchAdminTab,
  reloadAdminList,
  loadAdminSection,
  adminFetch,
  formatDateTime,
  orderStatusLabel: (order) => adminOrderStatusLabel(order)
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { activeCategory = button.dataset.category; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); renderProducts(); }));
search.addEventListener("input", renderProducts);
document.querySelector("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.checkoutStage !== "review") {
    openCheckoutReview();
    return;
  }
  const submitButton = document.querySelector(".checkout-submit");
  document.querySelector("#checkout-error").classList.add("hidden");
  submitButton.disabled = true;
  submitButton.textContent = "建立訂單中…";
  try { await submitOrder(); }
  catch (error) { showCheckoutError(error.message); }
  finally {
    submitButton.disabled = bankAccounts.length === 0;
    submitButton.textContent = "建立訂單並取得匯款資訊";
  }
});
document.querySelector("#payment-form").addEventListener("submit", submitPayment);
document.querySelector("#profile-form").addEventListener("submit", submitProfile);
document.querySelector("#admin-account-form").addEventListener("submit", async (event) => { try { await submitAdminAccount(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-category-form").addEventListener("submit", async (event) => { try { await submitAdminCategory(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-product-form").addEventListener("submit", async (event) => { try { await submitAdminProduct(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-variant-form").addEventListener("submit", async (event) => { try { await submitNewVariant(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-inventory-form").addEventListener("submit", async (event) => { try { await submitInventoryAdjustment(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-point-settings-form").addEventListener("submit", async (event) => { try { await submitPointSettings(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#profile-dialog").addEventListener("cancel", (event) => {
  if (event.currentTarget.dataset.required === "true") event.preventDefault();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("close", syncPageScrollLock);
});

function renderInitialPageOnce() {
  if (initialPageRendered) return;
  initialPageRendered = true;
  renderHeroSpotlight();
  renderProducts();
  renderCart();
  productPage.sync();
}

async function bootstrapAuth() {
  if (authBootstrapInFlight) return authBootstrapInFlight;
  authBootstrapInFlight = (async () => {
    removeLegacyShippingUI();
    removeLegacySellerCheckoutOption();
    const bootUrl = new URL(location.href);
    // Overlap the LIFF SDK download with /api/config for LINE launches only;
    // ordinary browsers never load the SDK.
    if (hasLiffPrimaryRedirectParams(bootUrl) || bootUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM) || readLiffLaunchContext()) preloadLiffSdk();
    const configLoaded = await loadRuntimeConfig();
    const liffPrimaryRedirect = hasLiffPrimaryRedirectParams(bootUrl);
    const explicitLiffLaunch = liffPrimaryRedirect || bootUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM);
    const liffLaunchIntent = hasLiffLaunchIntent(bootUrl);
    if (!configLoaded && explicitLiffLaunch) throw new Error("登入服務設定載入失敗");
    if (!configLoaded && liffLaunchIntent) clearLiffLaunchContext();
    // LIFF primary redirects can carry LINE-owned access_token/id_token fields
    // in the hash until liff.init() resolves. Only normal browser OAuth and
    // the cj_liff_oauth callback may be captured before LIFF initialization.
    if (!liffPrimaryRedirect) captureAuthSession();
    const liffStage = await initializeLiffStage({
      launchIntent: configLoaded && liffLaunchIntent,
      explicitLaunch: explicitLiffLaunch
    });
    if (liffStage.primary) return;
    if (liffPrimaryRedirect) captureAuthSession();
    loadLocalCart();
    const liffRedirecting = liffLaunchIntent && liffStage.initialized && liffStage.state?.isInClient
      ? await initializeLiffBridge(liffStage.state)
      : false;
    if (liffRedirecting) return;
    await loadProducts();
    renderInitialPageOnce();
    await waitForHeroImageDecode();
    finishAuthBoot();
    // Member/session restoration continues after the public catalog is usable,
    // so a slow auth request cannot keep ordinary browsers behind the boot UI.
    if (!liffStage.state?.isInClient) await ensureWebSession();
    await loadMember();
    await restoreAuthReturnState();
    openAdminFromRoute();
  })();
  return authBootstrapInFlight;
}

startAuthBoot();
try {
  await bootstrapAuth();
} catch (error) {
  console.error("App bootstrap failed.", error);
  if (liffPrimaryRedirectPending || hasLiffPrimaryRedirectParams() || new URL(location.href).searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    failAuthBoot("LINE 登入頁面準備失敗，請點擊重試");
  } else {
    renderInitialPageOnce();
    finishAuthBoot();
    showToast("頁面載入較慢，部分會員資料可能需要重新整理", "error");
  }
}
