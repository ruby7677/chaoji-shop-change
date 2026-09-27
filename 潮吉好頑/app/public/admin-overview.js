// 後台概況儀表板（ADMIN_REDESIGN_PLAN Stage 3）：今日待辦、低庫存、最新訂單。
// 資料來自 section=overview 的聚合回應（stats＋overview），與頁首徽章共用同一次請求；
// 待辦與低庫存由伺服器依條件精準篩選，不受訂單或商品筆數影響。
import { adminIcon } from "./admin-icons.js";
import { escapeHtml, money } from "./product-format.js";
import { openStockAdjust } from "./admin-stock-adjust.js";

// 後台 API 每位管理員每分鐘限 60 次（API_ADMIN_RATE_LIMITER），概況以較長快取避免佔用額度；
// 按右上角重新整理可強制更新
const CACHE_MS = 180_000;
const LOW_STOCK_SHOWN = 8;

let deps = null;
let panel = null;
let root = null;
let loadedAt = 0;
let renderedOverview = null;
let inFlight = null;

const memberOf = (order) => (Array.isArray(order.profiles) ? order.profiles[0] : order.profiles) || {};
const isSellerPending = (order) => order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;

// 依緊急程度排序的待辦規則；只列出需要店長人工處理的狀態
const TODO_RULES = [
  { match: (o) => o.status === "pending_review", icon: "bank", urgent: true, title: (o) => `確認款項 ${o.order_number}`, detail: (o) => `末五碼 ${o.payment_last_five || "未回報"}・應收 ${money(o.deposit_due || o.amount_due)}` },
  { match: (o) => o.status === "refund_pending", icon: "refresh", urgent: true, title: (o) => `退款處理 ${o.order_number}`, detail: (o) => `已收 ${money(o.paid_amount || 0)}` },
  { match: isSellerPending, icon: "bag", urgent: false, title: (o) => `核對賣貨便 ${o.order_number}`, detail: (o) => `訂單金額 ${money(o.amount_due)}` },
  { match: (o) => o.delivery_method === "home_delivery" && o.status === "ready_for_pickup" && !o.final_payment_confirmed_at, icon: "truck", urgent: false, title: (o) => `宅配尾款／運費 ${o.order_number}`, detail: (o) => (o.shipping_fee ? `運費 ${money(o.shipping_fee)}，待確認入帳` : "尚未填寫實際運費") }
];

function todoItems(orders) {
  return TODO_RULES.flatMap((rule) => orders.filter(rule.match).map((order) => ({ order, rule })));
}

function cardMarkup(title, subtitle, body, action = "") {
  return `<section class="admin-dash-card"><header><div><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>${action}</header>${body}</section>`;
}

function emptyMarkup(text) {
  return `<p class="admin-dash-empty">${escapeHtml(text)}</p>`;
}

function render(overview, stats) {
  const todos = todoItems(Array.isArray(overview.todoOrders) ? overview.todoOrders : []);
  const low = Array.isArray(overview.lowStock) ? overview.lowStock : [];
  const lowCount = Number.isFinite(Number(stats?.lowStock)) ? Number(stats.lowStock) : low.length;
  const recent = Array.isArray(overview.recentOrders) ? overview.recentOrders : [];
  const todoBody = todos.length ? `<ul class="admin-dash-list">${todos.map(({ order, rule }) => {
    const member = memberOf(order);
    return `<li class="${rule.urgent ? "is-urgent" : ""}"><span class="admin-dash-icon">${adminIcon(rule.icon)}</span>
      <div><strong>${escapeHtml(rule.title(order))}</strong><small>${escapeHtml(member.full_name || "未填姓名")}・${escapeHtml(rule.detail(order))}</small></div>
      <button class="admin-dash-action" type="button" data-admin-dash-order="${escapeHtml(order.order_number)}">處理</button></li>`;
  }).join("")}</ul>` : emptyMarkup("目前沒有需要人工處理的訂單。");
  const lowBody = low.length ? `<ul class="admin-dash-list">${low.slice(0, LOW_STOCK_SHOWN).map((variant) => `<li class="${variant.stock_on_hand <= 0 ? "is-urgent" : ""}"><span class="admin-dash-icon">${adminIcon("box")}</span>
      <div><strong>${escapeHtml(variant.product_name)}</strong><small>${escapeHtml(variant.name)}・庫存 ${variant.stock_on_hand}／安全庫存 ${variant.safety_stock}</small></div>
      <button class="admin-dash-action is-quiet" type="button" data-admin-dash-restock="${escapeHtml(variant.id)}">補貨</button></li>`).join("")}</ul>` : emptyMarkup("所有規格都高於安全庫存。");
  const recentBody = recent.length ? `<ul class="admin-dash-list is-compact">${recent.map((order) => {
    const member = memberOf(order);
    return `<li><button class="admin-dash-row" type="button" data-admin-dash-order="${escapeHtml(order.order_number)}">
      <span><code>${escapeHtml(order.order_number)}</code><small>${escapeHtml(deps.formatDateTime(order.created_at))}・${escapeHtml(member.full_name || "未填姓名")}</small></span>
      <span class="admin-dash-status status-chip status-${escapeHtml(order.status)}">${escapeHtml(deps.orderStatusLabel(order))}</span>
      <b>${money(order.amount_due)}</b></button></li>`;
  }).join("")}</ul>` : emptyMarkup("尚無訂單。");
  const todoSubtitle = overview.todoTruncated ? `超過 ${todos.length} 件需要處理，先列出最新的 ${todos.length} 件` : `${todos.length} 件需要處理`;
  root.innerHTML = `<div class="admin-dash-main">${cardMarkup("今日待辦", todoSubtitle, todoBody)}</div>
    <div class="admin-dash-side">${cardMarkup("低庫存提醒", `${lowCount} 個規格低於安全庫存`, lowBody)}
    ${cardMarkup("最新訂單", "點選可直接開啟該筆訂單", recentBody, '<button class="admin-dash-link" type="button" data-admin-tab="orders">全部訂單</button>')}</div>`;
}

function renderError(message) {
  root.innerHTML = `<p class="admin-dash-error" role="alert">${adminIcon("alert")}<span>概況清單載入失敗：${escapeHtml(message)}。請按右上角重新整理。</span></p>`;
}

function renderLatest() {
  const overview = deps.getOverview();
  if (!overview || overview === renderedOverview) return;
  render(overview, deps.getStats());
  renderedOverview = overview;
}

// loadAdminSection 會合併進行中的 overview 請求（頁首徽章開後台時也會載入），不重複打 API
async function load({ force = false } = {}) {
  const stale = Date.now() - loadedAt >= CACHE_MS;
  if (!force && !stale && deps.getOverview()) return renderLatest();
  if (inFlight) return inFlight;
  root.setAttribute("aria-busy", "true");
  inFlight = deps.loadAdminSection("overview", { force: force || (stale && Boolean(deps.getOverview())) }).then(() => {
    loadedAt = Date.now();
    renderLatest();
  }).catch((error) => {
    renderError(error.status === 429 ? "操作太頻繁，已達每分鐘上限，請 1 分鐘後再按重新整理" : error.message || "未知錯誤");
  }).finally(() => {
    root.removeAttribute("aria-busy");
    inFlight = null;
  });
  return inFlight;
}

function isVisible() {
  return panel.closest("dialog")?.open && !panel.classList.contains("hidden");
}

// 直接開啟共用的庫存調整面板，停留在概況頁（不再切到庫存頁面）；概況頁的 lowStock 一定已載入，
// openStockAdjust 找不到規格清單裡的資料時仍會 fallback 到 adminData.overview.lowStock。
function openRestock(variantId, trigger) {
  openStockAdjust(variantId, trigger);
}

export function initAdminOverview(dependencies) {
  if (deps) return;
  panel = document.querySelector('[data-admin-panel="overview"]');
  if (!panel) return;
  deps = dependencies;
  root = document.createElement("div");
  root.className = "admin-dash";
  root.dataset.adminDash = "";
  root.innerHTML = emptyMarkup("載入概況中…");
  panel.append(root);
  new MutationObserver(() => { if (isVisible()) load(); }).observe(panel, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => { if (isVisible()) load(); }).observe(panel.closest("dialog"), { attributes: true, attributeFilter: ["open"] });
  // 訂單、庫存與商品操作後 app.js 會重新載入 overview（refreshAdminSections），
  // 資料物件因此換新；下次顯示概況時 renderLatest 會以新資料重繪，不另打 API。
  document.addEventListener("click", (event) => {
    const orderButton = event.target.closest("[data-admin-dash-order]");
    if (orderButton) return deps.openOrder(orderButton.dataset.adminDashOrder);
    const restock = event.target.closest("[data-admin-dash-restock]");
    if (restock) return openRestock(restock.dataset.adminDashRestock, restock);
    if (event.target.closest("[data-admin-refresh]") && isVisible()) load({ force: true });
  });
}
