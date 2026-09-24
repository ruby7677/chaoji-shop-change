// 後台核心：後台狀態、資料載入（section 分區與快取）、分頁切換與分頁器。
// 各分頁的渲染與表單在 admin-*-panel.js、admin-product-image.js；外框、概況、商品表格等 UI 模組見其他 admin-*.js。
import { handleSessionExpired } from "./auth-expiry.js";
import { auth, showDialog, showToast } from "./app-core.js";
import { products } from "./storefront-catalog.js";
import { refreshAdminManagementOptionControls, removeLegacyShippingUI, renderAdminCategories, renderAdminLowStock, renderAdminMovements, renderAdminProducts, renderAdminSelects } from "./admin-catalog-panel.js";
import { renderAdminOrderStatusFilter, renderAdminOrders } from "./admin-orders-panel.js";
import { ensureDiscountAdminUI, renderAdminDiscounts, renderAdminMembers } from "./admin-members-panel.js";
import { renderAdminAccounts, renderAdminAudit, renderAdminNotifications } from "./admin-system-panel.js";

export let adminData = null;
let adminDataActorId = null;
let adminManagementOptionsActorId = null;
let adminManagementOptionsLoadedAt = 0;
let adminManagementOptionsInFlight = null;

const adminSections = ["overview", "orders", "members", "products", "inventory", "discounts", "audit", "notifications", "settings"];
const ADMIN_MANAGEMENT_OPTIONS_SECTIONS = new Set(["products", "inventory", "discounts"]);
const ADMIN_MANAGEMENT_OPTIONS_TTL_MS = 5 * 60 * 1000;
const adminSectionLoaded = new Set();
const adminSectionInFlight = new Map();
const adminSectionPages = { orders: 0, members: 0, products: 0, inventory: 0, discounts: 0, audit: 0, notifications: 0 };
const adminSearchDebounceTimers = { orders: null, members: null, products: null, inventory: null, discounts: null, audit: null, notifications: null };

export async function adminFetch(path, options = {}) {
  const hasFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(options.body && !hasFormData ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok) {
    // 401 代表登入已失效：頁首恢復成未登入並提示重新登入（auth-expiry.js）
    if (response.status === 401) void handleSessionExpired();
    const error = new Error(result.error || "管理操作失敗");
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function testTelegramNotification() {
  const button = document.querySelector("[data-telegram-test]");
  if (button) {
    button.disabled = true;
    button.textContent = "測試中…";
  }
  try {
    const result = await adminFetch("/api/admin/telegram-test", { method: "POST", body: JSON.stringify({}) });
    showToast(result.message || "Telegram 測試通知已送出", "success");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "測試 Telegram 通知";
    }
  }
}

export function relationOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

export async function openAdmin() {
  if (!auth.user || auth.profile?.is_admin !== true) return showToast("僅限管理員使用");
  resetAdminDataForActor();
  if (window.matchMedia("(max-width: 900px)").matches) {
    document.querySelectorAll("#admin-dialog details[data-admin-mobile-collapse][open]").forEach((details) => details.removeAttribute("open"));
  }
  const dialog = document.querySelector("#admin-dialog");
  showDialog(dialog);
  const tab = document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview";
  switchAdminTab(tab);
}

function adminSectionForTab(tab) {
  return tab === "accounts" ? "settings" : adminSections.includes(tab) ? tab : "overview";
}

function resetAdminDataForActor() {
  const actorId = auth.user?.id || null;
  if (adminDataActorId === actorId) return;
  adminDataActorId = actorId;
  adminData = null;
  adminSectionLoaded.clear();
  adminSectionInFlight.clear();
  adminManagementOptionsActorId = null;
  adminManagementOptionsLoadedAt = 0;
  adminManagementOptionsInFlight = null;
}

function hasFreshAdminManagementOptions() {
  return adminManagementOptionsActorId === auth.user?.id
    && adminManagementOptionsLoadedAt > 0
    && Date.now() - adminManagementOptionsLoadedAt < ADMIN_MANAGEMENT_OPTIONS_TTL_MS;
}

export function invalidateAdminManagementOptions() {
  adminManagementOptionsLoadedAt = 0;
  adminManagementOptionsActorId = null;
}

function mergeAdminData(partial) {
  const hadManagementOptions = Boolean(adminData?.managementOptions);
  const { managementOptions, ...sectionData } = partial;
  adminData = {
    ...(adminData || {}),
    ...sectionData,
    stats: { ...(adminData?.stats || {}), ...(sectionData.stats || {}) },
    pagination: { ...(adminData?.pagination || {}), ...(sectionData.pagination || {}) }
  };
  if (managementOptions && typeof managementOptions === "object") {
    const products = Array.isArray(managementOptions.products) ? managementOptions.products : [];
    const members = Array.isArray(managementOptions.members) ? managementOptions.members : [];
    const categories = Array.isArray(managementOptions.categories) ? managementOptions.categories : [];
    adminData.managementOptions = { products, members, categories };
    adminData.productOptions = products;
    adminData.discountProducts = products;
    adminData.discountMembers = members;
    adminData.categories = categories;
    adminManagementOptionsActorId = auth.user?.id || null;
    adminManagementOptionsLoadedAt = Date.now();
    if (hadManagementOptions) refreshAdminManagementOptionControls();
  }
  return adminData;
}

function adminSectionPageQuery(section) {
  if (!(section in adminSectionPages)) return "";
  const params = new URLSearchParams({ page: String(adminSectionPages[section]), page_size: "100" });
  if (section === "orders") {
    params.set("query", document.querySelector("#admin-order-search")?.value.trim() || "");
    params.set("status", document.querySelector("#admin-order-status-filter")?.value || "all");
  }
  if (section === "members") params.set("query", document.querySelector("#admin-member-search")?.value.trim() || "");
  if (section === "products") {
    params.set("query", document.querySelector("#admin-product-search")?.value.trim() || "");
    params.set("status", document.querySelector("#admin-product-status")?.value || "all");
  }
  if (section === "audit") {
    params.set("resource", document.querySelector("#admin-audit-resource")?.value || "");
    params.set("action", document.querySelector("#admin-audit-action")?.value || "");
  }
  if (section === "notifications") {
    params.set("channel", document.querySelector("#admin-notification-channel")?.value || "all");
    params.set("status", document.querySelector("#admin-notification-status")?.value || "all");
  }
  return params.toString();
}

function adminPaginationTarget(section) {
  if (section === "orders") return "#admin-order-list";
  if (section === "members") return "#admin-member-list";
  if (section === "products") return "#admin-product-list";
  if (section === "inventory") return "#admin-movement-list";
  if (section === "discounts") return "#admin-coupon-list";
  if (section === "notifications") return "#admin-notification-list";
  return "#admin-audit-list";
}

export function renderAdminPagination(section) {
  if (!(section in adminSectionPages)) return;
  const pagination = adminData?.pagination?.[section];
  const target = document.querySelector(adminPaginationTarget(section));
  if (!target) return;
  let nav = document.querySelector(`[data-admin-pagination="${section}"]`);
  if (!nav) {
    nav = document.createElement("nav");
    nav.className = "admin-pagination";
    nav.dataset.adminPagination = section;
    nav.setAttribute("aria-label", `${section} 分頁`);
    target.insertAdjacentElement("afterend", nav);
  }
  if (!pagination) {
    nav.classList.add("hidden");
    nav.innerHTML = "";
    return;
  }
  const page = Number(pagination.page || 0);
  adminSectionPages[section] = page;
  const pageSize = Number(pagination.pageSize || 100);
  nav.classList.toggle("hidden", page === 0 && !pagination.hasMore);
  nav.innerHTML = `<button class="secondary-button" type="button" data-admin-page="${section}" data-admin-page-delta="-1" ${page <= 0 ? "disabled" : ""}>上一頁</button><span aria-live="polite">第 ${page + 1} 頁</span><button class="secondary-button" type="button" data-admin-page="${section}" data-admin-page-delta="1" ${pagination.hasMore ? "" : "disabled"}>下一頁</button>`;
  nav.dataset.pageSize = String(pageSize);
}

export async function changeAdminPage(section, delta) {
  const pagination = adminData?.pagination?.[section];
  if (!pagination) return;
  const current = Number(pagination.page || 0);
  const next = current + delta;
  if (next < 0 || (delta > 0 && !pagination.hasMore)) return;
  adminSectionPages[section] = next;
  try {
    await loadAdminSection(section, { force: true });
  } catch (error) {
    adminSectionPages[section] = current;
    throw error;
  }
}

export function reloadAdminList(section, immediate = false) {
  if (!(section in adminSectionPages)) return;
  adminSectionPages[section] = 0;
  if (adminSearchDebounceTimers[section]) window.clearTimeout(adminSearchDebounceTimers[section]);
  const run = () => {
    adminSearchDebounceTimers[section] = null;
    loadAdminSection(section, { force: true }).catch((error) => showToast(error.message, "error"));
  };
  if (immediate) run();
  else adminSearchDebounceTimers[section] = window.setTimeout(run, 300);
}

function renderAdminSection(section) {
  if (!adminData) return;
  if (section === "overview") {
    const readyStat = document.querySelector('[data-stat="readyForPickup"]');
    if (readyStat?.previousElementSibling) readyStat.previousElementSibling.textContent = "待取貨／待尾款";
    Object.entries(adminData.stats || {}).forEach(([key, value]) => {
      const node = document.querySelector(`[data-stat="${key}"]`);
      if (node) node.textContent = value;
    });
    return;
  }
  if (section === "orders") {
    renderAdminOrderStatusFilter();
    renderAdminOrders();
    renderAdminPagination(section);
    return;
  }
  if (section === "members") {
    renderAdminMembers();
    renderAdminPagination(section);
    return;
  }
  if (section === "audit") {
    renderAdminAudit();
    renderAdminPagination(section);
    return;
  }
  if (section === "notifications") {
    renderAdminNotifications();
    renderAdminPagination(section);
    return;
  }
  if (section === "products") {
    renderAdminCategories();
    renderAdminProducts();
    renderAdminSelects({ preserveSelection: true });
    removeLegacyShippingUI();
    renderAdminPagination(section);
    return;
  }
  if (section === "inventory") {
    renderAdminSelects({ preserveSelection: true });
    renderAdminMovements();
    renderAdminLowStock();
    renderAdminPagination(section);
    return;
  }
  if (section === "discounts") {
    ensureDiscountAdminUI();
    renderAdminDiscounts();
    renderAdminPagination(section);
    return;
  }
  renderAdminAccounts();
}

export async function loadAdminSection(tabOrSection, { force = false } = {}) {
  resetAdminDataForActor();
  const section = adminSectionForTab(tabOrSection);
  const existing = adminSectionInFlight.get(section);
  if (existing) return existing;
  let includeManagementOptions = ADMIN_MANAGEMENT_OPTIONS_SECTIONS.has(section) && !hasFreshAdminManagementOptions();
  if (!force && adminSectionLoaded.has(section) && !includeManagementOptions) return adminData;
  if (includeManagementOptions && adminManagementOptionsInFlight) {
    await adminManagementOptionsInFlight;
    return loadAdminSection(tabOrSection, { force });
  }
  includeManagementOptions = ADMIN_MANAGEMENT_OPTIONS_SECTIONS.has(section) && !hasFreshAdminManagementOptions();
  if (!force && adminSectionLoaded.has(section) && !includeManagementOptions) return adminData;
  const requestActorId = auth.user?.id || null;
  const loading = document.querySelector("#admin-loading");
  const errorNode = document.querySelector("#admin-error");
  loading.classList.remove("hidden");
  errorNode.classList.add("hidden");
  const request = (async () => {
    try {
      const pageQuery = adminSectionPageQuery(section);
      const endpoint = ["audit", "notifications"].includes(section)
        ? `${section === "audit" ? "/api/admin/audit-logs" : "/api/admin/notification-deliveries"}?${pageQuery}`
        : `/api/admin/dashboard?section=${encodeURIComponent(section)}${pageQuery ? `&${pageQuery}` : ""}${includeManagementOptions ? "&include_options=true" : ""}`;
      const partial = await adminFetch(endpoint);
      if (requestActorId !== (auth.user?.id || null)) return adminData;
      const options = partial.managementOptions;
      if (includeManagementOptions && (!options || !Array.isArray(options.products) || !Array.isArray(options.members) || !Array.isArray(options.categories))) {
        throw new Error("管理表單選項暫時無法載入");
      }
      mergeAdminData(partial);
      adminSectionLoaded.add(section);
      renderAdminSection(section);
      return adminData;
    } catch (error) {
      if (requestActorId === (auth.user?.id || null)) {
        errorNode.textContent = error.message;
        errorNode.classList.remove("hidden");
      }
      throw error;
    } finally {
      if (adminSectionInFlight.get(section) === request) {
        loading.classList.add("hidden");
        adminSectionInFlight.delete(section);
      }
      if (includeManagementOptions && adminManagementOptionsInFlight === request) adminManagementOptionsInFlight = null;
    }
  })();
  adminSectionInFlight.set(section, request);
  if (includeManagementOptions) adminManagementOptionsInFlight = request;
  return request;
}

export function switchAdminTab(tab) {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.toggle("active", button.dataset.adminTab === tab));
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.adminPanel !== tab));
  loadAdminSection(tab).catch(() => {});
}

export async function refreshAdminSections(sections) {
  await Promise.all([...new Set(sections)].map((section) => loadAdminSection(section, { force: true })));
}

export async function loadAdminData(section) {
  return loadAdminSection(section || document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview", { force: true });
}

export function applyAdminQuickFilter(filter) {
  if (filter === "low_stock") {
    switchAdminTab("inventory");
  } else if (filter === "members") {
    switchAdminTab("members");
  } else {
    const statusFilter = document.querySelector("#admin-order-status-filter");
    if (statusFilter) statusFilter.value = ["pending_review", "seller_pending", "ready_for_pickup"].includes(filter) ? filter : "all";
    switchAdminTab("orders");
    reloadAdminList("orders", true);
  }
  document.querySelector(".admin-content")?.scrollTo({ top: 0, behavior: "smooth" });
}

export function localDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function renderAdminData() {
  ensureDiscountAdminUI();
  const readyStat = document.querySelector('[data-stat="readyForPickup"]');
  if (readyStat?.previousElementSibling) readyStat.previousElementSibling.textContent = "待取貨／待尾款";
  Object.entries(adminData.stats || {}).forEach(([key, value]) => {
    const node = document.querySelector(`[data-stat="${key}"]`);
    if (node) node.textContent = value;
  });
  renderAdminAccounts();
  renderAdminOrderStatusFilter();
  renderAdminOrders();
  renderAdminMembers();
  renderAdminCategories();
  renderAdminProducts();
  renderAdminMovements();
  renderAdminLowStock();
  renderAdminSelects();
  renderAdminDiscounts();
  removeLegacyShippingUI();
}
