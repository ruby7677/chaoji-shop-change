// 後台商品管理：分類、商品與規格表單、管理選單、庫存異動與低庫存、預購到貨日期。
import { escapeHtml } from "./product-format.js";
import { renderAdminProductsTable } from "./admin-products-table.js";
import { formatDateTime, showToast } from "./app-core.js";
import { products } from "./storefront-catalog.js";
import { adminData, adminFetch, invalidateAdminManagementOptions, refreshAdminSections, relationOne, switchAdminTab } from "./admin-app.js";
import { renderAdminDiscountOptionBoxes } from "./admin-members-panel.js";
import { prepareProductImage, uploadAdminProductImage, validateProductImage } from "./admin-product-image.js";
import { movementMatches } from "./admin-stock-math.js";

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

// 焦點交給面板處理（admin-sheets.js）：桌機聚焦分類名稱，觸控裝置聚焦標題，不會一開就彈出鍵盤
export function openAdminCategoryForm() {
  const details = document.querySelector("#admin-category-management");
  if (details instanceof HTMLDetailsElement) details.open = true;
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

export function renderAdminCategories() {
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

export function renderAdminSelects({ preserveSelection = false } = {}) {
  const products = adminData.productOptions || adminData.products || [];
  const productOptions = products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
  const productSelect = document.querySelector("#admin-variant-product");
  const selectedProduct = preserveSelection ? productSelect?.value : "";
  if (productSelect) {
    productSelect.innerHTML = productOptions || '<option value="">請先建立商品</option>';
    if (selectedProduct && [...productSelect.options].some((option) => option.value === selectedProduct)) productSelect.value = selectedProduct;
  }
  // data-sku 供庫存異動頁的搜尋框比對，不顯示在選項文字內
  const variantOptions = products.flatMap((product) => (product.product_variants || []).map((variant) => `<option value="${variant.id}" data-sku="${escapeHtml(variant.sku || "")}">${escapeHtml(product.name)} · ${escapeHtml(variant.name)}（庫存 ${variant.stock_on_hand}）</option>`)).join("");
  const variantSelect = document.querySelector("#admin-inventory-variant");
  const selectedVariant = preserveSelection ? variantSelect?.value : "";
  if (variantSelect) {
    variantSelect.innerHTML = variantOptions || '<option value="">目前沒有商品規格</option>';
    if (selectedVariant && [...variantSelect.options].some((option) => option.value === selectedVariant)) variantSelect.value = selectedVariant;
    filterAdminInventoryOptions(document.querySelector("#admin-inventory-search")?.value || "");
  }
}

// 庫存異動頁的搜尋框：依商品、規格或 SKU 過濾既有 <select> 的選項（renderAdminSelects 產生），不改變 select 本身的載入邏輯
export function filterAdminInventoryOptions(keyword) {
  const select = document.querySelector("#admin-inventory-variant");
  if (!(select instanceof HTMLSelectElement)) return;
  const kw = String(keyword || "").trim().toLowerCase();
  [...select.options].forEach((option) => {
    if (!option.value) { option.hidden = false; return; }
    const haystack = `${option.textContent} ${option.dataset.sku || ""}`.toLowerCase();
    option.hidden = Boolean(kw) && !haystack.includes(kw);
  });
}

export function refreshAdminManagementOptionControls() {
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
export function renderAdminProducts() {
  ensureAdminPointsEligibilityUI();
  ensureAdminPricingUI();
  renderAdminProductsTable();
}

// 篩選只作用在目前這頁已載入的異動紀錄，不觸發重新分頁載入
let adminMovementFilterKeyword = "";

export function setAdminMovementFilter(keyword) {
  adminMovementFilterKeyword = String(keyword || "");
  renderAdminMovements();
}

export function renderAdminMovements() {
  const container = document.querySelector("#admin-movement-list");
  const rows = (adminData.movements || []).map((movement) => {
    const variant = relationOne(movement.product_variants);
    const product = relationOne(variant?.products);
    return { movement, variant, product };
  }).filter(({ movement, variant, product }) => movementMatches(movement, adminMovementFilterKeyword, product?.name, `${variant?.name || ""} ${variant?.sku || ""}`));
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">${adminMovementFilterKeyword ? "沒有符合篩選條件的異動紀錄。" : "目前沒有庫存異動紀錄。"}</div>`;
    return;
  }
  container.innerHTML = rows.map(({ movement, variant, product }) => {
    const positive = movement.quantity_delta > 0;
    return `<div class="admin-card"><div><strong>${escapeHtml(product?.name || "商品")} · ${escapeHtml(variant?.name || variant?.sku || "規格")}</strong><small>${escapeHtml(movement.reason)} · ${formatDateTime(movement.created_at)}</small></div><strong class="${positive ? "movement-positive" : "movement-negative"}">${positive ? "+" : ""}${movement.quantity_delta}</strong></div>`;
  }).join("");
}

function ensureAdminLowStockUI() {
  const panel = document.querySelector("[data-admin-panel='inventory']");
  const heading = panel?.querySelector("h3");
  if (heading && !document.querySelector("#admin-low-stock-list")) heading.insertAdjacentHTML("beforebegin", '<section class="admin-low-stock" aria-labelledby="admin-low-stock-title"><div class="admin-low-stock-head"><h3 id="admin-low-stock-title">低庫存規格</h3><span id="admin-low-stock-count">0</span></div><div id="admin-low-stock-list"></div></section>');
}

export function renderAdminLowStock() {
  ensureAdminLowStockUI();
  const list = document.querySelector("#admin-low-stock-list");
  const count = document.querySelector("#admin-low-stock-count");
  if (!list) return;
  const lowStock = (adminData.productOptions || adminData.managementOptions?.products || []).flatMap((product) => (product.product_variants || []).filter((variant) => Number(variant.stock_on_hand) <= Number(variant.safety_stock)).map((variant) => ({ product, variant })));
  if (count) count.textContent = `${lowStock.length} 項`;
  list.innerHTML = lowStock.length ? lowStock.map(({ product, variant }) => `<div class="admin-low-stock-row"><div><strong>${escapeHtml(product.name)} · ${escapeHtml(variant.name)}</strong><small>安全庫存 ${variant.safety_stock}</small></div><span>${variant.stock_on_hand}</span><button class="secondary-button" type="button" data-admin-low-stock-variant="${escapeHtml(variant.id)}">調整庫存</button></div>`).join("") : '<p class="admin-low-stock-empty">目前沒有低於安全庫存的規格。</p>';
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
    await uploadAdminProductImage(result.ids.product_id, preparedImage?.file, preparedImage?.thumbnailFile);
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
    kind,
    price: Number(document.querySelector("#admin-new-price").value),
    compare_at_price: document.querySelector("#admin-new-compare-at-price")?.value ? Number(document.querySelector("#admin-new-compare-at-price").value) : null,
    safety_stock: Number(document.querySelector("#admin-new-safety-stock").value || 0),
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-new-deposit-rate").value || 0) / 100,
    preorder_arrival: preorderArrivalValue(document.querySelector("#admin-new-arrival-from").value, document.querySelector("#admin-new-arrival-until").value),
    seller_link: document.querySelector("#admin-new-seller-link").value,
    is_published: document.querySelector("#admin-new-published").checked
  };
  await adminFetch("/api/admin/variants", { method: "POST", body: JSON.stringify(body) });
  invalidateAdminManagementOptions();
  event.currentTarget.reset();
  document.querySelector("#admin-new-safety-stock").value = "0";
  const newCompareAtPriceInput = document.querySelector("#admin-new-compare-at-price");
  if (newCompareAtPriceInput) newCompareAtPriceInput.value = "";
  document.querySelector("#admin-new-deposit-rate").value = "0";
  await refreshAdminSections(["products", "inventory", "overview"]);
  switchAdminTab("products");
  showToast("商品規格已新增", "success");
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
      if (preparedImage) await uploadAdminProductImage(productId, preparedImage.file, preparedImage.thumbnailFile);
      event.target.dataset.imageFallback = preparedImage && !preparedImage.converted ? "true" : "false";
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  } else {
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "儲存中…"; }
    try {
      const kind = formData.get("kind");
      const compareAtPrice = String(formData.get("compare_at_price") || "").trim();
      await adminFetch(`/api/admin/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), kind, price: Number(formData.get("price")), compare_at_price: compareAtPrice ? Number(compareAtPrice) : null, safety_stock: Number(formData.get("safety_stock") || 0), deposit_rate: kind === "preorder" ? 0.5 : Number(formData.get("deposit_rate") || 0) / 100, preorder_arrival: preorderArrivalValue(formData.get("preorder_arrival_from"), formData.get("preorder_arrival_until"), formData.get("preorder_arrival_raw")), display_order: Number(formData.get("display_order") || 0), seller_link: formData.get("seller_link"), is_published: formData.get("is_published") === "on" }) });
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
