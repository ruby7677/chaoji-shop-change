// 訂單頁增強（ADMIN_REDESIGN_PLAN Stage 4）：狀態分頁＋訂單卡精簡／展開。
// 不改 renderAdminOrders 與表單送出：分頁只同步原下拉並觸發其 change 事件；
// 精簡列只切換 class（CSS 隱藏卡片內容），不搬動 DOM。
import { adminIcon } from "./admin-icons.js";
import { escapeHtml } from "./product-format.js";

// 分頁順序依處理流程；count 取自 admin_dashboard_stats（僅需人工處理的狀態有數字）
const TABS = [
  ["all", "全部"],
  ["pending_review", "待確認款項", (s) => s.pendingReview],
  ["seller_pending", "賣貨便待核對", (s) => s.sellerPending],
  ["pending_payment", "待付款"],
  ["confirmed", "已確認"],
  ["ready_for_pickup", "配送處理中", (s) => s.readyForPickup],
  ["completed", "已完成"],
  ["refund_pending", "退款處理中"],
  ["cancelled", "已取消"],
  ["refunded", "已退款"]
];
// 這些訂單需要店長動作，預設展開
const ACTION_STATUSES = new Set(["pending_review", "refund_pending"]);

let deps = null;
let list = null;
let tabBar = null;
const expanded = new Set();
const collapsed = new Set();

const statusSelect = () => document.querySelector("#admin-order-status-filter");

function renderTabs() {
  const stats = deps.getStats() || {};
  const current = statusSelect()?.value || "all";
  tabBar.innerHTML = TABS.map(([value, label, count]) => {
    const n = count ? Number(count(stats) || 0) : 0;
    return `<button type="button" class="admin-status-tab" data-admin-status-tab="${value}" aria-pressed="${value === current}">${escapeHtml(label)}${n ? `<b>${n}</b>` : ""}</button>`;
  }).join("");
}

function syncTabState() {
  const current = statusSelect()?.value || "all";
  tabBar.querySelectorAll("[data-admin-status-tab]").forEach((tab) => tab.setAttribute("aria-pressed", String(tab.dataset.adminStatusTab === current)));
}

function selectStatus(value) {
  const select = statusSelect();
  if (!select) throw new Error("訂單狀態篩選不存在");
  if (![...select.options].some((option) => option.value === value)) return;
  select.value = value;
  // 交給 app.js 既有的 change 委派重新查詢
  select.dispatchEvent(new Event("change", { bubbles: true }));
  syncTabState();
}

function cardKey(card) {
  return card.querySelector("header h3")?.textContent.trim() || "";
}

function needsAction(card) {
  const chip = card.querySelector(".status-chip");
  const status = [...(chip?.classList || [])].find((name) => name.startsWith("status-") && name !== "status-chip")?.slice(7);
  return ACTION_STATUSES.has(status) || card.classList.contains("seller-pending") || card.classList.contains("preorder-seller-pending") || Boolean(card.querySelector(".admin-fulfillment-form"));
}

function summaryMarkup(card) {
  const member = card.querySelector(".admin-order-member strong")?.textContent.trim() || "";
  const itemRows = [...card.querySelectorAll(".admin-order-items > div > span")].map((node) => node.textContent.trim());
  const items = itemRows.length > 1 ? `${itemRows[0]} 等 ${itemRows.length} 項` : itemRows[0] || "";
  const total = card.querySelector(".admin-order-total b")?.textContent.trim() || "";
  return `<span class="admin-order-summary-member">${escapeHtml(member)}</span><span class="admin-order-summary-items">${escapeHtml(items)}</span><b class="admin-order-summary-total">${escapeHtml(total)}</b>`;
}

function setCollapsed(card, value) {
  const key = cardKey(card);
  card.classList.toggle("is-collapsed", value);
  card.querySelector("[data-admin-order-toggle]")?.setAttribute("aria-expanded", String(!value));
  if (value) { collapsed.add(key); expanded.delete(key); }
  else { expanded.add(key); collapsed.delete(key); }
}

function enhanceCards() {
  const cards = [...list.querySelectorAll(".admin-order-card")];
  cards.forEach((card) => {
    if (card.dataset.adminEnhanced) return;
    card.dataset.adminEnhanced = "true";
    const header = card.querySelector(":scope > header");
    if (!header) return;
    const key = cardKey(card);
    const action = needsAction(card);
    card.classList.toggle("needs-action", action);
    const summary = document.createElement("div");
    summary.className = "admin-order-summary";
    summary.innerHTML = summaryMarkup(card);
    header.insertAdjacentElement("afterend", summary);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "admin-order-toggle";
    toggle.dataset.adminOrderToggle = "";
    toggle.setAttribute("aria-label", `展開或收合訂單 ${key}`);
    toggle.innerHTML = adminIcon("chevron");
    header.append(toggle);
    // 只有一筆（例如從搜尋或待辦跳來）時直接展開
    const shouldCollapse = collapsed.has(key) || (!expanded.has(key) && !action && cards.length > 1);
    setCollapsed(card, shouldCollapse);
  });
  syncTabState();
}

export function initAdminOrdersUI(dependencies) {
  if (deps) return;
  list = document.querySelector("#admin-order-list");
  const panel = document.querySelector('[data-admin-panel="orders"]');
  const toolbar = panel?.querySelector(".admin-order-toolbar");
  if (!list || !panel || !toolbar) return;
  deps = dependencies;
  panel.classList.add("admin-orders-enhanced");
  statusSelect()?.closest("label")?.classList.add("admin-status-select-label");
  tabBar = document.createElement("div");
  tabBar.className = "admin-status-tabs";
  tabBar.setAttribute("role", "toolbar");
  tabBar.setAttribute("aria-label", "訂單狀態");
  // 展開／收合工具放在捲動列之外，窄畫面不會被推到可捲動範圍的最右端
  const bar = document.createElement("div");
  bar.className = "admin-status-bar";
  bar.append(tabBar);
  bar.insertAdjacentHTML("beforeend", '<span class="admin-status-tools"><button type="button" class="admin-status-tool" data-admin-orders-expand="all">全部展開</button><button type="button" class="admin-status-tool" data-admin-orders-expand="none">全部收合</button></span>');
  toolbar.insertAdjacentElement("beforebegin", bar);
  renderTabs();
  new MutationObserver(enhanceCards).observe(list, { childList: true });
  // 統計更新（載入結束）時刷新分頁數字
  const loading = document.querySelector("#admin-loading");
  if (loading) new MutationObserver(() => { if (loading.classList.contains("hidden")) renderTabs(); }).observe(loading, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("change", (event) => { if (event.target === statusSelect()) syncTabState(); });
  panel.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-admin-status-tab]");
    if (tab) return selectStatus(tab.dataset.adminStatusTab);
    const bulk = event.target.closest("[data-admin-orders-expand]");
    if (bulk) {
      list.querySelectorAll(".admin-order-card").forEach((card) => setCollapsed(card, bulk.dataset.adminOrdersExpand === "none"));
      return;
    }
    const card = event.target.closest(".admin-order-card");
    if (!card) return;
    const isCollapsed = card.classList.contains("is-collapsed");
    if (event.target.closest("[data-admin-order-toggle]")) return setCollapsed(card, !isCollapsed);
    // 點標題列或摘要列也可切換；避開列內其他互動元素
    const onHeader = event.target.closest(".admin-order-card > header, .admin-order-summary");
    if (onHeader && !event.target.closest("a, button, input, select, textarea, label")) setCollapsed(card, !isCollapsed);
  });
  enhanceCards();
}
