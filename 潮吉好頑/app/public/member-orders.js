// 會員「我的訂單」對話框與回報匯款末五碼（畫面內容在 order-views.js，與獨立訂單頁共用）。
import { escapeHtml } from "./product-format.js";
import { auth, closeDialog, showDialog, showToast } from "./app-core.js";
import { ensurePaymentMethodUI } from "./checkout-form.js";
import { beginLineLogin } from "./member-profile.js";
import { applyPaymentFormMode, orderCardMarkup, ordersEmptyMarkup, paymentOrderView, reportPayment } from "./order-views.js";

export let currentOrders = [];
let activePaymentOrder = null;

function renderPaymentOrder(order) {
  ensurePaymentMethodUI();
  const { html, storePayment } = paymentOrderView(order);
  document.querySelector("#payment-order-detail").innerHTML = html;
  applyPaymentFormMode(storePayment);
}

export function showPaymentDialog(order) {
  activePaymentOrder = order;
  renderPaymentOrder(order);
  document.querySelector("#payment-last-five").value = "";
  document.querySelector("#payment-error").classList.add("hidden");
  const dialog = document.querySelector("#payment-dialog");
  showDialog(dialog);
}

export async function submitPayment(event) {
  event.preventDefault();
  if (!activePaymentOrder) return;
  if (!activePaymentOrder.bank_account_id) return showToast("此訂單為到店支付，取貨時付款即可");
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
    activePaymentOrder = await reportPayment(activePaymentOrder, lastFive, auth.accessToken);
    closeDialog(document.querySelector("#payment-dialog"));
    showToast("末五碼已送出，請等待管理員確認", "success");
    await openOrders();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "送出末五碼，等待確認";
  }
}

function renderOrders() {
  const container = document.querySelector("#orders-list");
  container.innerHTML = currentOrders.length ? currentOrders.map(orderCardMarkup).join("") : ordersEmptyMarkup();
}

export async function openOrders() {
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const dialog = document.querySelector("#orders-dialog");
  const container = document.querySelector("#orders-list");
  container.setAttribute("aria-busy", "true");
  container.innerHTML = '<div class="skeleton-stack" role="status" aria-label="載入訂單中"><div class="skeleton-card"><span></span><i></i><i></i></div><div class="skeleton-card"><span></span><i></i><i></i></div></div>';
  showDialog(dialog);
  try {
    const response = await fetch("/api/orders", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "訂單紀錄載入失敗");
    currentOrders = Array.isArray(result.orders) ? result.orders : [];
    renderOrders();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  } finally {
    container.removeAttribute("aria-busy");
  }
}
