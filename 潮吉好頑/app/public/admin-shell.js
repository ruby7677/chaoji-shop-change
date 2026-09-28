// 後台外殼：全螢幕工作區、分組導覽＋圖示＋待辦徽章、頂欄（標題／全域搜尋／重新整理）、手機抽屜。
// 只重組既有 DOM，不改 app.js 的資料流；所有 data-admin-* selector 與事件委派維持原樣。
// 依賴由 app.js 以 initAdminShell() 注入。
import { adminIcon } from "./admin-icons.js";
import { initAdminOverview } from "./admin-overview.js";
import { initAdminOrdersUI } from "./admin-orders-ui.js";
import { initAdminSheets } from "./admin-sheets.js";
import { searchContextFor } from "./admin-search-context.js";
import { buildAdminTabbar } from "./admin-tabbar.js";

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
// 目前頂欄搜尋對應的分頁設定（含來源欄位 selector），由 syncSearchContext() 維護
let currentSearchContext = null;
// 手機底部分頁列的狀態同步函式（buildAdminTabbar 回傳）
let syncTabbar = () => {};
// 側欄在此寬度以下是抽屜；收起時設為 inert，避免鍵盤／讀屏焦點落到畫面外的按鈕
const drawerQuery = window.matchMedia("(max-width: 1099px)");

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
    <div class="admin-crumbs"><span data-admin-crumb-group>營運</span><div class="admin-crumb-row"><strong data-admin-crumb-title>營運概況</strong><button class="admin-help-toggle" type="button" data-admin-help-toggle="" aria-expanded="false" title="說明" hidden>${adminIcon("info")}</button></div></div>
    <form class="admin-global-search" role="search" data-admin-global-search>
      <label class="sr-only" for="admin-global-search-input" data-admin-search-label>搜尋訂單</label>
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
  syncTabbar(tab);
  syncSearchContext();
  syncHelpToggle(tab, title);
}

// 頂欄「ⓘ」對應目前分頁的說明文字（admin-sheets.js 已預設隱藏並給 id）；沒有說明的分頁不顯示按鈕
function syncHelpToggle(tab, title) {
  const toggle = $("[data-admin-help-toggle]");
  if (!toggle) return;
  const copy = $(`[data-admin-panel="${tab}"] > .dialog-copy[data-admin-help]`);
  toggle.hidden = !copy;
  if (!copy) return;
  toggle.dataset.adminHelpToggle = copy.id;
  toggle.setAttribute("aria-controls", copy.id);
  toggle.setAttribute("aria-expanded", String(!copy.hidden));
  toggle.setAttribute("aria-label", `${title}說明`);
}

// 依目前分頁更新頂欄搜尋欄位的 placeholder、隱藏文字與目前值（取自該分頁自己的搜尋欄位）。
// 分頁沒有自己的搜尋欄位時（context.input 為 null），一律顯示空字串＋訂單搜尋文案。
function syncSearchContext() {
  currentSearchContext = searchContextFor(activeTab());
  const input = $("#admin-global-search-input");
  const label = $("[data-admin-search-label]");
  input.placeholder = currentSearchContext.placeholder;
  if (label) label.textContent = currentSearchContext.label;
  const source = currentSearchContext.input ? document.querySelector(currentSearchContext.input) : null;
  input.value = source ? source.value : "";
}

// 把頂欄搜尋的值鏡射回該分頁自己的搜尋欄位，並補發 input 事件讓既有監聽（debounce 重新載入／會員篩選）照常運作。
// 商品分頁的搜尋欄位由 ensureToolbar() 延遲建立，切分頁當下可能還不存在；找不到就略過，等下一次 syncSearchContext() 補上。
function mirrorToSource(context, value) {
  if (!context.input) return;
  const source = document.querySelector(context.input);
  if (!source) return;
  source.value = value;
  source.dispatchEvent(new Event("input", { bubbles: true }));
}

function syncBadges() {
  const stats = deps.getStats() || {};
  Object.entries(BADGES).forEach(([tab, count]) => {
    const value = count(stats);
    // 側欄與手機底部分頁列各有一份徽章
    dialog.querySelectorAll(`[data-admin-count="${tab}"]`).forEach((node) => {
      node.textContent = value > 99 ? "99+" : String(value);
      node.classList.toggle("hidden", !value);
      node.setAttribute("aria-label", `${value} 項待處理`);
    });
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
  syncNavInert();
  if (open && drawerQuery.matches) $(".admin-nav [data-admin-tab].active")?.focus({ preventScroll: true });
}

function syncNavInert() {
  $(".admin-nav").inert = drawerQuery.matches && !shell.classList.contains("is-nav-open");
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

// iOS Safari 在 top layer dialog 內的捲動容器，內容長高後不一定更新繪製與點擊範圍（搭配 admin-shell.css 的 1px 溢出）。
// 內容高度變動時切換一次 overflow，強制重建捲動圖層；保留捲動位置。
function watchContentGrowth() {
  const content = $(".admin-content");
  if (!content || !("ResizeObserver" in window)) return;
  let queued = false;
  let lastHeight = content.scrollHeight;
  const refresh = () => {
    queued = false;
    if (!dialog.open || content.scrollHeight === lastHeight) return;
    lastHeight = content.scrollHeight;
    const top = content.scrollTop;
    content.style.setProperty("overflow-y", "hidden");
    void content.offsetHeight;
    content.style.removeProperty("overflow-y");
    content.scrollTop = top;
  };
  const observer = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(refresh);
  });
  [...content.children].forEach((child) => observer.observe(child));
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
    const value = event.currentTarget.querySelector("input").value.trim();
    const tab = activeTab();
    if (!currentSearchContext?.input) return searchOrders(value);
    mirrorToSource(currentSearchContext, value);
    // 按下 Enter 立即查詢，不等待既有 debounce（非分頁式清單時 reloadAdminList 會自行略過）
    deps.reloadAdminList(tab, true);
  });
  $("#admin-global-search-input").addEventListener("input", (event) => {
    if (!currentSearchContext?.input) return;
    mirrorToSource(currentSearchContext, event.target.value);
  });
  document.addEventListener("keydown", (event) => {
    if (!dialog.open || event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault();
    $("#admin-global-search-input").focus();
  });
  drawerQuery.addEventListener("change", syncNavInert);
  // 抽屜開著時 Esc 只收起抽屜，不關閉整個後台（原因同 admin-sheets.js：在 keydown 攔截）
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !shell.classList.contains("is-nav-open")) return;
    event.preventDefault();
    setNavOpen(false);
    // 焦點回到目前看得到的開啟按鈕（平板為頂欄選單鈕，手機為底部「更多」）
    [...dialog.querySelectorAll('.admin-menu-button, [data-admin-tabbar="more"]')].find((button) => button.offsetParent)?.focus({ preventScroll: true });
  });
  watchContentGrowth();
  // 分頁切換可能來自按鈕或程式（快速篩選），統一觀察 active class
  new MutationObserver(syncTitle).observe($(".admin-nav"), { subtree: true, attributes: true, attributeFilter: ["class"] });
  // 每次載入結束（#admin-loading 被隱藏）更新徽章與時間
  const loading = $("#admin-loading");
  new MutationObserver(() => {
    if (!loading.classList.contains("hidden")) return;
    syncBadges();
    stampSync();
    // 商品分頁的搜尋欄位由 ensureToolbar() 在渲染時才建立；每次載入完成後補一次同步，
    // 確保剛建立的來源欄位能被頂欄搜尋抓到目前值／佔位文字。
    syncSearchContext();
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
  syncTabbar = buildAdminTabbar(shell, { onOpenMore: () => setNavOpen(true) });
  bindEvents();
  syncNavInert();
  syncTitle();
  initAdminOverview({ ...dependencies, openOrder: searchOrders });
  initAdminOrdersUI(dependencies);
  initAdminSheets();
  // 說明文字在 initAdminSheets() 才取得 id；補一次頂欄「ⓘ」同步
  syncTitle();
}
