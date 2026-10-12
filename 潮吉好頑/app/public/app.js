import { canRequestLineFriendship, liffState, preloadLiffSdk } from "./liff-auth.js";
import { createProductPage } from "./product-page.js";
import { initAnchorScroll, scrollToAnchor } from "./anchor-scroll.js";
import { initAuthExpiry } from "./auth-expiry.js";
import { initAdminTab, openAdminFromRoute, openAdminInNewTab } from "./admin-tab.js";
import { openAdminLazy } from "./admin-loader.js";
import { auth, closeDialog, showDialog, showToast, syncPageScrollLock } from "./app-core.js";
import { addToCartWithFeedback, addVariantQuantityToCart, buyNowFromCard, buyNowVariant, cart, freezeBootCartBaseline, handleCartCheckout, loadLocalCart, releaseBootCartBaseline, renderCart, saveCart, setCartDeliveryMethod, setCartGroupDeliveryMethod, toggleCart } from "./cart.js";
import { bankAccounts, clearCheckoutFieldErrorFor, openCheckoutReview, renderCheckoutSummary, setCheckoutStage, syncDeliveryFields, syncPaymentFields } from "./checkout-form.js";
import { checkLineFriendship, handleLineFriendRequest, showLineFriendDialog } from "./member-benefits.js";
import { currentOrders, openOrders, showPaymentDialog, submitPayment } from "./member-orders.js";
import { loadProducts, openProductDetail, products, renderHeroSpotlight, renderProducts, search, selectCategory } from "./storefront-catalog.js";
import { markAuthSettled, whenAuthReady } from "./auth-ready.js";
import { failAuthBoot, finishAuthBoot, startAuthBoot } from "./auth-boot.js";
import { restoreAuthReturnState } from "./auth-return-state.js";
import { activeCheckoutScope, openCheckout, showCheckoutError, submitOrder } from "./checkout-flow.js";
import { applyCheckoutCoupon, handleCouponInputChange, removeCheckoutCoupon } from "./checkout-coupon.js";
import { LIFF_AUTO_CALLBACK_PARAM, captureAuthSession, clearLiffLaunchContext, clearStoredAuthSession, ensureWebSession, hasLiffLaunchIntent, hasLiffPrimaryRedirectParams, initializeLiffBridge, initializeLiffStage, liffPrimaryRedirectPending, loadRuntimeConfig, readLiffLaunchContext, restorePersistentLiffSession, restoreWebSession } from "./liff-session.js";
import { beginLineLogin, loadMember, showProfileDialog, submitProfile } from "./member-profile.js";
import { handleCopyBankAccount } from "./copy-bank-account.js";

let authBootstrapInFlight = null;
let initialPageRendered = false;

document.addEventListener("click", (event) => {
  if (handleCopyBankAccount(event)) return;
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
  if (event.target.closest("[data-admin-open]") && !openAdminInNewTab()) openAdminLazy();
  if (event.target.closest("[data-admin-close]")) closeDialog(document.querySelector("#admin-dialog"));
  if (event.target.closest("[data-checkout-close]")) closeDialog(document.querySelector("#checkout-dialog"));
  if (event.target.closest("[data-checkout-review-next]")) openCheckoutReview();
  if (event.target.closest("[data-checkout-details-back]")) setCheckoutStage("details");
  const couponButton = event.target.closest("[data-checkout-coupon-apply]");
  if (couponButton) {
    if (couponButton.dataset.action === "remove") { removeCheckoutCoupon(); renderCheckoutSummary(); }
    else applyCheckoutCoupon().then(renderCheckoutSummary);
  }
  if (event.target.closest("[data-demo='login']")) openMemberEntry();
  if (event.target.closest("[data-profile-close]")) closeDialog(document.querySelector("#profile-dialog"));
  if (event.target.closest("[data-orders-open]")) openOrders();
  if (event.target.closest("[data-orders-close]")) closeDialog(document.querySelector("#orders-dialog"));
  if (event.target.closest("[data-orders-shop]")) { closeDialog(document.querySelector("#orders-dialog")); scrollToAnchor("quick-pick"); }
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
  const paymentOrderButton = event.target.closest("[data-order-payment]");
  if (paymentOrderButton) {
    const order = currentOrders.find((item) => item.id === paymentOrderButton.dataset.orderPayment);
    if (order) { closeDialog(document.querySelector("#orders-dialog")); showPaymentDialog(order); }
  }
});
document.addEventListener("change", (event) => {
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
  if (event.target.matches("input[name='delivery_method']")) {
    if (activeCheckoutScope) setCartGroupDeliveryMethod(activeCheckoutScope, event.target.value);
    syncDeliveryFields();
  }
  if (event.target.matches("input[name='cart_delivery_method']")) setCartDeliveryMethod(event.target.value);
  if (event.target.matches("input[data-group-delivery]")) setCartGroupDeliveryMethod(event.target.dataset.groupDelivery, event.target.value);
  if (event.target.matches("input[name='payment_method']")) syncPaymentFields();
});
document.addEventListener("input", (event) => {
  if (event.target.matches("#checkout-points")) renderCheckoutSummary();
  if (event.target.matches("#checkout-coupon-code")) { handleCouponInputChange(); renderCheckoutSummary(); }
  if (event.target.matches("#checkout-address")) renderCheckoutSummary();
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
});
initAnchorScroll();
export const productPage = createProductPage({
  getProducts: () => products,
  addToCart: addVariantQuantityToCart,
  buyNow: buyNowVariant,
  showToast,
  showDialog,
  closeDialog
});
initAdminTab({
  isLiffClient: () => Boolean(liffState.isInClient),
  isLoggedIn: () => Boolean(auth.user && auth.accessToken),
  isAdmin: () => auth.profile?.is_admin === true,
  openAdmin: openAdminLazy,
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
// 分類按鈕由 storefront-catalog.js 依型錄動態產生，以事件委派處理
document.querySelector(".filter-row")?.addEventListener("click", (event) => {
  const button = event.target.closest(".filter[data-category]");
  if (button) selectCategory(button.dataset.category);
});
search.addEventListener("input", renderProducts);
// 在優惠碼欄按 Enter 是「套用」，不直接送出建立訂單
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches?.("#checkout-coupon-code")) return;
  event.preventDefault();
  applyCheckoutCoupon().then(renderCheckoutSummary);
});
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
document.querySelector("#profile-dialog").addEventListener("cancel", (event) => {
  if (event.currentTarget.dataset.required === "true") event.preventDefault();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("close", syncPageScrollLock);
});

// 會員按鈕：等背景登入完成再決定開會員資料或前往 LINE 登入；等待中連點只算一次，不重複發起 OAuth
let memberEntryPending = false;
// 從 LINE 授權頁按上一頁、頁面由 bfcache 還原時，JS 狀態仍在：解除鎖定才能再按登入
window.addEventListener("pageshow", (event) => { if (event.persisted) memberEntryPending = false; });
async function openMemberEntry() {
  if (memberEntryPending) return;
  memberEntryPending = true;
  await whenAuthReady();
  if (auth.user) showProfileDialog(false);
  // 已開始前往 LINE 授權頁時維持鎖定，避免頁面離開前再點一次
  else if (beginLineLogin()) return;
  memberEntryPending = false;
}

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
    const bootUrl = new URL(location.href);
    // 公開型錄不需要登入：一開機就開始載入，與設定、LIFF 初始化和登入恢復同時進行（loadProducts 不會丟錯）
    const catalogLoading = loadProducts();
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
    const inLineClient = Boolean(liffStage.state?.isInClient);
    const liffBridge = liffLaunchIntent && liffStage.initialized && inLineClient
      ? initializeLiffBridge(liffStage.state)
      : Promise.resolve(false);
    // 型錄優先：LINE 登入在背景恢復，需要會員的入口（登入、結帳、我的訂單）會等 whenAuthReady；
    // 橋接不會自動整頁跳 OAuth，沒有可恢復登入的客人維持訪客身分。
    await catalogLoading;
    // 購物車只存商品 id，要等正式型錄載入後才能對回商品；型錄失敗時 loadLocalCart 會略過，保留原本的購物車。
    loadLocalCart();
    // 背景登入完成前就能加入商品：先固定購物車基準，換會員時才分得出哪些是剛加入的
    freezeBootCartBaseline();
    renderInitialPageOnce();
    // 主圖不再擋開機畫面：商品頁先出現，主圖（fetchpriority=high）自行載入
    finishAuthBoot();
    await liffBridge;
    // Member/session restoration continues after the public catalog is usable,
    // so a slow auth request cannot keep ordinary browsers behind the boot UI.
    if (!inLineClient) await ensureWebSession();
    await loadMember();
    releaseBootCartBaseline();
    // 回到登入前的結帳等畫面會呼叫 openCheckout（會等 whenAuthReady），必須先標記完成
    markAuthSettled();
    await restoreAuthReturnState();
    openAdminFromRoute();
  })();
  return authBootstrapInFlight;
}

startAuthBoot();
try {
  await bootstrapAuth();
} catch (error) {
  releaseBootCartBaseline();
  markAuthSettled();
  console.error("App bootstrap failed.", error);
  if (liffPrimaryRedirectPending || hasLiffPrimaryRedirectParams() || new URL(location.href).searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    failAuthBoot("LINE 登入頁面準備失敗，請點擊重試");
  } else {
    renderInitialPageOnce();
    finishAuthBoot();
    showToast("頁面載入較慢，部分會員資料可能需要重新整理", "error");
  }
}
