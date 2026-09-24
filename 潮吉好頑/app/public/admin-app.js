// 後台主程式：資料載入與分區渲染、訂單／會員／點數／優惠券／商品／庫存／收款帳戶表單。
// 由 app.js 在啟動時接線；外框、概況、商品表格等 UI 模組見 admin-*.js。
import { escapeHtml, money } from "./product-format.js";
import { renderAdminProductsTable } from "./admin-products-table.js";
import { adminConfirm } from "./admin-confirm.js";
import { handleSessionExpired } from "./auth-expiry.js";
import { adminOrderStatusLabel, auth, deliveryMethodLabels, formatDateTime, orderIncludesPreorder, orderInventoryTypeLabel, orderStatusLabel, showDialog, showToast } from "./app-core.js";
import { invalidateBankAccounts, loadProducts, products, renderProducts } from "./app.js";

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

const adminOrderTransitions = {
  pending_payment: [{ value: "confirmed", label: "確認到店付款", storePaymentOnly: true }, { value: "cancelled", label: "取消未付款訂單" }],
  pending_review: [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }],
  confirmed: [{ value: "partially_ready", label: "標記預購商品部分到貨", splitOnly: true }, { value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  partially_ready: [{ value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  ready_for_pickup: [{ value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  completed: [{ value: "refund_pending", label: "進入退款處理" }],
  refund_pending: [{ value: "refunded", label: "確認已退款" }, { value: "completed", label: "取消退款，恢復已完成" }]
};

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

function relationOne(value) {
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

function renderAdminPagination(section) {
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

async function refreshAdminSections(sections) {
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

function localDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function ensureDiscountAdminUI() {
  if (!document.querySelector("[data-admin-tab='discounts']") || !document.querySelector("[data-admin-panel='discounts']")) return;
  resetCouponForm();
}

export function resetCouponForm() {
  document.querySelector("#admin-coupon-form").reset();
  document.querySelector("#coupon-id").value = "";
  document.querySelector("#coupon-active").checked = true;
  document.querySelector("#coupon-member-limit").value = "1";
  document.querySelector("#coupon-valid-from").value = localDateTime();
  document.querySelector("#coupon-valid-until").value = localDateTime(Date.now() + 30 * 86400000);
}

function renderAdminDiscounts() {
  renderAdminDiscountOptionBoxes({ preserveSelection: true });
  const birthday = adminData.birthdaySettings;
  if (birthday) {
    document.querySelector("#birthday-amount").value = birthday.discount_amount;
    document.querySelector("#birthday-before").value = birthday.issue_days_before;
    document.querySelector("#birthday-valid-days").value = birthday.valid_days;
    document.querySelector("#birthday-combinable").checked = birthday.combinable_with_points;
    document.querySelector("#birthday-enabled").checked = birthday.enabled;
  }
  const list = document.querySelector("#admin-coupon-list");
  list.innerHTML = (adminData.coupons || []).map((coupon) => `<div class="admin-card coupon-card"><div><strong>${escapeHtml(coupon.code)} · ${escapeHtml(coupon.name)}</strong><small>折 ${money(coupon.discount_amount)} · ${coupon.combinable_with_points ? "可" : "不可"}與點數併用 · 已用 ${(coupon.coupon_redemptions || []).length}${coupon.total_usage_limit ? `/${coupon.total_usage_limit}` : ""} · ${coupon.is_active ? "啟用" : "停用"}<br />${new Date(coupon.valid_from).toLocaleString("zh-TW")} 至 ${new Date(coupon.valid_until).toLocaleString("zh-TW")}${coupon.is_birthday ? " · 生日券" : ""}</small></div>${coupon.is_birthday ? "" : `<button type="button" data-coupon-edit="${coupon.id}">編輯</button>`}</div>`).join("") || '<div class="empty-state">尚未建立優惠券。</div>';
}

function renderAdminDiscountOptionBoxes({ preserveSelection = false } = {}) {
  const productBox = document.querySelector("#coupon-product-options");
  const memberBox = document.querySelector("#coupon-member-options");
  const products = adminData.discountProducts || adminData.products || [];
  const members = adminData.discountMembers || adminData.members || [];
  const checkedProducts = preserveSelection ? new Set([...productBox.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value)) : new Set();
  const checkedMembers = preserveSelection ? new Set([...memberBox.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)) : new Set();
  productBox.innerHTML = products.map((product) => `<label><input type="checkbox" name="coupon_product" value="${escapeHtml(product.id)}" ${checkedProducts.has(product.id) ? "checked" : ""} /> ${escapeHtml(product.name)}</label>`).join("") || "<small>尚無商品</small>";
  memberBox.innerHTML = members.map((member) => `<label><input type="checkbox" name="coupon_member" value="${escapeHtml(member.id)}" ${checkedMembers.has(member.id) ? "checked" : ""} /> ${escapeHtml(member.full_name || member.phone || "未命名會員")}</label>`).join("") || "<small>尚無會員</small>";
}

function auditMaskedValue(value) {
  const text = String(value ?? "");
  return text.length > 4 ? `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : "****";
}

function auditJsonSummary(value) {
  if (value == null) return "—";
  let text = "";
  try {
    text = JSON.stringify(value, (key, child) => /account_number|channel_access_token|bot_token|secret|password/i.test(key) ? auditMaskedValue(child) : child);
  } catch {
    text = String(value);
  }
  if (text.length > 320) text = `${text.slice(0, 317)}…`;
  return escapeHtml(text);
}

function renderAdminAudit() {
  const container = document.querySelector("#admin-audit-list");
  if (!container) return;
  const actionLabels = { create: "新增", update: "更新", adjust: "調整", upload: "上傳", delete: "刪除" };
  const resourceLabels = { product: "商品", product_variant: "規格", category: "分類", bank_account: "收款帳戶", coupon: "優惠券", birthday_coupon_settings: "生日券設定", point_settings: "點數設定", member_points: "會員點數", product_image: "商品圖片" };
  const logs = Array.isArray(adminData?.auditLogs) ? adminData.auditLogs : [];
  container.innerHTML = logs.length ? logs.map((entry) => {
    const actor = relationOne(entry.profiles);
    return `<article class="admin-card audit-log-card"><div><strong>${escapeHtml(actionLabels[entry.action] || entry.action)} · ${escapeHtml(resourceLabels[entry.resource] || entry.resource)}</strong><small>${formatDateTime(entry.created_at)} · 操作人：${escapeHtml(actor?.full_name || entry.actor_id || "未知")}</small><small>目標：${escapeHtml(entry.target || "—")}</small><small>前：<code>${auditJsonSummary(entry.before_data)}</code></small><small>後：<code>${auditJsonSummary(entry.after_data)}</code></small></div></article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的稽核紀錄。</div>';
}

function notificationStatusLabel(status) {
  return { pending: "待處理", processing: "發送中", sent: "已送出", failed: "失敗" }[status] || status || "未知";
}

function renderAdminNotifications() {
  const container = document.querySelector("#admin-notification-list");
  if (!container) return;
  const channelLabels = { line: "LINE", telegram: "Telegram" };
  const logs = Array.isArray(adminData?.notificationDeliveries) ? adminData.notificationDeliveries : [];
  container.innerHTML = logs.length ? logs.map((entry) => {
    const failed = entry.status === "failed";
    const retryButton = failed ? `<button class="secondary-button" type="button" data-admin-notification-requeue="${escapeHtml(entry.channel)}:${escapeHtml(entry.id)}">重新排入</button>` : "";
    const retryAt = entry.next_retry_at ? `下次重試：${formatDateTime(entry.next_retry_at)}` : "無排程重試";
    const error = entry.error_message ? `錯誤：${escapeHtml(entry.error_message)}` : "無錯誤訊息";
    return `<article class="admin-card notification-delivery-card"><div><strong>${escapeHtml(channelLabels[entry.channel] || entry.channel)} · ${escapeHtml(notificationStatusLabel(entry.status))}</strong><small>${formatDateTime(entry.updated_at || entry.created_at)} · 事件 ${escapeHtml(entry.event_type || "—")}</small><small>收件人：${escapeHtml(entry.recipient_name || entry.recipient_hint || "已遮罩")} · 訂單：${escapeHtml(entry.order_number || "—")}</small><small>嘗試 ${Number(entry.attempt_count || 0)} 次 · ${escapeHtml(retryAt)}</small><small>${error}</small></div>${retryButton}</article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的通知紀錄。</div>';
}

export async function requeueAdminNotification(button) {
  const [channel, id] = String(button.dataset.adminNotificationRequeue || "").split(":");
  if (!["line", "telegram"].includes(channel) || !/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("通知紀錄資料不正確");
  if (!(await adminConfirm({ title: "重新排入這筆失敗通知？", message: "會在下一次排程重試時發送，現在不會立即發送。", confirmLabel: "重新排入", trigger: button }))) return;
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/notification-deliveries/${channel}/${id}/requeue`, { method: "POST", body: JSON.stringify({}) });
    await loadAdminSection("notifications", { force: true });
    showToast("通知已排入下一次重試", "success");
  } finally {
    button.disabled = false;
  }
}

const adminOrderStatusFilterGroups = [
  { label: "待處理", options: [["seller_pending", "賣貨便待核對"], ["pending_payment", "待付款"], ["pending_review", "待確認款項"]] },
  { label: "處理中", options: [["confirmed", "已確認款項（依配送狀態）"], ["ready_for_pickup", "配送處理中（到貨／出貨／待尾款）"]] },
  { label: "結案／退款", options: [["completed", "已完成訂單"], ["cancelled", "已取消"], ["refund_pending", "退款處理中"], ["refunded", "已退款"]] }
];

function renderAdminOrderStatusFilter() {
  const select = document.querySelector("#admin-order-status-filter");
  if (!select) return;
  const orders = Array.isArray(adminData?.orders) ? adminData.orders : [];
  const counts = Object.fromEntries(adminOrderStatusFilterGroups.flatMap((group) => group.options).map(([value]) => [value, 0]));
  orders.forEach((order) => {
    if (Object.prototype.hasOwnProperty.call(counts, order.status)) counts[order.status] += 1;
    if (order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id) counts.seller_pending += 1;
  });
  const previous = select.value;
  const countLabel = (value) => counts[value] ? `（${counts[value]}）` : "";
  select.innerHTML = `<option value="all">全部訂單${orders.length ? `（${orders.length}）` : ""}</option>` + adminOrderStatusFilterGroups.map((group) => `<optgroup label="${group.label}">${group.options.map(([value, label]) => `<option value="${value}">${label}${countLabel(value)}</option>`).join("")}</optgroup>`).join("");
  const available = new Set(["all", ...adminOrderStatusFilterGroups.flatMap((group) => group.options.map(([value]) => value))]);
  select.value = available.has(previous) ? previous : "all";
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

export function removeLegacyShippingUI() {
  document.querySelector("[data-admin-tab='shipping']")?.remove();
  document.querySelector("[data-admin-panel='shipping']")?.remove();
  const checkoutCopy = document.querySelector("#checkout-form > .dialog-copy");
  if (checkoutCopy) checkoutCopy.textContent = "送出後會立即保留商品；購物車若含現貨與預購，會分開建立訂單與付款期限。本站匯款訂單請於預購 2 小時內、現貨 24 小時內回報末五碼；確認付款後才扣除庫存。預購賣貨便到貨後由客服通知並開立賣貨便，運費由 7-11 取貨時收取；宅配現貨付款確認後即可由客服確認尾款與運費，預購商品則於到貨後通知。";
  const checkoutTerms = document.querySelector("#checkout-form > .terms");
  if (checkoutTerms) checkoutTerms.textContent = "送出後將立即保留本組商品庫存；預購須於 2 小時內、現貨須於 24 小時內完成匯款，逾期未回報付款將自動取消並釋放保留量，確認付款後才扣除庫存。付款完成視同同意代購規則；賣貨便運費由 7-11 於取貨時收取，宅配現貨付款確認後由客服確認尾款與運費，預購商品到貨後通知，確認入帳後才安排寄出，任何原因不接受退換貨。";
  const productCopy = document.querySelector("[data-admin-panel='products'] > .dialog-copy");
  if (productCopy) productCopy.textContent = "新增商品時可先上傳 1 張主圖；建立後可在商品卡「編輯商品資料與照片」批量上傳，最多 10 張。JPG、PNG、WebP 會優先保留比例、縮放並轉成 WebP，若瀏覽器不支援轉換則保留原始格式；單張上限 5MB。";
  const orderCopy = document.querySelector("[data-admin-panel='orders'] > .dialog-copy");
  if (orderCopy) orderCopy.textContent = "建立訂單會先保留庫存；確認訂金／付款後才會扣除庫存。未扣庫存的取消會釋放保留量；已扣庫存且尚未完成交付的取消會反轉原銷售異動。賣貨便運費由 7-11 向客戶收取，不計入訂單；現貨宅配付款確認後即可填寫實際運費，預購宅配則於到貨後更新狀態，再確認尾款與運費入帳後安排寄出。";
  const ordersCopy = document.querySelector("#orders-dialog .dialog-copy");
  if (ordersCopy) ordersCopy.textContent = "可查看訂單狀態，匯款訂單可補填匯款帳號末五碼；賣貨便訂單會先顯示為待確認，待管理員人工核對。";
}

function renderPointSettings() {
  const settings = adminData.pointSettings;
  if (!settings) return;
  document.querySelector("#point-earn-amount").value = settings.earn_amount_per_point;
  document.querySelector("#point-value").value = settings.point_value;
  document.querySelector("#point-min-redeem").value = settings.min_redeem_points;
  document.querySelector("#point-max-mode").value = settings.max_redeem_mode;
  document.querySelector("#point-max-value").value = settings.max_redeem_value;
  syncPointMaxHint();
}

function memberPointEntries(memberId) {
  return (adminData.pointEntries || []).filter((entry) => entry.member_id === memberId);
}

function renderAdminMembers() {
  renderPointSettings();
  const container = document.querySelector("#admin-member-list");
  const keyword = document.querySelector("#admin-member-search").value.trim().toLowerCase();
  const members = (adminData.members || []).filter((member) => `${member.full_name || ""} ${member.phone || ""}`.toLowerCase().includes(keyword));
  if (!members.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的會員。</div>';
    renderAdminPagination("members");
    return;
  }
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  container.innerHTML = members.map((member) => {
    const entries = memberPointEntries(member.id).slice(0, 8);
    const history = entries.map((entry) => { const order = relationOne(entry.orders); const actor = relationOne(entry.actor); return `<li><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)}${order?.order_number ? ` · ${escapeHtml(order.order_number)}` : ""}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong><small>${formatDateTime(entry.created_at)} · ${escapeHtml(entry.reason)}${actor?.full_name ? ` · 操作：${escapeHtml(actor.full_name)}` : ""}</small></li>`; }).join("");
    const memberOrders = (adminData.orders || []).filter((order) => order.member_id === member.id).slice(0, 8);
    const orderHistory = memberOrders.map((order) => `<li><span>${escapeHtml(order.order_number)} · ${escapeHtml(orderStatusLabel(order))}</span><strong>${money(order.amount_due)}</strong><small>${formatDateTime(order.created_at)} · ${order.delivery_method === "store_pickup" ? "到店取貨" : order.delivery_method === "seller_delivery" ? "賣貨便" : "宅配"}</small></li>`).join("");
    return `<article class="admin-member-card"><header><div><h3>${escapeHtml(member.full_name || "尚未填寫姓名")}${member.is_admin ? " · 管理員" : ""}</h3><small>${escapeHtml(member.phone || "尚未填寫手機")} · 加入於 ${formatDateTime(member.created_at)}</small></div><div class="member-metrics"><span>點數<b>${member.point_balance}</b></span><span>累積消費<b>${money(member.lifetime_spend)}</b></span><span>訂單<b>${member.order_count}</b></span></div></header><div class="member-extra"><span>生日：${escapeHtml(member.birthday || "未填")}</span><span>地址：${escapeHtml(member.address || "未填")}</span></div><form class="admin-point-adjust" data-admin-points-form="${member.id}"><label>異動點數<input name="points" required type="number" step="1" placeholder="增加填正數、扣除填負數" /></label><label>原因<input name="reason" required maxlength="200" placeholder="例如：活動贈點、人工更正" /></label><button class="secondary-button" type="submit">調整點數</button></form><details class="admin-order-history"><summary>消費紀錄（${member.order_count || 0}）</summary>${orderHistory ? `<ol class="member-ledger">${orderHistory}</ol>` : '<p>尚無消費紀錄。</p>'}</details><details class="admin-order-history"><summary>點數紀錄（${memberPointEntries(member.id).length}）</summary>${history ? `<ol class="member-ledger">${history}</ol>` : '<p>尚無點數紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("members");
}

export function syncPointMaxHint() {
  const mode = document.querySelector("#point-max-mode").value;
  const input = document.querySelector("#point-max-value");
  input.max = mode === "percent" ? "100" : "";
  document.querySelector("#point-max-hint").textContent = mode === "percent" ? "百分比請填 0–100" : "固定折抵金額（元）";
}

export async function submitPointSettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/point-settings", { method: "PUT", body: JSON.stringify({
    earn_amount_per_point: Number(document.querySelector("#point-earn-amount").value),
    point_value: Number(document.querySelector("#point-value").value),
    min_redeem_points: Number(document.querySelector("#point-min-redeem").value),
    max_redeem_mode: document.querySelector("#point-max-mode").value,
    max_redeem_value: Number(document.querySelector("#point-max-value").value)
  }) });
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("點數規則已儲存", "success");
}

export function editCoupon(couponId) {
  const coupon = (adminData.coupons || []).find((item) => item.id === couponId);
  if (!coupon) return;
  document.querySelector("#coupon-id").value = coupon.id;
  document.querySelector("#coupon-code").value = coupon.code;
  document.querySelector("#coupon-name").value = coupon.name;
  document.querySelector("#coupon-amount").value = coupon.discount_amount;
  document.querySelector("#coupon-member-limit").value = coupon.per_member_limit;
  document.querySelector("#coupon-valid-from").value = localDateTime(coupon.valid_from);
  document.querySelector("#coupon-valid-until").value = localDateTime(coupon.valid_until);
  document.querySelector("#coupon-total-limit").value = coupon.total_usage_limit || "";
  document.querySelector("#coupon-combinable").checked = coupon.combinable_with_points;
  document.querySelector("#coupon-active").checked = coupon.is_active;
  const productIds = new Set((coupon.coupon_products || []).map((item) => item.product_id));
  const memberIds = new Set((coupon.coupon_members || []).map((item) => item.member_id));
  document.querySelectorAll("[name='coupon_product']").forEach((input) => { input.checked = productIds.has(input.value); });
  document.querySelectorAll("[name='coupon_member']").forEach((input) => { input.checked = memberIds.has(input.value); });
  // 表單在滑出面板內時由 admin-sheets.js 開啟並捲回頂端；對 fixed 面板呼叫 scrollIntoView 會讓 iOS Safari 捲動整頁、點擊錯位
  const couponForm = document.querySelector("#admin-coupon-form");
  if (!couponForm.closest(".admin-sheet-panel")) couponForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

export async function submitCoupon(event) {
  event.preventDefault();
  const id = document.querySelector("#coupon-id").value;
  const totalLimit = document.querySelector("#coupon-total-limit").value;
  const body = {
    code: document.querySelector("#coupon-code").value.toUpperCase(), name: document.querySelector("#coupon-name").value,
    discount_amount: Number(document.querySelector("#coupon-amount").value), per_member_limit: Number(document.querySelector("#coupon-member-limit").value),
    valid_from: new Date(document.querySelector("#coupon-valid-from").value).toISOString(), valid_until: new Date(document.querySelector("#coupon-valid-until").value).toISOString(),
    total_usage_limit: totalLimit ? Number(totalLimit) : null, combinable_with_points: document.querySelector("#coupon-combinable").checked,
    is_active: document.querySelector("#coupon-active").checked,
    product_ids: [...document.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value),
    member_ids: [...document.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)
  };
  await adminFetch(id ? `/api/admin/coupons/${id}` : "/api/admin/coupons", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
  await refreshAdminSections(["discounts"]); resetCouponForm(); switchAdminTab("discounts"); showToast("優惠券已儲存", "success");
}

export async function submitBirthdaySettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/birthday-coupon-settings", { method: "PUT", body: JSON.stringify({ enabled: document.querySelector("#birthday-enabled").checked, discount_amount: Number(document.querySelector("#birthday-amount").value), issue_days_before: Number(document.querySelector("#birthday-before").value), valid_days: Number(document.querySelector("#birthday-valid-days").value), combinable_with_points: document.querySelector("#birthday-combinable").checked }) });
  await refreshAdminSections(["discounts"]); switchAdminTab("discounts"); showToast("生日券規則已儲存", "success");
}

export async function issueBirthdayCouponsNow() {
  if (!(await adminConfirm({ title: "立即執行生日券發送？", message: "已發送過的會員不會重複取得。", confirmLabel: "立即發送" }))) return;
  const result = await adminFetch("/api/admin/birthday-coupons/issue", { method: "POST" });
  await refreshAdminSections(["discounts"]);
  switchAdminTab("discounts");
  showToast(`生日券發送完成（新增 ${result.issued || 0} 張）`, "success");
}

export async function submitMemberPointAdjustment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("會員點數表單資料無法讀取");
  const pointsField = form.querySelector("[name='points']");
  const reasonField = form.querySelector("[name='reason']");
  if (!(pointsField instanceof HTMLInputElement) || !(reasonField instanceof HTMLInputElement)) throw new Error("會員點數表單欄位不完整");
  const points = Number(pointsField.value);
  const reason = reasonField.value.trim();
  if (!Number.isInteger(points) || points === 0 || !reason) throw new Error("請填寫非 0 點數與異動原因");
  if (!(await adminConfirm({ title: `確定要${points > 0 ? "增加" : "扣除"} ${Math.abs(points)} 點？`, message: `異動原因：${reason}`, confirmLabel: points > 0 ? "確定增加" : "確定扣除", danger: points < 0, trigger: event.submitter }))) return;
  await adminFetch(`/api/admin/members/${form.dataset.adminPointsForm}/points`, { method: "POST", body: JSON.stringify({ points, reason }) });
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("會員點數已調整", "success");
}

function adminOrderHistory(orderId) {
  return (adminData.orderHistory || []).filter((entry) => entry.order_id === orderId);
}

function adminReturnConfirmation(orderItemId) {
  return (adminData.returns || []).find((entry) => entry.order_item_id === orderItemId);
}

function renderAdminReturnPanel(order) {
  if (order.status !== "refunded") return "";
  const items = (order.order_items || []).filter((item) => item.id);
  if (!items.length) return "";
  const rows = items.map((item) => {
    const confirmation = adminReturnConfirmation(item.id);
    const itemLabel = `${item.product_name || "商品"}${item.variant_name && item.variant_name !== "單一規格" ? ` · ${item.variant_name}` : ""}`;
    if (confirmation) {
      return `<div class="admin-return-confirmed"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><small>已驗收 ${confirmation.received_quantity} 件：可再售 ${confirmation.restock_quantity} 件、報廢 ${confirmation.scrap_quantity} 件 · ${formatDateTime(confirmation.created_at)}</small>${confirmation.note ? `<small>備註：${escapeHtml(confirmation.note)}</small>` : ""}</div>`;
    }
    return `<form class="admin-return-form" data-admin-return-form="${escapeHtml(item.id)}" data-return-max="${Number(item.quantity) || 0}"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><p class="admin-order-note">收到退貨後才填寫。可再售數量才會回補庫存，報廢數量只留下稽核紀錄。</p><div class="form-grid"><label>收到數量<input name="received_quantity" type="number" min="1" max="${Number(item.quantity) || 0}" required /></label><label>可再售回補<input name="restock_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label>報廢數量<input name="scrap_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label class="wide">驗收備註<textarea name="note" rows="2" maxlength="1000" placeholder="例如：外盒損傷、配件缺少"></textarea></label></div><button class="secondary-button" type="submit">確認退貨驗收</button></form>`;
  }).join("");
  return `<section class="admin-return-panel"><h4>退貨驗收</h4><p class="admin-order-note">已退款訂單不會自動回補；逐項確認實際收到數量，再分為可再售或報廢。</p>${rows}</section>`;
}

function adminDiscountLabel(value) {
  const amount = Math.max(0, Number(value || 0));
  return amount > 0 ? `-${money(amount)}` : "未使用";
}

function renderAdminOrders() {
  const container = document.querySelector("#admin-order-list");
  const keyword = document.querySelector("#admin-order-search").value.trim().toLowerCase();
  const status = document.querySelector("#admin-order-status-filter").value;
  const orders = (adminData.orders || []).filter((order) => {
    const member = relationOne(order.profiles);
    const searchable = `${order.order_number} ${member?.full_name || ""} ${member?.phone || ""} ${order.payment_last_five || ""}`.toLowerCase();
    const isSellerPending = order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const matchesStatus = status === "all" || (status === "seller_pending" ? isSellerPending : order.status === status);
    return matchesStatus && searchable.includes(keyword);
  }).sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的訂單。</div>';
    renderAdminPagination("orders");
    return;
  }
  container.innerHTML = orders.map((order) => {
    const member = relationOne(order.profiles);
    const account = relationOne(order.bank_accounts);
    const items = (order.order_items || []).map((item) => `<div><span>${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}</span><strong>${money(item.unit_price * item.quantity)}</strong></div>`).join("");
    const hasPreorder = orderIncludesPreorder(order);
    const preorderStorePickup = order.delivery_method === "store_pickup" && hasPreorder;
    const transitions = (adminOrderTransitions[order.status] || []).filter((item) =>
      (!item.splitOnly || order.pickup_plan === "split")
      && (!item.storePaymentOnly || !order.bank_account_id)
      && (item.value !== "partially_ready" || preorderStorePickup)
      && (item.value !== "ready_for_pickup" || preorderStorePickup || order.delivery_method === "seller_delivery" || (order.delivery_method === "home_delivery" && hasPreorder))
      && !(item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder)
      && !(item.value === "cancelled" && order.delivery_method === "seller_delivery" && order.status === "ready_for_pickup")
      && (item.value !== "completed" || order.delivery_method !== "home_delivery" || Boolean(order.final_payment_confirmed_at))
    );
    const options = transitions.map((item) => {
      const label = item.value === "confirmed" && order.delivery_method === "seller_delivery" && !order.bank_account_id
        ? "確認賣貨便訂單並扣除庫存"
        : item.value === "confirmed" && order.delivery_method === "seller_delivery"
          ? "確認預購訂金並扣除庫存"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder
          ? "確認已出貨並通知會員"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && hasPreorder
          ? "商品已到貨，通知會員開賣貨便"
        : item.value === "ready_for_pickup" && order.delivery_method === "home_delivery" && hasPreorder
          ? "預購商品已到貨，通知會員確認尾款／運費"
        : item.value === "ready_for_pickup" && preorderStorePickup
          ? "通知會員可到店取貨"
        : item.value === "completed" && order.delivery_method === "seller_delivery"
          ? "確認已出貨、通知會員並完成訂單"
        : item.value === "completed" && order.delivery_method === "home_delivery"
          ? "確認寄送完成並結束訂單"
        : item.label;
      return `<option value="${item.value}">${escapeHtml(label)}</option>`;
    }).join("");
    const history = adminOrderHistory(order.id).slice(0, 5).map((entry) => { const actor = relationOne(entry.profiles); return `<li><span>${escapeHtml(adminOrderStatusLabel(order, entry.from_status))} → ${escapeHtml(adminOrderStatusLabel(order, entry.to_status))}</span><small>${formatDateTime(entry.created_at)}${actor?.full_name ? ` · ${escapeHtml(actor.full_name)}` : ""}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small></li>`; }).join("");
    const balance = Math.max(order.amount_due - order.paid_amount, 0);
    const couponDiscount = Number(order.coupon_discount || 0);
    const pointDiscount = Number(order.point_discount || 0);
    const deliveryLabel = deliveryMethodLabels[order.delivery_method || "store_pickup"] || "到店取貨";
    const orderDeliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryLabel}`;
    const shippingInfo = order.delivery_method === "home_delivery" ? `<p class="admin-order-note">收件人：${escapeHtml(order.shipping_recipient_name || "未填寫")}<br />電話：${escapeHtml(order.shipping_phone || "未填寫")}<br />地址：${escapeHtml(order.shipping_address || "未填寫")}</p>` : "";
    return `<article class="admin-order-card"><header><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(orderDeliveryLabel)}${order.confirmed_at || order.payment_confirmed_at ? ` · 確認：${formatDateTime(order.confirmed_at || order.payment_confirmed_at)}` : ""}</small></div><span class="status-chip status-${order.status}">${escapeHtml(adminOrderStatusLabel(order))}</span></header><div class="admin-order-member"><strong>${escapeHtml(member?.full_name || "未填姓名")}</strong><span>${escapeHtml(member?.phone || "未填手機")}</span></div><div class="admin-order-items">${items}</div><div class="admin-order-payment"><span class="admin-order-total">總額 <b>${money(order.amount_due)}</b></span><span class="admin-order-payment-method">運費 <b>${order.shipping_fee ? money(order.shipping_fee) : "免運"}</b></span><span class="admin-order-deposit">訂金應付 <b>${money(order.deposit_due)}</b></span><span class="admin-order-paid">已確認 <b>${money(order.paid_amount || 0)}</b></span><span class="admin-order-balance">待收尾款 <b>${money(balance)}</b></span><span class="admin-order-discount admin-order-coupon">優惠券折抵 <b>${adminDiscountLabel(couponDiscount)}</b></span><span class="admin-order-discount admin-order-points">點數折抵 <b>${adminDiscountLabel(pointDiscount)}</b></span></div>${shippingInfo}<div class="admin-order-bank"><span>${escapeHtml(account?.label || account?.bank_name || "未指定帳戶")}</span><span>匯款末五碼：<b>${escapeHtml(order.payment_last_five || "尚未回報")}</b></span></div>${order.admin_note ? `<p class="admin-order-note">目前備註：${escapeHtml(order.admin_note)}</p>` : ""}${transitions.length ? `<form class="admin-order-action" data-admin-order-form="${order.id}"><label>下一步<select name="target_status">${options}</select></label><label>管理備註<textarea name="note" rows="2" maxlength="1000" placeholder="取消與退款相關操作必填；其他操作可選填"></textarea></label><button class="primary-button" type="submit">更新訂單</button></form>` : '<p class="admin-order-terminal">此訂單目前沒有可執行的下一步。</p>'}${renderAdminReturnPanel(order)}<details class="admin-order-history"><summary>狀態紀錄（${adminOrderHistory(order.id).length}）</summary>${history ? `<ol>${history}</ol>` : '<p>尚無管理異動紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("orders");
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const paymentNode = card.querySelector(".admin-order-payment-method");
    const order = orders[index];
    if (!paymentNode || !order) return;
    const hasPreorder = orderIncludesPreorder(order);
    paymentNode.innerHTML = `付款方式 <b>${order.bank_account_id ? "匯款／轉帳" : order.delivery_method === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付"}</b>`;
    const paymentGrid = card.querySelector(".admin-order-payment");
    const shippingFeeLabel = order.delivery_method === "store_pickup" ? "免運" : order.delivery_method === "seller_delivery" ? "由 7-11 收取" : order.shipping_fee ? money(order.shipping_fee) : "待客服通知";
    const balanceLabel = order.delivery_method === "store_pickup" ? "到店確認" : order.delivery_method === "seller_delivery" ? "依賣貨便訂單" : order.final_payment_confirmed_at ? "已確認" : "尚未確認";
    if (paymentGrid) paymentGrid.insertAdjacentHTML("beforeend", `<span>${order.delivery_method === "seller_delivery" ? "賣貨便運費" : "實際運費"} <b>${shippingFeeLabel}</b></span><span>尾款／運費 <b>${balanceLabel}</b></span>`);
    if (order.delivery_method === "home_delivery") {
      const currentStockHomePending = order.delivery_method === "home_delivery" && !hasPreorder && order.status === "pending_review";
      const canUpdateFulfillment = currentStockHomePending || ["partially_ready", "ready_for_pickup"].includes(order.status);
      const terminalStatuses = ["completed", "cancelled", "refund_pending", "refunded"];
      const insertBefore = card.querySelector(".admin-order-action") || card.querySelector(".admin-order-history");
      if (canUpdateFulfillment) {
        const form = document.createElement("form");
        form.className = "admin-fulfillment-form";
        form.dataset.adminFulfillmentForm = order.id;
        const fulfillmentTiming = currentStockHomePending ? "待確認款項階段填寫" : hasPreorder ? "預購商品到貨後" : "現貨備貨完成後";
        const shippingFeeField = `<label>實際運費<input name="shipping_fee" type="number" min="0" step="1" value="${Number(order.shipping_fee || 0)}" required /><small>${fulfillmentTiming}填寫，會加入待收金額。</small></label>`;
        const finalPaymentLabel = currentStockHomePending ? "已確認全額與運費入帳" : "已確認尾款與運費入帳";
        const lastFiveLabel = currentStockHomePending ? "匯款末五碼" : "尾款匯款末五碼";
        const submitLabel = currentStockHomePending ? "儲存運費／匯款末五碼" : "儲存尾款／運費";
        const notePlaceholder = currentStockHomePending ? "例如：客服確認運費金額、匯款確認日期" : "例如：宅配箱型、客服通知日期";
        form.innerHTML = `<div class="form-grid"><div>${shippingFeeField}</div><label>${lastFiveLabel}<input name="final_payment_last_five" maxlength="5" inputmode="numeric" pattern="[0-9]{5}" value="${escapeHtml(order.final_payment_last_five || "")}" placeholder="付款後填寫" /></label><label class="check-field"><input name="final_payment_confirmed" type="checkbox" ${order.final_payment_confirmed_at ? "checked" : ""} /> ${finalPaymentLabel}</label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="${notePlaceholder}">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="secondary-button" type="submit">${submitLabel}</button>`;
        card.insertBefore(form, insertBefore);
      } else if (!terminalStatuses.includes(order.status)) {
        const prompt = document.createElement("p");
        prompt.className = "admin-order-terminal";
        prompt.textContent = order.status === "confirmed"
          ? hasPreorder
            ? "預購宅配：請等商品實際到貨後，更新為「預購商品已到貨」；之後即可填寫尾款與運費。"
            : "現貨宅配：請在待確認款項階段填寫實際運費與匯款末五碼，再確認款項並扣除庫存。"
          : "請先完成訂金／付款確認；宅配進入備貨或到貨狀態後，才能填寫尾款與運費。";
        card.insertBefore(prompt, insertBefore);
      }
    }
  });
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const order = orders[index];
    const sellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const preorderSellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && Boolean(order.bank_account_id);
    if (!sellerPending && !preorderSellerPending) return;
    if (preorderSellerPending) {
      card.classList.add("preorder-seller-pending");
      const statusChip = card.querySelector(".status-chip");
      if (statusChip) statusChip.textContent = "預購待付訂";
      if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：會員須於 2 小時內回報末五碼；確認後保留庫存，商品到貨再由客服開立賣貨便。</p>');
      return;
    }
    card.classList.add("seller-pending");
    const statusChip = card.querySelector(".status-chip");
    if (statusChip) {
      statusChip.textContent = "賣貨便待確認";
      statusChip.classList.add("status-seller-pending");
    }
    if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>請先核對賣貨便訂單</strong>：確認外部訂單內容後，再更新狀態並扣除庫存。</p>');
  });
  container.querySelectorAll("[data-admin-order-form]").forEach((form) => {
    const target = form.querySelector("select[name='target_status']");
    const button = form.querySelector("button[type='submit']");
    if (!(target instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) return;
    const syncRiskState = () => {
      const dangerous = ["cancelled", "refund_pending", "refunded"].includes(target.value);
      button.classList.toggle("danger-button", dangerous);
      button.textContent = dangerous ? "確認高風險操作" : "更新訂單";
      button.setAttribute("aria-label", dangerous ? "確認取消或退款等高風險操作" : "更新訂單");
    };
    target.addEventListener("change", syncRiskState);
    syncRiskState();
  });
}

export async function submitAdminOrderTransition(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("訂單表單資料無法讀取");
  const targetStatusField = form.querySelector("select[name='target_status']");
  const noteField = form.querySelector("textarea[name='note']");
  if (!(targetStatusField instanceof HTMLSelectElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("訂單表單欄位不完整");
  const targetStatus = targetStatusField.value;
  const note = noteField.value.trim();
  if (["cancelled", "refund_pending", "refunded"].includes(targetStatus) && !note) throw new Error("取消或退款相關操作必須填寫原因");
  const currentOrder = (adminData.orders || []).find((order) => order.id === form.dataset.adminOrderForm);
  const warning = targetStatus === "confirmed"
    ? "確認款項後會正式扣除商品庫存。"
    : targetStatus === "completed"
      ? "完成訂單代表商品已取走且尾款已收訖。"
      : targetStatus === "cancelled" && ["pending_payment", "pending_review"].includes(currentOrder?.status)
        ? "此訂單尚未扣除實體庫存；取消後會釋放保留量。"
      : targetStatus === "cancelled"
        ? "此訂單已扣除庫存且尚未完成交付；取消後會由系統反轉原銷售異動，不能再手動重複回補。"
      : ["refund_pending", "refunded"].includes(targetStatus)
        ? "退款流程不會自動回補庫存；收到實物後，請在已退款訂單逐項驗收並分為可再售或報廢。"
        : "";
  if (!(await adminConfirm({ title: "確定更新此訂單狀態？", message: warning, confirmLabel: "確定更新", danger: ["cancelled", "refund_pending", "refunded"].includes(targetStatus), trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminOrderForm}/transition`, { method: "POST", body: JSON.stringify({ target_status: targetStatus, note }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("訂單狀態已更新", "success");
    await loadProducts();
    renderProducts();
  } finally {
    button.disabled = false;
  }
}

export async function submitAdminOrderReturn(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("退貨驗收表單資料無法讀取");
  const receivedField = form.elements.namedItem("received_quantity");
  const restockField = form.elements.namedItem("restock_quantity");
  const scrapField = form.elements.namedItem("scrap_quantity");
  const noteField = form.elements.namedItem("note");
  if (!(receivedField instanceof HTMLInputElement) || !(restockField instanceof HTMLInputElement) || !(scrapField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("退貨驗收表單欄位不完整");
  const received = Number(receivedField.value);
  const restock = Number(restockField.value);
  const scrap = Number(scrapField.value);
  const max = Number(form.dataset.returnMax || 0);
  if (![received, restock, scrap].every(Number.isInteger) || received <= 0 || received > max || restock < 0 || scrap < 0 || restock + scrap !== received) throw new Error("收到、可再售與報廢數量必須正確相等，且不可超過原購買數量");
  if (!(await adminConfirm({ title: "確認退貨驗收？", message: `收到 ${received} 件，其中可再售 ${restock} 件、報廢 ${scrap} 件。`, confirmLabel: "確認驗收", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/order-items/${form.dataset.adminReturnForm}/return`, { method: "POST", body: JSON.stringify({ received_quantity: received, restock_quantity: restock, scrap_quantity: scrap, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("退貨驗收已記錄", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

export async function submitAdminOrderFulfillment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("尾款與運費表單資料無法讀取");
  const shippingField = form.elements.namedItem("shipping_fee");
  const finalFiveField = form.elements.namedItem("final_payment_last_five");
  const confirmedField = form.elements.namedItem("final_payment_confirmed");
  const noteField = form.elements.namedItem("note");
  if (!(shippingField instanceof HTMLInputElement) || !(finalFiveField instanceof HTMLInputElement) || !(confirmedField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("尾款與運費表單欄位不完整");
  const shippingFee = Number(shippingField.value);
  const finalFive = finalFiveField.value.trim();
  const confirmed = confirmedField.checked;
  if (!Number.isInteger(shippingFee) || shippingFee < 0) throw new Error("實際運費必須是 0 或正整數");
  if (confirmed && !/^\d{5}$/.test(finalFive)) throw new Error("請填寫 5 位數尾款匯款末五碼");
  if (confirmed && !(await adminConfirm({ title: "確認尾款與運費已入帳？", message: "確認後即可完成寄送訂單。", confirmLabel: "確認已入帳", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminFulfillmentForm}/fulfillment`, { method: "PATCH", body: JSON.stringify({ shipping_fee: shippingFee, final_payment_confirmed: confirmed, final_payment_last_five: finalFive || null, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders", "overview"]);
    switchAdminTab("orders");
    showToast("尾款與實際運費已更新", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

function renderAdminAccounts() {
  const container = document.querySelector("#admin-account-list");
  const accounts = adminData.accounts || [];
  container.innerHTML = accounts.length ? accounts.map((account) => `<div class="admin-card"><div><strong>${escapeHtml(account.label)} ${account.is_active ? "" : "（已停用）"}</strong><small>${escapeHtml(account.bank_name)} · ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></div><button type="button" data-account-edit="${account.id}">編輯</button></div>`).join("") : '<div class="empty-state">尚未設定收款帳戶；新增後前台才可建立訂單。</div>';
}

function sortedAdminCategories() {
  return (adminData?.categories || []).slice().sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0) || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hant"));
}

export function adminCategoryOptions(selectedId = "", { required = false, includeInactiveSelected = false } = {}) {
  const selected = String(selectedId || "");
  const categories = sortedAdminCategories().filter((category) => category.is_active !== false || (includeInactiveSelected && String(category.id) === selected));
  const placeholder = required ? "請選擇分類" : "未分類";
  return `<option value="">${placeholder}</option>${categories.map((category) => `<option value="${escapeHtml(category.id)}" data-category-name="${escapeHtml(category.name)}" ${String(category.id) === selected ? "selected" : ""}>${escapeHtml(category.name)}${category.is_active === false ? "（已停用）" : ""}</option>`).join("")}`;
}

export function resetAdminCategoryForm() {
  const form = document.querySelector("#admin-category-form");
  if (form instanceof HTMLFormElement) form.reset();
  const id = document.querySelector("#admin-category-edit-id");
  const order = document.querySelector("#admin-category-order");
  const active = document.querySelector("#admin-category-active");
  const title = document.querySelector("[data-category-form-title]");
  const submit = form?.querySelector("button[type='submit']");
  const cancel = document.querySelector("[data-admin-category-cancel]");
  if (id) id.value = "";
  if (order) order.value = "0";
  if (active) active.checked = true;
  if (title) title.textContent = "新增分類";
  if (submit) submit.textContent = "新增分類";
  cancel?.classList.add("hidden");
}

export function focusAdminCategoryForm() {
  const details = document.querySelector("#admin-category-management");
  if (details instanceof HTMLDetailsElement) details.open = true;
  window.setTimeout(() => document.querySelector("#admin-category-name")?.focus(), 0);
}

export function editAdminCategory(categoryId) {
  const category = sortedAdminCategories().find((item) => item.id === categoryId);
  if (!category) return;
  document.querySelector("#admin-category-edit-id").value = category.id;
  document.querySelector("#admin-category-name").value = category.name;
  document.querySelector("#admin-category-order").value = String(category.display_order || 0);
  document.querySelector("#admin-category-active").checked = category.is_active !== false;
  document.querySelector("[data-category-form-title]").textContent = "編輯分類";
  document.querySelector("#admin-category-form button[type='submit']").textContent = "儲存分類";
  document.querySelector("[data-admin-category-cancel]").classList.remove("hidden");
  const details = document.querySelector("#admin-category-management");
  if (details instanceof HTMLDetailsElement) details.open = true;
  document.querySelector("#admin-category-name")?.focus();
}

function renderAdminCategories() {
  const picker = document.querySelector("#admin-category-id");
  if (picker instanceof HTMLSelectElement) {
    const selected = picker.value;
    picker.innerHTML = adminCategoryOptions(selected, { required: true });
    if ([...picker.options].some((option) => option.value === selected)) picker.value = selected;
  }
  const list = document.querySelector("#admin-category-list");
  if (!(list instanceof HTMLElement)) return;
  const categories = sortedAdminCategories();
  if (!categories.length) {
    list.innerHTML = '<div class="empty-state">尚未建立分類，請先新增一個分類。</div>';
    return;
  }
  const productCounts = new Map(categories.map((category) => [category.id, 0]));
  (adminData.productOptions || adminData.products || []).forEach((product) => {
    if (product.category_id && productCounts.has(product.category_id)) productCounts.set(product.category_id, productCounts.get(product.category_id) + 1);
  });
  list.innerHTML = categories.map((category) => `<article class="admin-card admin-category-card"><div><strong>${escapeHtml(category.name)}</strong><small>排序 ${Number(category.display_order || 0)} · ${category.is_active === false ? "已停用（不供新商品選擇）" : "啟用"} · 使用商品 ${productCounts.get(category.id) || 0} 件</small></div><button type="button" data-admin-category-edit="${escapeHtml(category.id)}">編輯</button></article>`).join("");
}

export async function submitAdminCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.querySelector("#admin-category-edit-id").value.trim();
  const name = document.querySelector("#admin-category-name").value.trim();
  const displayOrder = Number(document.querySelector("#admin-category-order").value || 0);
  const isActive = document.querySelector("#admin-category-active").checked;
  if (!name) throw new Error("請填寫分類名稱");
  if (!Number.isInteger(displayOrder) || displayOrder < 0) throw new Error("分類排序須為 0 或正整數");
  const submit = form.querySelector("button[type='submit']");
  if (submit instanceof HTMLButtonElement) { submit.disabled = true; submit.textContent = "儲存中…"; }
  try {
    await adminFetch(id ? `/api/admin/categories/${id}` : "/api/admin/categories", { method: id ? "PATCH" : "POST", body: JSON.stringify({ name, display_order: displayOrder, is_active: isActive }) });
    invalidateAdminManagementOptions();
    resetAdminCategoryForm();
    await refreshAdminSections(["products"]);
    switchAdminTab("products");
    showToast(id ? "商品分類已更新" : "商品分類已新增", "success");
  } finally {
    if (submit instanceof HTMLButtonElement) { submit.disabled = false; submit.textContent = id ? "儲存分類" : "新增分類"; }
  }
}

function renderAdminSelects({ preserveSelection = false } = {}) {
  const products = adminData.productOptions || adminData.products || [];
  const productOptions = products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
  const productSelect = document.querySelector("#admin-variant-product");
  const selectedProduct = preserveSelection ? productSelect?.value : "";
  if (productSelect) {
    productSelect.innerHTML = productOptions || '<option value="">請先建立商品</option>';
    if (selectedProduct && [...productSelect.options].some((option) => option.value === selectedProduct)) productSelect.value = selectedProduct;
  }
  const variantOptions = products.flatMap((product) => (product.product_variants || []).map((variant) => `<option value="${variant.id}">${escapeHtml(product.name)} · ${escapeHtml(variant.name)}（庫存 ${variant.stock_on_hand}）</option>`)).join("");
  const variantSelect = document.querySelector("#admin-inventory-variant");
  const selectedVariant = preserveSelection ? variantSelect?.value : "";
  if (variantSelect) {
    variantSelect.innerHTML = variantOptions || '<option value="">目前沒有商品規格</option>';
    if (selectedVariant && [...variantSelect.options].some((option) => option.value === selectedVariant)) variantSelect.value = selectedVariant;
  }
}

function refreshAdminManagementOptionControls() {
  if (!adminData) return;
  renderAdminCategories();
  document.querySelectorAll("[data-edit-product-form] select[name='category_id']").forEach((select) => {
    const selected = select.value;
    select.innerHTML = adminCategoryOptions(selected, { includeInactiveSelected: true });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  });
  renderAdminSelects({ preserveSelection: true });
  renderAdminDiscountOptionBoxes({ preserveSelection: true });
}

/** 建立後台商品主圖缺失或載入失敗時的可存取替代內容。 */
export function adminProductImageFallbackMarkup() {
  return '<span class="admin-product-placeholder" role="img" aria-label="尚無商品圖片"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5h16v11H4zM7 6.5l1.8-2h6.4l1.8 2M8 13l2.2-2.2 2.3 2.3 1.5-1.5 2 2"/></svg><small>NO IMAGE</small></span>';
}

/** 將後台商品縮圖的 404／解碼失敗畫面替換為一致的 fallback。 */
export function handleAdminProductImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const thumbnail = image.closest(".admin-product-thumbnail");
  if (!thumbnail || thumbnail.dataset.imageFallbackApplied === "true") return;
  thumbnail.dataset.imageFallbackApplied = "true";
  thumbnail.innerHTML = adminProductImageFallbackMarkup();
}

function ensureAdminPointsEligibilityUI() {
  if (document.querySelector("#admin-points-excluded")) return;
  const limitLabel = document.querySelector("#admin-purchase-limit")?.closest("label");
  if (!limitLabel) return;
  limitLabel.insertAdjacentHTML("afterend", '<label class="check-field admin-points-excluded-field"><input id="admin-points-excluded" type="checkbox" /> 不可累積會員點數<small>啟用後，完成訂單時此商品金額不列入新點數累積。</small></label>');
}

function ensureAdminPricingUI() {
  const productPrice = document.querySelector("#admin-price")?.closest("label");
  if (productPrice && !document.querySelector("#admin-compare-at-price")) productPrice.insertAdjacentHTML("afterend", '<label>原價（選填）<input id="admin-compare-at-price" type="number" min="0" step="1" placeholder="例如 1680" /><small>高於售價時顯示刪除線與限時優惠。</small></label>');
  const variantPrice = document.querySelector("#admin-new-price")?.closest("label");
  if (variantPrice && !document.querySelector("#admin-new-compare-at-price")) variantPrice.insertAdjacentHTML("afterend", '<label>原價（選填）<input id="admin-new-compare-at-price" type="number" min="0" step="1" placeholder="例如 1680" /><small>高於售價時顯示刪除線與限時優惠。</small></label>');
}

// 商品列表版面由 admin-products-table.js 負責（ADMIN_REDESIGN_PLAN Stage 8）；新增商品表單的附加欄位仍在此補上
function renderAdminProducts() {
  ensureAdminPointsEligibilityUI();
  ensureAdminPricingUI();
  renderAdminProductsTable();
  removeLegacyShippingUI();
}

function renderAdminMovements() {
  const container = document.querySelector("#admin-movement-list");
  const movements = adminData.movements || [];
  container.innerHTML = movements.length ? movements.map((movement) => {
    const variant = relationOne(movement.product_variants);
    const product = relationOne(variant?.products);
    const positive = movement.quantity_delta > 0;
    return `<div class="admin-card"><div><strong>${escapeHtml(product?.name || "商品")} · ${escapeHtml(variant?.name || variant?.sku || "規格")}</strong><small>${escapeHtml(movement.reason)} · ${formatDateTime(movement.created_at)}</small></div><strong class="${positive ? "movement-positive" : "movement-negative"}">${positive ? "+" : ""}${movement.quantity_delta}</strong></div>`;
  }).join("") : '<div class="empty-state">目前沒有庫存異動紀錄。</div>';
}

function ensureAdminLowStockUI() {
  const panel = document.querySelector("[data-admin-panel='inventory']");
  const heading = panel?.querySelector("h3");
  if (heading && !document.querySelector("#admin-low-stock-list")) heading.insertAdjacentHTML("beforebegin", '<section class="admin-low-stock" aria-labelledby="admin-low-stock-title"><div class="admin-low-stock-head"><h3 id="admin-low-stock-title">低庫存規格</h3><span id="admin-low-stock-count">0</span></div><div id="admin-low-stock-list"></div></section>');
}

function renderAdminLowStock() {
  ensureAdminLowStockUI();
  const list = document.querySelector("#admin-low-stock-list");
  const count = document.querySelector("#admin-low-stock-count");
  if (!list) return;
  const lowStock = (adminData.productOptions || adminData.managementOptions?.products || []).flatMap((product) => (product.product_variants || []).filter((variant) => Number(variant.stock_on_hand) <= Number(variant.safety_stock)).map((variant) => ({ product, variant })));
  if (count) count.textContent = `${lowStock.length} 項`;
  list.innerHTML = lowStock.length ? lowStock.map(({ product, variant }) => `<div class="admin-low-stock-row"><div><strong>${escapeHtml(product.name)} · ${escapeHtml(variant.name)}</strong><small>SKU ${escapeHtml(variant.sku)} · 安全庫存 ${variant.safety_stock}</small></div><span>${variant.stock_on_hand}</span><button class="secondary-button" type="button" data-admin-low-stock-variant="${escapeHtml(variant.id)}">調整庫存</button></div>`).join("") : '<p class="admin-low-stock-empty">目前沒有低於安全庫存的規格。</p>';
}

export function resetAccountForm() {
  document.querySelector("#admin-account-form").reset();
  document.querySelector("#admin-account-id").value = "";
  document.querySelector("#admin-account-order").value = "0";
  document.querySelector("#admin-account-active").checked = true;
  document.querySelector("[data-account-form-title]").textContent = "新增收款帳戶";
  document.querySelector("[data-account-cancel]").classList.add("hidden");
}

export function editAccount(accountId) {
  const account = (adminData.accounts || []).find((item) => item.id === accountId);
  if (!account) return;
  document.querySelector("#admin-account-id").value = account.id;
  document.querySelector("#admin-account-label").value = account.label;
  document.querySelector("#admin-bank-name").value = account.bank_name;
  document.querySelector("#admin-account-name").value = account.account_name;
  document.querySelector("#admin-account-number").value = account.account_number;
  document.querySelector("#admin-account-order").value = account.display_order;
  document.querySelector("#admin-account-active").checked = account.is_active;
  document.querySelector("[data-account-form-title]").textContent = "編輯收款帳戶";
  document.querySelector("[data-account-cancel]").classList.remove("hidden");
  document.querySelector("#admin-account-label").focus();
}

export async function submitAdminAccount(event) {
  event.preventDefault();
  const id = document.querySelector("#admin-account-id").value;
  const body = {
    label: document.querySelector("#admin-account-label").value,
    bank_name: document.querySelector("#admin-bank-name").value,
    account_name: document.querySelector("#admin-account-name").value,
    account_number: document.querySelector("#admin-account-number").value,
    display_order: Number(document.querySelector("#admin-account-order").value || 0),
    is_active: document.querySelector("#admin-account-active").checked
  };
  await adminFetch(id ? `/api/admin/bank-accounts/${id}` : "/api/admin/bank-accounts", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
  resetAccountForm();
  invalidateBankAccounts();
  await refreshAdminSections(["settings"]);
  switchAdminTab("accounts");
  showToast("收款帳戶已儲存", "success");
}

function normalizePreorderDate(value) {
  const candidate = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

export function splitPreorderArrival(value) {
  const raw = String(value || "").trim();
  if (!raw) return { from: "", until: "", raw: "" };
  const matches = [...raw.matchAll(/(\d{3,4})[\/.-](\d{1,2})[\/.-](\d{1,2})/g)].map((match) => {
    const year = Number(match[1]) < 1000 ? Number(match[1]) + 1911 : Number(match[1]);
    const month = String(Number(match[2])).padStart(2, "0");
    const day = String(Number(match[3])).padStart(2, "0");
    const iso = `${String(year).padStart(4, "0")}-${month}-${day}`;
    const date = new Date(`${iso}T00:00:00`);
    return date.getFullYear() === year && date.getMonth() + 1 === Number(month) && date.getDate() === Number(day) ? iso : "";
  }).filter(Boolean).slice(0, 2);
  const remainder = raw.replace(/\d{3,4}[\/.-]\d{1,2}[\/.-]\d{1,2}/g, "").replace(/[至到~～—–\-\s]/g, "");
  if (!matches.length || remainder) return { from: "", until: "", raw };
  return { from: matches[0], until: matches[1] || "", raw: "" };
}

function preorderArrivalValue(from, until, rawFallback = "") {
  const start = normalizePreorderDate(from);
  const end = normalizePreorderDate(until);
  if (!start && !end) return String(rawFallback || "").trim() || null;
  if (start && end && end < start) throw new Error("預計到貨區間的結束日期不可早於開始日期");
  return start && end && start !== end ? `${start} 至 ${end}` : start || end;
}

function productFormBody() {
  const kind = document.querySelector("#admin-kind").value;
  const categorySelect = document.querySelector("#admin-category-id");
  const categoryOption = categorySelect?.selectedOptions?.[0];
  const categoryId = categorySelect?.value || "";
  const categoryName = categoryOption?.dataset.categoryName || "";
  if (!categoryId || !categoryName) throw new Error("請選擇啟用中的商品分類；若需新增請先建立分類");
  return {
    category_id: categoryId,
    category_name: categoryName,
    product_name: document.querySelector("#admin-product-name").value,
    description: document.querySelector("#admin-product-description").value,
    variant_name: document.querySelector("#admin-variant-name").value,
    sku: document.querySelector("#admin-sku").value,
    kind,
    price: Number(document.querySelector("#admin-price").value),
    compare_at_price: document.querySelector("#admin-compare-at-price")?.value ? Number(document.querySelector("#admin-compare-at-price").value) : null,
    stock: Number(document.querySelector("#admin-stock").value),
    purchase_limit: document.querySelector("#admin-purchase-limit").value ? Number(document.querySelector("#admin-purchase-limit").value) : null,
    points_eligible: !document.querySelector("#admin-points-excluded")?.checked,
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-deposit-rate").value || 0) / 100,
    preorder_arrival: preorderArrivalValue(document.querySelector("#admin-arrival-from").value, document.querySelector("#admin-arrival-until").value),
    seller_link: document.querySelector("#admin-seller-link").value,
    is_published: document.querySelector("#admin-published").checked
  };
}

function validateProductImage(file) {
  if (!file) return;
  if (!(file instanceof File)) throw new Error("請選擇商品照片");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("照片僅支援 JPG、PNG 或 WebP");
  if (file.size > 5 * 1024 * 1024) throw new Error("商品照片不可超過 5MB");
}

const PRODUCT_IMAGE_MAX_DIMENSION = 1600;
const PRODUCT_IMAGE_MAX_PIXELS = 40_000_000;
const PRODUCT_IMAGE_WEBP_QUALITY = 0.86;

async function decodeProductImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        // Fall through to the Image element for browsers with partial ImageBitmap support.
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("圖片無法讀取"));
      image.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function productImageWebpName(name) {
  const baseName = String(name || "product-image").replace(/\.[^/.]+$/, "").trim() || "product-image";
  return `${baseName}.webp`;
}

export async function prepareProductImage(file) {
  if (!file) return null;
  validateProductImage(file);
  let decoded;
  try {
    decoded = await decodeProductImage(file);
  } catch {
    throw new Error("圖片無法讀取，請改用 JPG、PNG 或 WebP 圖片");
  }
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > PRODUCT_IMAGE_MAX_PIXELS) throw new Error("照片解析度過高，請先縮小圖片後再試");
    const scale = Math.min(1, PRODUCT_IMAGE_MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { file, converted: false, width: decoded.width, height: decoded.height };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    try {
      context.drawImage(decoded.source, 0, 0, width, height);
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    let blob;
    try {
      blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("目前瀏覽器不支援 WebP 轉換")), "image/webp", PRODUCT_IMAGE_WEBP_QUALITY));
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    if (!(blob instanceof Blob) || blob.type !== "image/webp" || blob.size > 5 * 1024 * 1024) return { file, converted: false, width: decoded.width, height: decoded.height };
    try {
      return { file: new File([blob], productImageWebpName(file.name), { type: "image/webp", lastModified: Date.now() }), converted: true, width, height };
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
  } finally {
    decoded.close();
  }
}

async function uploadAdminProductImage(productId, file) {
  if (!file) return;
  validateProductImage(file);
  const formData = new FormData();
  formData.append("image", file, file.name);
  await adminFetch(`/api/admin/products/${productId}/image`, { method: "POST", body: formData });
}

export async function submitAdminProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const selectedImage = document.querySelector("#admin-product-image").files[0];
  validateProductImage(selectedImage);
  const submitButton = form.querySelector("button[type='submit']");
  const originalLabel = submitButton?.textContent || "建立商品";
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = selectedImage ? "處理圖片並建立中…" : "建立商品中…"; }
  try {
    const preparedImage = selectedImage ? await prepareProductImage(selectedImage) : null;
    const result = await adminFetch("/api/admin/products", { method: "POST", body: JSON.stringify(productFormBody()) });
    invalidateAdminManagementOptions();
    await uploadAdminProductImage(result.ids.product_id, preparedImage?.file);
    form.reset();
    document.querySelector("#admin-variant-name").value = "單一規格";
    document.querySelector("#admin-stock").value = "0";
    document.querySelector("#admin-purchase-limit").value = "";
    const compareAtPriceInput = document.querySelector("#admin-compare-at-price");
    if (compareAtPriceInput) compareAtPriceInput.value = "";
    document.querySelector("#admin-deposit-rate").value = "0";
    await refreshAdminSections(["products", "inventory", "overview"]);
    switchAdminTab("products");
    const imageNotice = preparedImage && !preparedImage.converted ? "；瀏覽器不支援 WebP 轉換，已保留原始格式" : preparedImage ? "，圖片已轉為 WebP" : "";
    showToast(`商品已建立${imageNotice}`, preparedImage && !preparedImage.converted ? "warning" : "success");
  } finally {
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
  }
}

export async function submitNewVariant(event) {
  event.preventDefault();
  const kind = document.querySelector("#admin-new-kind").value;
  const body = {
    product_id: document.querySelector("#admin-variant-product").value,
    name: document.querySelector("#admin-new-variant-name").value,
    sku: document.querySelector("#admin-new-sku").value,
    kind,
    price: Number(document.querySelector("#admin-new-price").value),
    compare_at_price: document.querySelector("#admin-new-compare-at-price")?.value ? Number(document.querySelector("#admin-new-compare-at-price").value) : null,
    safety_stock: Number(document.querySelector("#admin-new-safety-stock").value || 3),
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-new-deposit-rate").value || 0) / 100,
    preorder_arrival: preorderArrivalValue(document.querySelector("#admin-new-arrival-from").value, document.querySelector("#admin-new-arrival-until").value),
    seller_link: document.querySelector("#admin-new-seller-link").value,
    is_published: document.querySelector("#admin-new-published").checked
  };
  await adminFetch("/api/admin/variants", { method: "POST", body: JSON.stringify(body) });
  invalidateAdminManagementOptions();
  event.currentTarget.reset();
  document.querySelector("#admin-new-safety-stock").value = "3";
  const newCompareAtPriceInput = document.querySelector("#admin-new-compare-at-price");
  if (newCompareAtPriceInput) newCompareAtPriceInput.value = "";
  document.querySelector("#admin-new-deposit-rate").value = "0";
  await refreshAdminSections(["products", "inventory", "overview"]);
  switchAdminTab("products");
  showToast("商品規格已新增", "success");
}

export async function submitInventoryAdjustment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const variantId = document.querySelector("#admin-inventory-variant").value;
  if (!variantId) throw new Error("請先選擇商品規格");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "更新中…";
  }
  try {
    const result = await adminFetch(`/api/admin/variants/${variantId}/inventory`, { method: "POST", body: JSON.stringify({ quantity_delta: Number(document.querySelector("#admin-inventory-delta").value), reason: document.querySelector("#admin-inventory-reason").value }) });
    invalidateAdminManagementOptions();
    form.reset();
    await refreshAdminSections(["inventory", "products", "overview"]);
    switchAdminTab("inventory");
    const variantSelect = document.querySelector("#admin-inventory-variant");
    if (variantSelect) variantSelect.value = variantId;
    const variantLabel = variantSelect?.selectedOptions?.[0]?.textContent?.trim() || "商品規格";
    const feedback = document.querySelector("#admin-inventory-feedback");
    if (feedback) {
      feedback.textContent = `${variantLabel} 已更新，最新庫存 ${Number(result.stock_on_hand ?? 0)} 件。`;
      feedback.classList.remove("hidden");
    }
    showToast(`庫存已更新：${variantLabel} ${Number(result.stock_on_hand ?? 0)} 件`, "success");
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = "確認調整庫存";
    }
  }
}

export async function submitDynamicAdminForm(event) {
  const productId = event.target.dataset.editProductForm;
  const variantId = event.target.dataset.editVariantForm;
  if (!productId && !variantId) return;
  event.preventDefault();
  const form = event.target;
  const formData = new FormData(form);
  const submitButton = form.querySelector("button[type='submit']");
  const originalLabel = submitButton?.textContent || "儲存";
  if (productId) {
    const selectedImage = formData.get("image");
    const hasImage = selectedImage instanceof File && selectedImage.size > 0;
    validateProductImage(hasImage ? selectedImage : null);
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = hasImage ? "處理圖片並儲存中…" : "儲存中…"; }
    let preparedImage = null;
    try {
      preparedImage = hasImage ? await prepareProductImage(selectedImage) : null;
      const purchaseLimit = String(formData.get("purchase_limit") || "").trim();
      await adminFetch(`/api/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), description: formData.get("description"), category_id: String(formData.get("category_id") || "").trim() || null, purchase_limit: purchaseLimit ? Number(purchaseLimit) : null, points_eligible: formData.get("points_excluded") !== "on", display_order: Number(formData.get("display_order") || 0), is_published: formData.get("is_published") === "on" }) });
      invalidateAdminManagementOptions();
      if (preparedImage) await uploadAdminProductImage(productId, preparedImage.file);
      event.target.dataset.imageFallback = preparedImage && !preparedImage.converted ? "true" : "false";
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  } else {
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "儲存中…"; }
    try {
      const kind = formData.get("kind");
      const compareAtPrice = String(formData.get("compare_at_price") || "").trim();
      await adminFetch(`/api/admin/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), sku: formData.get("sku"), kind, price: Number(formData.get("price")), compare_at_price: compareAtPrice ? Number(compareAtPrice) : null, safety_stock: Number(formData.get("safety_stock") || 3), deposit_rate: kind === "preorder" ? 0.5 : Number(formData.get("deposit_rate") || 0) / 100, preorder_arrival: preorderArrivalValue(formData.get("preorder_arrival_from"), formData.get("preorder_arrival_until"), formData.get("preorder_arrival_raw")), display_order: Number(formData.get("display_order") || 0), seller_link: formData.get("seller_link"), is_published: formData.get("is_published") === "on" }) });
      invalidateAdminManagementOptions();
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  }
  await refreshAdminSections(["products", "inventory", "overview"]);
  switchAdminTab("products");
  const imageFallback = productId && event.target.dataset.imageFallback === "true";
  showToast(productId ? `商品資料已儲存${imageFallback ? "；瀏覽器不支援 WebP 轉換，已保留原始格式" : ""}` : "規格資料已儲存", imageFallback ? "warning" : "success");
}

export function syncDepositField(kindSelector, rateInput) {
  const preorder = kindSelector.value === "preorder";
  if (preorder) rateInput.value = "50";
  rateInput.readOnly = preorder;
}
