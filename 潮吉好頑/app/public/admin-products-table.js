// 商品與規格頁（ADMIN_REDESIGN_PLAN Stage 8）：一列一個規格的表格、篩選、上架開關（先確認）、優惠價與編輯滑出面板。
// 資料沿用 app.js 的 adminData.products；搜尋仍以 #admin-product-search 走伺服器查詢，分類／類型／狀態在本頁篩選。
// 儲存：表單由 submitDynamicAdminForm 處理；上架開關以同一個 PATCH /api/admin/variants/:id 送出完整欄位，成功後只更新該列。
import { escapeHtml } from "./product-format.js";
import { adminIcon } from "./admin-icons.js";
import { createAdminSheet, openAdminSheetFor } from "./admin-sheets.js";
import { adminConfirm } from "./admin-confirm.js";
import { discountPercent, editSheetMarkup, kindPill, priceFormMarkup, pricePreviewText, priceMarkup, relationOne } from "./admin-products-forms.js";

const PRICE_SHEET_AUTO_CLOSE_MS = 15000;
const view = { cat: "all", kind: "all", status: "all" };
let deps = null;
let list = null;
let editSheet = null;
let priceSheet = null;
let editingProductId = null;
let priceSubmittedAt = 0;

const helpers = () => ({ adminCategoryOptions: deps.adminCategoryOptions, splitPreorderArrival: deps.splitPreorderArrival });
const productOf = (productId) => deps.getProducts().find((product) => product.id === productId) || null;

function findVariant(variantId) {
  for (const product of deps.getProducts()) {
    const variant = (product.product_variants || []).find((item) => item.id === variantId);
    if (variant) return { product, variant };
  }
  return null;
}

const categoryName = (product) => relationOne(product.categories)?.name || "未分類";
const isOnSale = (variant) => discountPercent(variant) > 0;
const STATUS_FILTER = {
  all: () => true,
  published: (product, variant) => product.is_published && variant.is_published,
  unpublished: (product, variant) => !(product.is_published && variant.is_published),
  sale: (product, variant) => isOnSale(variant)
};

function ensureToolbar() {
  if (document.querySelector("[data-products-toolbar]")) return;
  list.insertAdjacentHTML("beforebegin", `<div class="admin-products-toolbar" data-products-toolbar>`
    + '<label class="admin-products-search"><span class="sr-only">搜尋商品</span><input id="admin-product-search" type="search" placeholder="商品名稱、分類、規格或 SKU" /></label>'
    + '<select data-products-filter="cat" aria-label="分類"></select>'
    + '<select data-products-filter="kind" aria-label="類型"><option value="all">現貨＋預購</option><option value="in_stock">現貨</option><option value="preorder">預購</option></select>'
    + '<select data-products-filter="status" aria-label="上架狀態"><option value="all">全部狀態</option><option value="published">已上架</option><option value="unpublished">未上架</option><option value="sale">限時優惠中</option></select>'
    + `<button class="admin-products-new" type="button" data-products-new aria-label="新增商品">${adminIcon("plus")}<span>新增商品</span></button>`
    + '</div><p class="admin-products-count" data-products-count role="status" aria-live="polite"></p>');
}

function syncCategoryFilter(products) {
  const select = document.querySelector('[data-products-filter="cat"]');
  const names = [...new Set(products.map(categoryName))];
  if (view.cat !== "all" && !names.includes(view.cat)) view.cat = "all";
  select.innerHTML = `<option value="all">全部分類</option>${names.map((name) => `<option value="${escapeHtml(name)}" ${name === view.cat ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}`;
}

function thumbMarkup(product) {
  const src = product.image_path ? `/api/product-images/${product.id}?v=${encodeURIComponent(product.image_updated_at || "1")}` : "";
  return `<span class="admin-product-thumbnail admin-row-thumb">${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" />` : deps.fallbackMarkup()}</span>`;
}

function productCellMarkup(product) {
  const tags = `${product.is_published ? "" : '<span class="admin-pill gray">商品未上架</span>'}${product.points_eligible === false ? '<span class="admin-pill amber">不積點</span>' : ""}`;
  return `<td class="lead-cell"><span class="admin-prod-cell">${thumbMarkup(product)}<span><span class="cell-main">${escapeHtml(product.name)}</span>`
    + `<span class="cell-sub">${escapeHtml(categoryName(product))}・排序 ${product.display_order}</span>${tags ? `<span class="cell-tags">${tags}</span>` : ""}</span></span></td>`;
}

function rowMarkup(product, variant, maxStock) {
  const label = `${product.name}／${variant.name}`;
  const sale = discountPercent(variant);
  const low = variant.stock_on_hand <= variant.safety_stock;
  const percent = maxStock ? Math.round((Math.max(0, variant.stock_on_hand) / maxStock) * 100) : 0;
  const deposit = variant.kind !== "preorder" && Number(variant.deposit_rate) > 0 ? `<span class="cell-sub">訂金 ${Math.round(Number(variant.deposit_rate) * 100)}%</span>` : (variant.kind === "preorder" ? '<span class="cell-sub">訂金 50%</span>' : "");
  return `<tr data-variant-row="${escapeHtml(variant.id)}">${productCellMarkup(product)}`
    + `<td data-l="規格">${escapeHtml(variant.name)}<span class="cell-sub mono">SKU ${escapeHtml(variant.sku)}</span></td>`
    + `<td data-l="類型">${kindPill(variant.kind)}</td>`
    + `<td class="num" data-l="售價"><span class="admin-price-cell">${priceMarkup(variant)}${sale ? `<span class="admin-pill danger">限時優惠 −${sale}%</span>` : ""}${deposit}</span></td>`
    + `<td data-l="庫存"><span class="admin-stock-cell"><span class="admin-stockbar${low ? " low" : ""}"><i data-stock-pct="${percent}"></i></span><span class="cell-sub">庫存 ${variant.stock_on_hand}・安全 ${variant.safety_stock}${low ? "・偏低" : ""}</span></span></td>`
    + `<td data-l="限購">${product.purchase_limit ?? "不限"}</td>`
    + `<td data-l="上架"><button class="admin-switch" type="button" role="switch" aria-checked="${variant.is_published ? "true" : "false"}" aria-label="${escapeHtml(label)} 上架" data-variant-publish="${escapeHtml(variant.id)}"></button></td>`
    + `<td data-l="操作"><span class="admin-row-actions"><button class="admin-row-button${sale ? " is-sale" : ""}" type="button" data-variant-price="${escapeHtml(variant.id)}" aria-label="設定「${escapeHtml(label)}」的優惠價">${adminIcon("tag")}<span>優惠價</span></button>`
    + `<button class="admin-row-button" type="button" data-product-edit="${escapeHtml(product.id)}" aria-label="編輯「${escapeHtml(product.name)}」">${adminIcon("edit")}<span>編輯</span></button></span></td></tr>`;
}

function emptyProductRow(product) {
  return `<tr>${productCellMarkup(product)}<td data-l="規格" colspan="6"><span class="cell-sub">此商品尚無規格</span></td>`
    + `<td data-l="操作"><span class="admin-row-actions"><button class="admin-row-button" type="button" data-product-edit="${escapeHtml(product.id)}" aria-label="編輯「${escapeHtml(product.name)}」">${adminIcon("edit")}<span>編輯</span></button></span></td></tr>`;
}

function drawTable() {
  const products = deps.getProducts();
  syncCategoryFilter(products);
  const rows = [];
  products.forEach((product) => {
    if (view.cat !== "all" && categoryName(product) !== view.cat) return;
    const variants = [...(product.product_variants || [])].sort((a, b) => a.display_order - b.display_order);
    if (!variants.length) {
      if (view.kind === "all" && view.status === "all") rows.push({ product, variant: null });
      return;
    }
    variants.filter((variant) => (view.kind === "all" || variant.kind === view.kind) && STATUS_FILTER[view.status](product, variant))
      .forEach((variant) => rows.push({ product, variant }));
  });
  const maxStock = Math.max(0, ...rows.map(({ variant }) => Number(variant?.stock_on_hand || 0)));
  const saleCount = products.reduce((sum, product) => sum + (product.product_variants || []).filter(isOnSale).length, 0);
  document.querySelector("[data-products-count]").textContent = `本頁 ${products.length} 件商品・顯示 ${rows.filter((row) => row.variant).length} 個規格・限時優惠 ${saleCount} 個`;
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">目前沒有符合條件的商品。</div>';
    return;
  }
  list.innerHTML = '<div class="admin-table-wrap"><table class="admin-stack-table"><thead><tr><th>商品</th><th>規格</th><th>類型</th><th class="num">售價</th><th>庫存</th><th>限購</th><th>上架</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>'
    + rows.map(({ product, variant }) => (variant ? rowMarkup(product, variant, maxStock) : emptyProductRow(product))).join("")
    + "</tbody></table></div>";
  // CSP 不允許 style 屬性：庫存條寬度以 CSSOM 設定
  list.querySelectorAll("[data-stock-pct]").forEach((bar) => bar.style.setProperty("width", `${bar.dataset.stockPct}%`));
}

// ---------- 滑出面板 ----------
function panelHost() {
  return document.querySelector('[data-admin-panel="products"]');
}

function renderEditSheet(product, keepState) {
  const openVariants = keepState ? new Set([...editSheet.body.querySelectorAll("details[data-edit-variant][open]")].map((node) => node.dataset.editVariant)) : new Set();
  const scrollTop = keepState ? editSheet.body.scrollTop : 0;
  editSheet.setTitle(`編輯商品｜${product.name}`);
  editSheet.body.innerHTML = editSheetMarkup(product, helpers(), openVariants);
  editSheet.body.scrollTop = scrollTop;
}

function openEditSheet(productId, trigger) {
  const product = productOf(productId);
  if (!product) return deps.showToast("找不到這件商品，請重新整理後再試", "error");
  editSheet ||= createAdminSheet(panelHost(), "編輯商品");
  editingProductId = productId;
  renderEditSheet(product, false);
  editSheet.open(trigger);
}

function syncPricePreview(form) {
  const preview = form.querySelector("[data-price-preview]");
  if (preview) preview.textContent = pricePreviewText(form.elements.price.value, form.elements.compare_at_price.value);
}

function openPriceSheet(variantId, trigger) {
  const found = findVariant(variantId);
  if (!found) return deps.showToast("找不到這個規格，請重新整理後再試", "error");
  priceSheet ||= createAdminSheet(panelHost(), "優惠價");
  priceSheet.setTitle(`優惠價｜${found.product.name}`);
  priceSheet.body.innerHTML = priceFormMarkup(found.product, found.variant, helpers());
  syncPricePreview(priceSheet.body.querySelector("[data-price-form]"));
  priceSheet.open(trigger);
}

// 商品資料重新載入後：編輯面板改用最新資料並保持展開狀態；優惠價送出成功後自動關閉
function syncSheetsAfterRender() {
  if (editSheet?.details.open && editingProductId) {
    const product = productOf(editingProductId);
    if (product) renderEditSheet(product, true);
    else editSheet.close();
  }
  if (priceSheet?.details.open && priceSubmittedAt && Date.now() - priceSubmittedAt < PRICE_SHEET_AUTO_CLOSE_MS) priceSheet.close();
  priceSubmittedAt = 0;
}

// ---------- 上架開關：先確認再送出 ----------
function variantPayload(variant, isPublished) {
  // 與規格表單送出內容相同（submitDynamicAdminForm），只改上架狀態
  return {
    name: variant.name,
    sku: variant.sku,
    kind: variant.kind,
    price: Number(variant.price),
    compare_at_price: variant.compare_at_price == null || variant.compare_at_price === "" ? null : Number(variant.compare_at_price),
    safety_stock: Number(variant.safety_stock),
    deposit_rate: variant.kind === "preorder" ? 0.5 : Number(variant.deposit_rate || 0),
    preorder_arrival: String(variant.preorder_arrival || "").trim() || null,
    display_order: Number(variant.display_order || 0),
    seller_link: variant.seller_link || "",
    is_published: isPublished
  };
}

async function togglePublish(button) {
  const found = findVariant(button.dataset.variantPublish);
  if (!found || button.disabled) return;
  const { product, variant } = found;
  const next = !variant.is_published;
  const label = `${product.name}／${variant.name}`;
  const message = !next
    ? "下架後前台不再顯示此規格，顧客無法再加入購物車。"
    : product.is_published
      ? "上架後前台會顯示此規格，顧客可加入購物車。"
      : "此規格會設為上架，但商品目前未上架，前台仍不會顯示；需在「編輯」中勾選「上架商品」。";
  const confirmed = await adminConfirm({ title: `${next ? "上架" : "下架"}「${label}」？`, message, confirmLabel: next ? "確定上架" : "確定下架", danger: !next, trigger: button });
  if (!confirmed) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    const result = await deps.adminFetch(`/api/admin/variants/${variant.id}`, { method: "PATCH", body: JSON.stringify(variantPayload(variant, next)) });
    const saved = result?.variant && !Array.isArray(result.variant) ? result.variant : null;
    variant.is_published = typeof saved?.is_published === "boolean" ? saved.is_published : next;
    if (saved?.updated_at) variant.updated_at = saved.updated_at;
    deps.onCatalogChanged();
    drawTable();
    // 表格重繪後按鈕已換新，焦點移回同一規格的開關
    list.querySelector(`[data-variant-publish="${CSS.escape(variant.id)}"]`)?.focus({ preventScroll: true });
    deps.showToast(variant.is_published ? `已上架：${label}` : `已下架：${label}（前台隱藏）`, "success");
  } catch (error) {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    deps.showToast(error.message || "上架狀態更新失敗，請稍後再試", "error");
  }
}

function openVariantCreator(productId, trigger) {
  const select = document.querySelector("#admin-variant-product");
  if (select) select.value = productId;
  openAdminSheetFor(document.querySelector("#admin-variant-form"), trigger);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("#admin-dialog")) return;
    const publish = target.closest("[data-variant-publish]");
    if (publish) return void togglePublish(publish);
    const price = target.closest("[data-variant-price]");
    if (price) return openPriceSheet(price.dataset.variantPrice, price);
    const edit = target.closest("[data-product-edit]");
    if (edit) return openEditSheet(edit.dataset.productEdit, edit);
    const addVariant = target.closest("[data-products-add-variant]");
    if (addVariant) return openVariantCreator(addVariant.dataset.productsAddVariant, null);
    const create = target.closest("[data-products-new]");
    if (create) openAdminSheetFor(document.querySelector("#admin-product-form"), create);
  });
  document.addEventListener("change", (event) => {
    const filter = event.target.closest?.("[data-products-filter]");
    if (!filter) return;
    view[filter.dataset.productsFilter] = filter.value;
    drawTable();
  });
  document.addEventListener("input", (event) => {
    const form = event.target.closest?.("[data-price-form]");
    if (form) syncPricePreview(form);
  });
  // 送出優惠價：記錄時間，重新載入後自動關閉面板（失敗不會重新載入，面板保留）
  document.addEventListener("submit", (event) => {
    if (event.target.matches?.("[data-price-form]")) priceSubmittedAt = Date.now();
  }, true);
}

// deps：getProducts、adminFetch、showToast、adminCategoryOptions、splitPreorderArrival、fallbackMarkup、onCatalogChanged
export function initAdminProductsTable(options) {
  if (deps) return;
  deps = options;
  list = document.querySelector("#admin-product-list");
  if (!list) throw new Error("找不到商品列表容器");
  bindEvents();
}

export function renderAdminProductsTable() {
  if (!deps) throw new Error("商品列表尚未初始化");
  ensureToolbar();
  drawTable();
  syncSheetsAfterRender();
}
