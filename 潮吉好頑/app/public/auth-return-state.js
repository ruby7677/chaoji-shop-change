// 登入回跳狀態：LINE 登入前保存頁面、購物車與結帳進度，登入回來（或補完會員資料）後還原。
import { auth, showToast } from "./app-core.js";
import { selectedDeliveryMethod, toggleCart } from "./cart.js";
import { renderCheckoutBenefits, renderCheckoutSummary, setCheckoutStage, syncDeliveryFields } from "./checkout-form.js";
import { activeCheckoutItems, activeCheckoutScope, openCheckout, selectCheckoutScope } from "./checkout-flow.js";
import { profileIsComplete } from "./member-profile.js";

const AUTH_RETURN_STATE_KEY = "chaoji:auth-return-state";
const AUTH_RETURN_MAX_AGE_MS = 10 * 60 * 1000;

let authReturnState = null;
let shouldRestoreAuthReturnState = false;
let authReturnError = null;
let pendingReturnCheckout = null;

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

export function saveAuthReturnState() {
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

/** 登入回呼（#access_token／#error）時讀回登入前保存的頁面狀態，並記下登入失敗訊息，待登入完成後還原。 */
export function captureAuthReturn(fragment) {
  const hasAuthResponse = fragment.has("access_token") || fragment.has("error") || fragment.has("error_description");
  if (hasAuthResponse) {
    authReturnState = readAuthReturnState();
    shouldRestoreAuthReturnState = Boolean(authReturnState);
  }
  if (fragment.get("error")) {
    authReturnError = fragment.get("error") === "access_denied" ? "你已取消 LINE 登入" : "LINE 登入未完成，請稍後再試";
  }
}

/** 補完會員資料後，繼續登入前未完成的結帳。 */
export async function resumePendingReturnCheckout() {
  const pendingCheckout = pendingReturnCheckout;
  pendingReturnCheckout = null;
  if (pendingCheckout) {
    await openCheckout(pendingCheckout.scope || undefined);
    if (document.querySelector("#checkout-dialog")?.open) restoreCheckoutReturnState(pendingCheckout);
    else pendingReturnCheckout = pendingCheckout;
  }
}

export async function restoreAuthReturnState() {
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
    selectCheckoutScope(state.checkout.scope);
    if (!document.querySelector("#cart-drawer")?.classList.contains("open")) toggleCart();
  } else if (state.cartOpen && !document.querySelector("#cart-drawer")?.classList.contains("open")) {
    toggleCart();
  }
  if (authReturnError) { showToast(authReturnError, "error"); authReturnError = null; }
}
