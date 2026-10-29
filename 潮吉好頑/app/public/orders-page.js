// 獨立訂單頁（/orders）：LINE 圖文選單與訂單通知「查看訂單」開啟的小視窗。
// 只載入登入、訂單與回報匯款末五碼，不載入型錄與商品圖，開啟一次只需要少數幾個 Worker 請求。
import { escapeHtml } from "./product-format.js";
import { closeDialog, showDialog, showToast } from "./app-core.js";
import { initializeLiffClient, preloadLiffSdk } from "./liff-auth.js";
import { refreshWebSession } from "./web-session.js";
import { handleCopyBankAccount } from "./copy-bank-account.js";
import { applyPaymentFormMode, orderCardMarkup, ordersEmptyMarkup, paymentLastFiveDefault, paymentOrderView, reportPayment } from "./order-views.js";
import { cachedAccessToken, forgetAccessToken, rememberAccessToken, restoreOrdersSession } from "./orders-session.js";
import { takeEmbeddedConfig } from "./embedded-config.js";
import { markBoot, noteBootResponse, reportBootTiming } from "./boot-timing.js";

// module 執行時整棵 import 樹已載完（計時報告的「JS」時間點）
markBoot("JS 載入完成");

const list = document.querySelector("#orders-list");
const paymentDialog = document.querySelector("#payment-dialog");
let config = null;
// 先以 UA 判斷（用快取 token 時不初始化 LIFF），LIFF 初始化後以 isInClient 為準
let inLineClient = /\bLine\//i.test(navigator.userAgent);
let accessToken = null;
let orders = [];
// 恢復登入時 Worker 一併回傳的訂單：只用一次，之後（重新整理、回報匯款後）照常請求
let restoredOrders = null;
let activeOrder = null;

const SKELETON = '<div class="skeleton-stack" role="status" aria-label="載入訂單中"><div class="skeleton-card"><span></span><i></i><i></i></div><div class="skeleton-card"><span></span><i></i><i></i></div></div>';

// 商店入口：LINE 內開啟商店的 LIFF（完整尺寸），一般瀏覽器回首頁
function shopUrl() {
  return inLineClient && config?.liffId ? `https://liff.line.me/${config.liffId}` : "/";
}

function syncShopLinks() {
  document.querySelectorAll("[data-shop-link]").forEach((link) => { link.href = shopUrl(); });
}

function showMessage(title, message, { action = "shop", label = "前往商店" } = {}) {
  const button = action === "retry"
    ? `<button class="secondary-button" type="button" data-orders-refresh>${escapeHtml(label)}</button>`
    : `<a class="secondary-button" data-shop-link href="${escapeHtml(shopUrl())}">${escapeHtml(label)}</a>`;
  list.innerHTML = `<div class="orders-empty"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>${button}</div>`;
}

// 先用 Worker 內嵌在 HTML 的設定（src/orders-page.ts）；沒有內嵌時才請求，且不用瀏覽器快取的舊設定
// （Worker 回應可快取 5 分鐘），避免新設定的訂單頁 LIFF ID 還沒生效
async function loadConfig() {
  config = takeEmbeddedConfig();
  if (config) return;
  const response = await fetch("/api/config", { cache: "no-cache" });
  if (!response.ok) throw new Error("設定載入失敗");
  config = await response.json();
}

// 回傳 access token；"redirect" 表示正在前往 LINE 登入；null 表示需要先到商店登入
async function obtainAccessToken({ useCache = true } = {}) {
  if (useCache) {
    const cached = cachedAccessToken();
    if (cached) return cached;
  }
  let state = null;
  let liffError = null;
  if (config.ordersLiffId) {
    try {
      state = await initializeLiffClient(config.ordersLiffId);
      markBoot("LIFF 初始化");
    }
    catch (error) { liffError = error; console.warn("Orders LIFF unavailable; trying the web session.", error); }
  }
  // 只有 LIFF 真的初始化成功且在 LINE App 內，才走 LIFF 恢復登入；UA 判斷只用來決定商店連結
  if (state?.initialized) inLineClient = Boolean(state.isInClient);
  syncShopLinks();
  if (state?.initialized && state.isInClient) {
    if (!state.loggedIn) {
      globalThis.liff.login({ redirectUri: location.href });
      return "redirect";
    }
    const restored = await restoreOrdersSession({ idToken: state.idToken, fetchImpl: noteRestoreResponse });
    if (restored.outcome === "retry") throw new Error("登入服務暫時忙碌，請稍後再試");
    if (restored.outcome !== "restored") return null;
    rememberAccessToken(restored.accessToken);
    restoredOrders = restored.orders || null;
    return restored.accessToken;
  }
  const refreshed = await refreshWebSession();
  if (refreshed) {
    rememberAccessToken(refreshed.access_token);
    return refreshed.access_token;
  }
  // 在 LINE 內卻無法啟動 LIFF：顯示原因並讓客人重新載入，而不是誤導成「請先登入」
  if (inLineClient && (liffError || !config.ordersLiffId)) throw new Error("LINE 登入元件啟動失敗，請關閉視窗後重新開啟");
  return null;
}

// 計時報告記下登入恢復的狀態碼與執行機房（未開計時時不做任何事）
async function noteRestoreResponse(...args) {
  const response = await fetch(...args);
  noteBootResponse("恢復", response);
  return response;
}

async function fetchOrders(token) {
  const response = await fetch("/api/orders", { headers: { Authorization: `Bearer ${token}` } });
  noteBootResponse("訂單", response);
  const result = await response.json().catch(() => ({}));
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(result.error || "訂單紀錄載入失敗");
  return Array.isArray(result.orders) ? result.orders : [];
}

function renderOrders() {
  list.innerHTML = orders.length ? orders.map(orderCardMarkup).join("") : ordersEmptyMarkup();
  list.querySelector("[data-orders-shop]")?.replaceWith(Object.assign(document.createElement("a"), { className: "secondary-button", href: shopUrl(), textContent: "前往商品區" }));
}

async function loadOrders({ useCache = true } = {}) {
  list.setAttribute("aria-busy", "true");
  list.innerHTML = SKELETON;
  try {
    if (!config?.ordersLiffId) await loadConfig();
    syncShopLinks();
    accessToken = await obtainAccessToken({ useCache });
    if (accessToken === "redirect") return;
    if (accessToken) markBoot("訂單頁登入");
    if (!accessToken) {
      return showMessage("請先登入商店", inLineClient
        ? "第一次使用請先開啟商店完成 LINE 登入，之後從選單點「我的訂單」就能直接查看。"
        : "請在 LINE 官方帳號選單開啟，或前往商店以 LINE 登入後查看訂單。", { label: "前往商店登入" });
    }
    let result = restoredOrders || await fetchOrders(accessToken);
    restoredOrders = null;
    // 保存的 token 已失效：清掉後重新恢復一次
    if (result === null && useCache) {
      forgetAccessToken();
      return loadOrders({ useCache: false });
    }
    if (result === null) return showMessage("登入已失效", "請前往商店重新以 LINE 登入。", { label: "前往商店登入" });
    orders = result;
    renderOrders();
  } catch (error) {
    showMessage("訂單暫時無法載入", error.message || "請稍後再試", { action: "retry", label: "重新載入" });
  } finally {
    list.removeAttribute("aria-busy");
  }
}

function openPayment(order) {
  activeOrder = order;
  const { html, mode } = paymentOrderView(order);
  document.querySelector("#payment-order-detail").innerHTML = html;
  applyPaymentFormMode(mode);
  document.querySelector("#payment-last-five").value = paymentLastFiveDefault(order);
  document.querySelector("#payment-error").classList.add("hidden");
  showDialog(paymentDialog);
}

async function submitPayment(event) {
  event.preventDefault();
  if (!activeOrder?.bank_account_id) return;
  const lastFive = document.querySelector("#payment-last-five").value.trim();
  const errorNode = document.querySelector("#payment-error");
  const submitButton = document.querySelector(".payment-submit");
  errorNode.classList.add("hidden");
  if (!/^\d{5}$/.test(lastFive)) {
    errorNode.textContent = "請輸入 5 位數字";
    return errorNode.classList.remove("hidden");
  }
  submitButton.disabled = true;
  submitButton.textContent = "送出中…";
  try {
    await reportPayment(activeOrder, lastFive, accessToken);
    closeDialog(paymentDialog);
    showToast("末五碼已送出，請等待管理員確認", "success");
    await loadOrders();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "送出末五碼，等待確認";
  }
}

document.addEventListener("click", (event) => {
  if (handleCopyBankAccount(event)) return;
  if (event.target.closest("[data-orders-refresh]")) return void loadOrders();
  if (event.target.closest("[data-payment-close], [data-payment-later], [data-payment-orders]")) return closeDialog(paymentDialog);
  const paymentButton = event.target.closest("[data-order-payment]");
  if (paymentButton) {
    const order = orders.find((item) => item.id === paymentButton.dataset.orderPayment);
    if (order) openPayment(order);
  }
});
document.querySelector("#payment-form").addEventListener("submit", submitPayment);

// LINE 內且沒有可用的 token 時一定會用到 LIFF：SDK 與 /api/config 同時下載，不用等設定回來才開始
if (inLineClient && !cachedAccessToken()) preloadLiffSdk();
// 第一次載入完成（顯示訂單或提示）後出計時報告；前往 LINE 登入時不報告，轉址回來的那次才報告
loadOrders().then(() => {
  if (accessToken === "redirect") return;
  markBoot("訂單顯示");
  reportBootTiming("orders");
});
