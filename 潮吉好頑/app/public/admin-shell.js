// 後台外殼：全螢幕工作區、分組導覽＋圖示＋待辦徽章、頂欄（標題／全域搜尋／重新整理）、手機抽屜。
// 只重組既有 DOM，不改 app.js 的資料流；所有 data-admin-* selector 與事件委派維持原樣。
// 依賴由 app.js 以 initAdminShell() 注入。
import { adminIcon } from "./admin-icons.js";
import { initAdminOverview } from "./admin-overview.js";
import { initAdminOrdersUI } from "./admin-orders-ui.js";
import { initAdminProductsUI } from "./admin-products-ui.js";
import { initAdminSheets } from "./admin-sheets.js";

const NAV_GROUPS = [
  { label: "營運", tabs: [["overview", "chart"], ["orders", "receipt"]] },
  { label: "商品", tabs: [["products", "layers"], ["inventory", "box"]] },
  { label: "會員行銷", tabs: [["members", "users"], ["discounts", "gift"]] },
  { label: "系統", tabs: [["accounts", "bank"], ["audit", "shield"], ["notifications", "bell"]] }
];
// 徽章只顯示「需要人工處理」的數量，來源為 admin_dashboard_stats
const BADGES = {
  orders: (stats) => Number(stats.pendingReview || 0) + Number(stats.sellerPending || 0) + Number(stats.preorderSellerPending || 0),
  inventory: (stats) => Number(stats.lowStock || 0)
};

let deps = null;
let dialog = null;
let shell = null;

const $ = (selector) => dialog.querySelector(selector);

function groupOf(tab) {
  return NAV_GROUPS.find((group) => group.tabs.some(([key]) => key === tab))?.label || "營運";
}

function buildNav() {
  const nav = $(".admin-nav");
  const buttons = new Map([...nav.querySelectorAll("[data-admin-tab]")].map((button) => [button.dataset.adminTab, button]));
  const brand = document.createElement("button");
  brand.type = "button";
  brand.className = "admin-brand";
  brand.setAttribute("data-admin-close", "");
  brand.setAttribute("aria-label", "關閉後台，回到前台");
  brand.innerHTML = '<img src="/Logo.webp" width="40" height="40" alt="" /><span><strong>潮吉好頑</strong><small>營運後台・回前台</small></span>';
  nav.querySelector(":scope > strong")?.remove();
  const fragment = document.createDocumentFragment();
  fragment.append(brand);
  NAV_GROUPS.forEach((group) => {
    const wrapper = document.createElement("div");
    wrapper.className = "admin-nav-group";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", group.label);
    wrapper.innerHTML = `<span class="admin-nav-label" aria-hidden="true">${group.label}</span>`;
    group.tabs.forEach(([tab, icon]) => {
      const button = buttons.get(tab);
      if (!button) return;
      const label = button.textContent.trim();
      button.dataset.adminLabel = label;
      button.innerHTML = `${adminIcon(icon)}<span class="admin-nav-text">${label}</span><span class="admin-nav-count hidden" data-admin-count="${tab}"></span>`;
      wrapper.append(button);
      buttons.delete(tab);
    });
    fragment.append(wrapper);
  });
  // 未列入分組的新分頁（日後新增）仍保留在最後，避免被隱藏
  if (buttons.size) {
    const rest = document.createElement("div");
    rest.className = "admin-nav-group";
    buttons.forEach((button) => rest.append(button));
    fragment.append(rest);
  }
  nav.replaceChildren(fragment);
}

function buildTopbar() {
  const content = $(".admin-content");
  const oldClose = content.querySelector(":scope > .dialog-close");
  const topbar = document.createElement("header");
  topbar.className = "admin-topbar";
  topbar.innerHTML = `
    <button class="admin-icon-button admin-menu-button" type="button" data-admin-nav-toggle aria-label="開啟後台選單" aria-expanded="false">${adminIcon("menu")}</button>
    <div class="admin-crumbs"><span data-admin-crumb-group>營運</span><strong data-admin-crumb-title>營運概況</strong></div>
    <form class="admin-global-search" role="search" data-admin-global-search>
      <label class="sr-only" for="admin-global-search-input">搜尋訂單</label>
      ${adminIcon("search")}
      <input id="admin-global-search-input" type="search" placeholder="搜尋訂單編號、姓名、手機、末五碼" autocomplete="off" enterkeyhint="search" />
      <kbd aria-hidden="true">/</kbd>
    </form>
    <div class="admin-topbar-actions">
      <button class="admin-icon-button" type="button" data-admin-refresh aria-label="重新整理目前頁面" title="重新整理">${adminIcon("refresh")}</button>
      <button class="admin-icon-button" type="button" data-admin-close aria-label="關閉後台，回到前台" title="回前台">${adminIcon("x")}</button>
    </div>`;
  oldClose?.remove();
  const sync = document.createElement("p");
  sync.className = "admin-sync";
  sync.setAttribute("role", "status");
  sync.setAttribute("aria-live", "polite");
  sync.dataset.adminSync = "";
  content.prepend(topbar, sync);
  const scrim = document.createElement("div");
  scrim.className = "admin-nav-scrim";
  scrim.hidden = true;
  scrim.dataset.adminNavToggle = "";
  shell.append(scrim);
}

function activeTab() {
  return $("[data-admin-tab].active")?.dataset.adminTab || "overview";
}

function syncTitle() {
  const tab = activeTab();
  const button = $(`[data-admin-tab="${tab}"]`);
  const title = button?.dataset.adminLabel || button?.textContent.trim() || "營運概況";
  $("[data-admin-crumb-group]").textContent = groupOf(tab);
  $("[data-admin-crumb-title]").textContent = title;
  dialog.querySelectorAll("[data-admin-tab]").forEach((item) => {
    if (item.dataset.adminTab === tab) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

function syncBadges() {
  const stats = deps.getStats() || {};
  Object.entries(BADGES).forEach(([tab, count]) => {
    const node = $(`[data-admin-count="${tab}"]`);
    if (!node) return;
    const value = count(stats);
    node.textContent = value > 99 ? "99+" : String(value);
    node.classList.toggle("hidden", !value);
    node.setAttribute("aria-label", `${value} 項待處理`);
  });
}

function stampSync() {
  const failed = !$("#admin-error")?.classList.contains("hidden");
  const time = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
  $("[data-admin-sync]").textContent = failed ? `資料更新失敗（${time}），請按重新整理` : `資料更新於 ${time}`;
  $("[data-admin-sync]").classList.toggle("is-error", failed);
}

function setNavOpen(open) {
  shell.classList.toggle("is-nav-open", open);
  shell.querySelector(".admin-nav-scrim").hidden = !open;
  $("[data-admin-nav-toggle].admin-menu-button").setAttribute("aria-expanded", String(open));
}

function searchOrders(keyword) {
  const orderSearch = document.querySelector("#admin-order-search");
  const statusFilter = document.querySelector("#admin-order-status-filter");
  if (!orderSearch || !statusFilter) throw new Error("訂單搜尋欄位不存在");
  orderSearch.value = keyword;
  statusFilter.value = "all";
  deps.switchAdminTab("orders");
  deps.reloadAdminList("orders", true);
}

// 其他模組（概況待辦）可用同一個入口跳到指定訂單
export function openAdminOrderSearch(keyword) {
  if (!deps) throw new Error("後台外殼尚未初始化");
  searchOrders(keyword);
}

function bindEvents() {
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-admin-nav-toggle]")) {
      setNavOpen(!shell.classList.contains("is-nav-open"));
      return;
    }
    if (event.target.closest("[data-admin-tab]")) setNavOpen(false);
  });
  $("[data-admin-global-search]").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    searchOrders(input.value.trim());
  });
  document.addEventListener("keydown", (event) => {
    if (!dialog.open || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    $("#admin-global-search-input").focus();
  });
  // 分頁切換可能來自按鈕或程式（快速篩選），統一觀察 active class
  new MutationObserver(syncTitle).observe($(".admin-nav"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  // 每次載入結束（#admin-loading 被隱藏）更新徽章與時間
  const loading = $("#admin-loading");
  new MutationObserver(() => {
    if (!loading.classList.contains("hidden")) return;
    syncBadges();
    stampSync();
  }).observe(loading, { attributes: true, attributeFilter: ["class"] });
  // 開啟後台時確保有徽章所需的統計（只讀，重用既有 overview 載入）
  new MutationObserver(() => {
    if (!dialog.open) return setNavOpen(false);
    syncTitle();
    if (!deps.getStats()) deps.loadAdminSection("overview").catch(() => {});
    else syncBadges();
  }).observe(dialog, { attributes: true, attributeFilter: ["open"] });
}

export function initAdminShell(dependencies) {
  if (deps) return;
  const required = ["getStats", "switchAdminTab", "reloadAdminList", "loadAdminSection", "adminFetch", "formatDateTime", "orderStatusLabel"];
  const missing = required.filter((key) => typeof dependencies?.[key] !== "function");
  if (missing.length) throw new Error(`initAdminShell 缺少依賴：${missing.join(", ")}`);
  dialog = document.querySelector("#admin-dialog");
  shell = dialog?.querySelector(".admin-shell");
  if (!dialog || !shell) return;
  deps = dependencies;
  dialog.classList.add("admin-app");
  buildNav();
  buildTopbar();
  bindEvents();
  syncTitle();
  initAdminOverview({ ...dependencies, openOrder: searchOrders });
  initAdminOrdersUI(dependencies);
  initAdminProductsUI();
  initAdminSheets();
}
