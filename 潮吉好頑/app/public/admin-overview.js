// 後台概況儀表板（ADMIN_REDESIGN_PLAN Stage 3）：今日待辦、低庫存、最新訂單。
// 以唯讀方式另外讀取 orders／products 第一頁，不寫入 app.js 的 adminData，避免干擾訂單頁篩選。
import { adminIcon } from "./admin-icons.js";
import { escapeHtml, money } from "./product-format.js";

// 後台 API 每位管理員每分鐘限 20 次（API_ADMIN_RATE_LIMITER），概況清單以較長快取避免佔用額度；
// 按右上角重新整理可強制更新
const CACHE_MS = 180_000;
const RECENT_LIMIT = 6;
const LIST_QUERY = "page=0&page_size=100&query=&status=all";

let deps = null;
let panel = null;
let root = null;
let loadedAt = 0;
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

function lowStockVariants(products) {
  return products.flatMap((product) => (product.product_variants || [])
    .filter((variant) => Number(variant.stock_on_hand) <= Number(variant.safety_stock))
    .map((variant) => ({ product, variant })))
    .sort((a, b) => a.variant.stock_on_hand - b.variant.stock_on_hand);
}

function cardMarkup(title, subtitle, body, action = "") {
  return `<section class="admin-dash-card"><header><div><h3>${escapeHtml(title)}</h3>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>${action}</header>${body}</section>`;
}

function emptyMarkup(text) {
  return `<p class="admin-dash-empty">${escapeHtml(text)}</p>`;
}

function render(orders, products) {
  const todos = todoItems(orders);
  const low = lowStockVariants(products);
  const recent = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, RECENT_LIMIT);
  const todoBody = todos.length ? `<ul class="admin-dash-list">${todos.map(({ order, rule }) => {
    const member = memberOf(order);
    return `<li class="${rule.urgent ? "is-urgent" : ""}"><span class="admin-dash-icon">${adminIcon(rule.icon)}</span>
      <div><strong>${escapeHtml(rule.title(order))}</strong><small>${escapeHtml(member.full_name || "未填姓名")}・${escapeHtml(rule.detail(order))}</small></div>
      <button class="admin-dash-action" type="button" data-admin-dash-order="${escapeHtml(order.order_number)}">處理</button></li>`;
  }).join("")}</ul>` : emptyMarkup("目前沒有需要人工處理的訂單。");
  const lowBody = low.length ? `<ul class="admin-dash-list">${low.slice(0, 8).map(({ product, variant }) => `<li class="${variant.stock_on_hand <= 0 ? "is-urgent" : ""}"><span class="admin-dash-icon">${adminIcon("box")}</span>
      <div><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(variant.name)}・庫存 ${variant.stock_on_hand}／安全庫存 ${variant.safety_stock}</small></div>
      <button class="admin-dash-action is-quiet" type="button" data-admin-dash-restock="${escapeHtml(variant.id)}">補貨</button></li>`).join("")}</ul>` : emptyMarkup("所有規格都高於安全庫存。");
  const recentBody = recent.length ? `<ul class="admin-dash-list is-compact">${recent.map((order) => {
    const member = memberOf(order);
    return `<li><button class="admin-dash-row" type="button" data-admin-dash-order="${escapeHtml(order.order_number)}">
      <span><code>${escapeHtml(order.order_number)}</code><small>${escapeHtml(deps.formatDateTime(order.created_at))}・${escapeHtml(member.full_name || "未填姓名")}</small></span>
      <span class="admin-dash-status status-chip status-${escapeHtml(order.status)}">${escapeHtml(deps.orderStatusLabel(order))}</span>
      <b>${money(order.amount_due)}</b></button></li>`;
  }).join("")}</ul>` : emptyMarkup("尚無訂單。");
  root.innerHTML = `<div class="admin-dash-main">${cardMarkup("今日待辦", `${todos.length} 件需要處理（依最近 100 筆訂單）`, todoBody)}</div>
    <div class="admin-dash-side">${cardMarkup("低庫存提醒", `${low.length} 個規格低於安全庫存`, lowBody)}
    ${cardMarkup("最新訂單", "點選可直接開啟該筆訂單", recentBody, '<button class="admin-dash-link" type="button" data-admin-tab="orders">全部訂單</button>')}</div>`;
}

function renderError(message) {
  root.innerHTML = `<p class="admin-dash-error" role="alert">${adminIcon("alert")}<span>概況清單載入失敗：${escapeHtml(message)}。請按右上角重新整理。</span></p>`;
}

async function load({ force = false } = {}) {
  if (!force && Date.now() - loadedAt < CACHE_MS) return;
  if (inFlight) return inFlight;
  root.setAttribute("aria-busy", "true");
  inFlight = Promise.all([
    deps.adminFetch(`/api/admin/dashboard?section=orders&${LIST_QUERY}`),
    deps.adminFetch(`/api/admin/dashboard?section=products&${LIST_QUERY}`)
  ]).then(([orderResult, productResult]) => {
    render(Array.isArray(orderResult.orders) ? orderResult.orders : [], Array.isArray(productResult.products) ? productResult.products : []);
    loadedAt = Date.now();
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

function openRestock(variantId) {
  deps.switchAdminTab("inventory");
  // 庫存頁的規格選單在資料載入後才會有選項，稍後再選取並聚焦數量欄
  const trySelect = (attempt = 0) => {
    const select = document.querySelector("#admin-inventory-variant");
    const option = select && [...select.options].find((item) => item.value === variantId);
    if (option) {
      select.value = variantId;
      document.querySelector("#admin-inventory-delta")?.focus();
    } else if (attempt < 20) {
      window.setTimeout(() => trySelect(attempt + 1), 150);
    }
  };
  trySelect();
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
  // 後台任何表單送出（訂單轉換、庫存調整、商品編輯…）後資料可能已變，下次顯示概況時重新讀取
  document.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement && event.target.closest("#admin-dialog")) loadedAt = 0;
  }, true);
  document.addEventListener("click", (event) => {
    const orderButton = event.target.closest("[data-admin-dash-order]");
    if (orderButton) return deps.openOrder(orderButton.dataset.adminDashOrder);
    const restock = event.target.closest("[data-admin-dash-restock]");
    if (restock) return openRestock(restock.dataset.adminDashRestock);
    if (event.target.closest("[data-admin-refresh]") && isVisible()) load({ force: true });
  });
}
