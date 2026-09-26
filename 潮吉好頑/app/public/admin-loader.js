// 管理後台延遲載入：一般前台訪客不下載後台 JS／CSS，只有第一次開啟後台時才載入（效能優化）。
// 集中原本在 app.js 的後台事件接線與模組初始化；app.js 只保留精簡觸發（openAdminLazy）。
// index.html 內的後台樣式 <link> 已把 href 改放在 data-admin-href，這裡在載入時才寫回 href 觸發下載。
import { adminOrderStatusLabel, formatDateTime, showToast } from "./app-core.js";

const ADMIN_CSS_LINK_SELECTOR = "link[rel='stylesheet'][data-admin-href]";

let loadPromise = null;
let adminApp = null;
let adminShellModule = null;
let adminProductGallery = null;
let adminProductsTable = null;
let adminOrdersPanel = null;
let adminMembersPanel = null;
let adminSystemPanel = null;
let adminCatalogPanel = null;
let adminProductImage = null;

function activateAdminStylesheets() {
  const links = Array.from(document.querySelectorAll(ADMIN_CSS_LINK_SELECTOR));
  return Promise.all(links.map((link) => new Promise((resolve) => {
    const href = link.dataset.adminHref;
    delete link.dataset.adminHref;
    if (!href) { resolve(); return; }
    // 樣式載入失敗不應卡住後台開啟，只是視覺退化（resolve 而非 reject）
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    link.href = href;
  })));
}

async function importAdminModules() {
  const modules = await Promise.all([
    import("./admin-app.js"),
    import("./admin-shell.js"),
    import("./admin-product-gallery.js"),
    import("./admin-products-table.js"),
    import("./admin-orders-panel.js"),
    import("./admin-members-panel.js"),
    import("./admin-system-panel.js"),
    import("./admin-catalog-panel.js"),
    import("./admin-product-image.js")
  ]);
  [adminApp, adminShellModule, adminProductGallery, adminProductsTable, adminOrdersPanel, adminMembersPanel, adminSystemPanel, adminCatalogPanel, adminProductImage] = modules;
}

function bindAdminClickDelegation() {
  document.addEventListener("click", (event) => {
    const adminQuickFilter = event.target.closest("[data-admin-quick-filter]");
    if (adminQuickFilter) adminApp.applyAdminQuickFilter(adminQuickFilter.dataset.adminQuickFilter);
    const lowStockVariant = event.target.closest("[data-admin-low-stock-variant]");
    if (lowStockVariant) {
      const variantSelect = document.querySelector("#admin-inventory-variant");
      if (variantSelect) variantSelect.value = lowStockVariant.dataset.adminLowStockVariant;
      document.querySelector("#admin-inventory-delta")?.focus();
    }
    const adminTab = event.target.closest("[data-admin-tab]");
    if (adminTab) adminApp.switchAdminTab(adminTab.dataset.adminTab);
    if (event.target.closest("[data-admin-refresh]")) adminApp.loadAdminData().catch((error) => showToast(error.message, "error"));
    if (event.target.closest("[data-telegram-test]")) adminApp.testTelegramNotification().catch((error) => showToast(error.message, "error"));
    if (event.target.closest("[data-birthday-issue]")) adminMembersPanel.issueBirthdayCouponsNow().catch((error) => showToast(error.message, "error"));
    const adminPageButton = event.target.closest("[data-admin-page]");
    if (adminPageButton) {
      const section = adminPageButton.dataset.adminPage;
      const delta = Number(adminPageButton.dataset.adminPageDelta || 0);
      adminPageButton.disabled = true;
      adminApp.changeAdminPage(section, delta).catch((error) => showToast(error.message, "error")).finally(() => { adminPageButton.disabled = false; });
      return;
    }
    const notificationRequeueButton = event.target.closest("[data-admin-notification-requeue]");
    if (notificationRequeueButton) {
      adminSystemPanel.requeueAdminNotification(notificationRequeueButton).catch((error) => showToast(error.message, "error"));
      return;
    }
    if (event.target.closest("[data-admin-category-focus]")) adminCatalogPanel.focusAdminCategoryForm();
    if (event.target.closest("[data-admin-category-cancel]")) adminCatalogPanel.resetAdminCategoryForm();
    const categoryEdit = event.target.closest("[data-admin-category-edit]");
    if (categoryEdit) adminCatalogPanel.editAdminCategory(categoryEdit.dataset.adminCategoryEdit);
    const accountEdit = event.target.closest("[data-account-edit]");
    if (accountEdit) adminSystemPanel.editAccount(accountEdit.dataset.accountEdit);
    if (event.target.closest("[data-account-cancel]")) adminSystemPanel.resetAccountForm();
    if (event.target.closest("[data-coupon-reset]")) adminMembersPanel.resetCouponForm();
    const couponEdit = event.target.closest("[data-coupon-edit]");
    if (couponEdit) adminMembersPanel.editCoupon(couponEdit.dataset.couponEdit);
  });
  document.addEventListener("error", adminProductImage.handleAdminProductImageError, true);
}

function bindAdminChangeDelegation() {
  document.addEventListener("change", (event) => {
    if (event.target.matches("#admin-order-status-filter")) adminApp.reloadAdminList("orders", true);
    if (event.target.matches("#admin-product-status")) adminApp.reloadAdminList("products", true);
    if (event.target.matches("#admin-audit-resource, #admin-audit-action")) adminApp.reloadAdminList("audit", true);
    if (event.target.matches("#admin-notification-channel, #admin-notification-status")) adminApp.reloadAdminList("notifications", true);
    if (event.target.matches("#point-max-mode")) adminMembersPanel.syncPointMaxHint();
    if (event.target.matches("#admin-kind")) adminCatalogPanel.syncDepositField(event.target, document.querySelector("#admin-deposit-rate"));
    if (event.target.matches("#admin-new-kind")) adminCatalogPanel.syncDepositField(event.target, document.querySelector("#admin-new-deposit-rate"));
    if (event.target.matches("[data-edit-variant-form] select[name='kind']")) adminCatalogPanel.syncDepositField(event.target, event.target.form.elements.deposit_rate);
  });
}

function bindAdminInputDelegation() {
  document.addEventListener("input", (event) => {
    if (event.target.matches("#admin-order-search")) adminApp.reloadAdminList("orders");
    if (event.target.matches("#admin-member-search")) adminApp.reloadAdminList("members");
    if (event.target.matches("#admin-product-search")) adminApp.reloadAdminList("products");
  });
}

function bindAdminSubmitDelegation() {
  document.addEventListener("submit", async (event) => {
    if (event.target.matches("#admin-coupon-form")) {
      try { await adminMembersPanel.submitCoupon(event); } catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (event.target.matches("#birthday-coupon-form")) {
      try { await adminMembersPanel.submitBirthdaySettings(event); } catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (event.target.matches("[data-admin-points-form]")) {
      try { await adminMembersPanel.submitMemberPointAdjustment(event); }
      catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (event.target.matches("[data-admin-order-form]")) {
      try { await adminOrdersPanel.submitAdminOrderTransition(event); }
      catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (event.target.matches("[data-admin-return-form]")) {
      try { await adminOrdersPanel.submitAdminOrderReturn(event); }
      catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (event.target.matches("[data-admin-fulfillment-form]")) {
      try { await adminOrdersPanel.submitAdminOrderFulfillment(event); }
      catch (error) { showToast(error.message, "error"); }
      return;
    }
    if (!event.target.matches("[data-edit-product-form], [data-edit-variant-form]")) return;
    try { await adminCatalogPanel.submitDynamicAdminForm(event); }
    catch (error) { showToast(error.message, "error"); }
  });
}

function bindAdminDirectFormListeners() {
  document.querySelector("#admin-account-form").addEventListener("submit", async (event) => { try { await adminSystemPanel.submitAdminAccount(event); } catch (error) { showToast(error.message, "error"); } });
  document.querySelector("#admin-category-form").addEventListener("submit", async (event) => { try { await adminCatalogPanel.submitAdminCategory(event); } catch (error) { showToast(error.message, "error"); } });
  document.querySelector("#admin-product-form").addEventListener("submit", async (event) => { try { await adminCatalogPanel.submitAdminProduct(event); } catch (error) { showToast(error.message, "error"); } });
  document.querySelector("#admin-variant-form").addEventListener("submit", async (event) => { try { await adminCatalogPanel.submitNewVariant(event); } catch (error) { showToast(error.message, "error"); } });
  document.querySelector("#admin-inventory-form").addEventListener("submit", async (event) => { try { await adminCatalogPanel.submitInventoryAdjustment(event); } catch (error) { showToast(error.message, "error"); } });
  document.querySelector("#admin-point-settings-form").addEventListener("submit", async (event) => { try { await adminMembersPanel.submitPointSettings(event); } catch (error) { showToast(error.message, "error"); } });
}

function initAdminModules() {
  adminProductGallery.initAdminProductGallery({
    adminFetch: adminApp.adminFetch,
    prepareProductImage: adminProductImage.prepareProductImage,
    showToast,
    getProduct: (id) => (adminApp.adminData?.products || []).find((product) => product.id === id),
    fallbackMarkup: adminProductImage.adminProductImageFallbackMarkup
  });
  adminProductsTable.initAdminProductsTable({
    getProducts: () => adminApp.adminData?.products || [],
    adminFetch: adminApp.adminFetch,
    showToast,
    adminCategoryOptions: adminCatalogPanel.adminCategoryOptions,
    splitPreorderArrival: adminCatalogPanel.splitPreorderArrival,
    fallbackMarkup: adminProductImage.adminProductImageFallbackMarkup,
    onCatalogChanged: adminApp.invalidateAdminManagementOptions
  });
  adminShellModule.initAdminShell({
    getStats: () => (adminApp.adminData?.stats && Object.keys(adminApp.adminData.stats).length ? adminApp.adminData.stats : null),
    getOverview: () => adminApp.adminData?.overview || null,
    switchAdminTab: adminApp.switchAdminTab,
    reloadAdminList: adminApp.reloadAdminList,
    loadAdminSection: adminApp.loadAdminSection,
    adminFetch: adminApp.adminFetch,
    formatDateTime,
    orderStatusLabel: (order) => adminOrderStatusLabel(order)
  });
}

function wireAdmin() {
  bindAdminClickDelegation();
  bindAdminChangeDelegation();
  bindAdminInputDelegation();
  bindAdminSubmitDelegation();
  bindAdminDirectFormListeners();
  initAdminModules();
}

// 開啟一次即快取的載入承諾：CSS 啟用與模組 import 平行進行，失敗的 CSS 不阻擋後台開啟。
export function loadAdmin() {
  if (!loadPromise) {
    loadPromise = Promise.all([activateAdminStylesheets(), importAdminModules()]).then(() => {
      wireAdmin();
    }).catch((error) => {
      loadPromise = null; // 失敗時允許下次重新嘗試
      throw error;
    });
  }
  return loadPromise;
}

// app.js 呼叫入口：載入完成才開啟後台；失敗改用 toast 提示，不靜默失敗。
export async function openAdminLazy() {
  try {
    await loadAdmin();
  } catch (error) {
    console.error("Admin bundle failed to load.", error);
    showToast("管理後台載入失敗，請重新整理再試一次", "error");
    return;
  }
  adminApp.openAdmin();
}
