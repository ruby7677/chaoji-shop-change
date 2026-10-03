// 前台與後台共用：會員登入狀態物件、訂單狀態文字、日期格式、對話框、toast 與捲動鎖定。
import { escapeHtml, isPreorderItem } from "./product-format.js";

export const auth = { config: null, accessToken: null, refreshToken: null, lineProviderToken: null, user: null, profile: null, points: null, lineFriendFlag: null };

export const deliveryMethodLabels = { store_pickup: "到店取貨", seller_delivery: "賣貨便", home_delivery: "宅配" };
export const deliveryMethodNotes = {
  store_pickup: "台南市中西區民生路二段 93 號，免運。",
  seller_delivery: "本站先建立待確認訂單，再前往賣貨便完成結帳；運費由 7-11 於取貨時向客戶收取。",
  home_delivery: "現貨宅配匯款時先私訊小幫手確認運費再連同商品一併匯款即可；預購商品到貨後通知，尾款與運費確認入帳後安排寄出。"
};

const orderStatusLabels = {
  pending_payment: "待付款",
  pending_review: "待確認款項",
  confirmed: "已確認",
  partially_ready: "部分到貨",
  ready_for_pickup: "配送處理中",
  completed: "已完成訂單",
  cancelled: "已取消"
};

export const customerServiceLineUrl = "https://line.me/R/ti/p/@078isxfl?ts=03122133&oat_content=url";
export function linkCustomerServiceText(value) {
  return escapeHtml(value).replaceAll("小幫手", `<a class="helper-contact-link" href="${customerServiceLineUrl}" target="_blank" rel="noopener noreferrer">小幫手</a>`);
}
export function orderIncludesPreorder(order) { return (order?.order_items || []).some(isPreorderItem); }
export function orderInventoryTypeLabel(order) {
  const kinds = (order?.order_items || []).map((item) => String(item?.type || item?.kind || "").toLowerCase());
  const hasPreorder = kinds.some((kind) => ["預購", "preorder"].includes(kind));
  const hasInStock = kinds.some((kind) => ["現貨", "in_stock"].includes(kind));
  if (hasPreorder && hasInStock) return "現貨／預購";
  return hasPreorder ? "預購" : "現貨";
}
export function orderStatusLabel(order, status = order?.status) {
  if (status === "ready_for_pickup") {
    if (order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便已到貨" : "現貨賣貨便已出貨";
    if (order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待尾款／運費" : "現貨宅配待尾款／運費";
    if (order?.delivery_method === "store_pickup" && orderIncludesPreorder(order)) return "待取貨";
    return "配送處理中";
  }
  return orderStatusLabels[status] || status || "未知狀態";
}
export function adminOrderStatusLabel(order, status = order?.status) {
  if (status === "confirmed" && order?.delivery_method === "store_pickup" && !orderIncludesPreorder(order)) return "待取貨";
  if (status === "confirmed" && order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待到貨" : "現貨宅配備貨中";
  if (status === "confirmed" && order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便待到貨" : "現貨賣貨便備貨中";
  if (status === "ready_for_pickup" && order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待尾款／運費" : "現貨宅配待尾款／運費";
  if (status === "ready_for_pickup" && order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便已到貨" : "現貨賣貨便已出貨";
  if (status === "ready_for_pickup" && order?.delivery_method === "store_pickup" && orderIncludesPreorder(order)) return "預購到店待取貨";
  if (status === "confirmed") return "到店通知";
  return orderStatusLabel(order, status);
}
// 所有日期時間一律以台灣時間（UTC+8，無日光節約）顯示與輸入，不隨瀏覽器所在時區變動。
const TAIPEI_TIME_ZONE = "Asia/Taipei";
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export function formatDateTime(value) { return new Intl.DateTimeFormat("zh-TW", { timeZone: TAIPEI_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
export function formatDate(value) { return new Intl.DateTimeFormat("zh-TW", { timeZone: TAIPEI_TIME_ZONE, dateStyle: "medium" }).format(new Date(value)); }
/** datetime-local 欄位值（YYYY-MM-DDTHH:mm），代表台灣時間。 */
export function taipeiDateTimeInputValue(value) {
  const time = value === undefined || value === null ? Date.now() : new Date(value).getTime();
  return new Date(time + TAIPEI_OFFSET_MS).toISOString().slice(0, 16);
}
/** 把台灣時間的 datetime-local 欄位值轉回 ISO（UTC）。 */
export function taipeiDateTimeInputToIso(value) { return new Date(`${value}:00+08:00`).toISOString(); }
let toastTimer = null;
let pageScrollLockState = null;
const pageScrollStyleKeys = ["position", "top", "left", "right", "width", "overflow", "paddingRight"];

function hasOpenOverlay() {
  return Boolean(document.querySelector("dialog[open], .cart-drawer.open"));
}

function lockPageScroll() {
  if (pageScrollLockState) return;
  const bodyStyle = document.body.style;
  pageScrollLockState = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    styles: Object.fromEntries(pageScrollStyleKeys.map((key) => [key, bodyStyle[key]]))
  };
  const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  bodyStyle.position = "fixed";
  bodyStyle.top = `-${pageScrollLockState.scrollY}px`;
  bodyStyle.left = "0";
  bodyStyle.right = "0";
  bodyStyle.width = "100%";
  bodyStyle.overflow = "hidden";
  bodyStyle.paddingRight = scrollbarWidth ? `${scrollbarWidth}px` : pageScrollLockState.styles.paddingRight;
  document.documentElement.classList.add("is-scroll-locked");
}

function unlockPageScroll() {
  if (!pageScrollLockState) return;
  const state = pageScrollLockState;
  pageScrollLockState = null;
  const bodyStyle = document.body.style;
  pageScrollStyleKeys.forEach((key) => { bodyStyle[key] = state.styles[key] || ""; });
  document.documentElement.classList.remove("is-scroll-locked");
  // html 設有 scroll-behavior:smooth；還原位置須立即完成，否則關閉視窗後整頁會從頂端滑回原處
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
}

export function syncPageScrollLock() {
  if (hasOpenOverlay()) lockPageScroll();
  else unlockPageScroll();
}

export function showDialog(dialog) {
  if (!dialog) return;
  // 先鎖頁面再 showModal：鎖定會讓整頁捲動位置歸 0，若 dialog 已在 top layer，
  // iOS Safari 會沿用舊捲動位置的繪製與點擊範圍（畫面被截斷、無法操作；例如從頁尾開後台）
  if (!dialog.open) {
    lockPageScroll();
    dialog.showModal();
  }
  syncPageScrollLock();
}

export function closeDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) dialog.close();
  syncPageScrollLock();
}

function hideToast() {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.classList.remove("show");
  toast.setAttribute("aria-hidden", "true");
  toastTimer = null;
}
export function showToast(message, kind = "neutral") {
  const toast = document.querySelector("#toast");
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog && toast.parentElement !== openDialog) openDialog.appendChild(toast);
  else if (!openDialog && toast.parentElement !== document.body) document.body.appendChild(toast);
  const toastKind = ["success", "error", "warning"].includes(kind) ? kind : "neutral";
  toast.textContent = message;
  toast.classList.remove("show", "toast-success", "toast-error", "toast-warning");
  if (toastKind !== "neutral") toast.classList.add(`toast-${toastKind}`);
  toast.setAttribute("role", toastKind === "error" ? "alert" : "status");
  toast.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => toast.classList.add("show"));
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 3000);
}
