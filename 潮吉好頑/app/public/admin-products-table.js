// 商品與規格頁（ADMIN_REDESIGN_PLAN Stage 8）：一列一個規格的表格、篩選、上架開關（先確認）、優惠價與編輯滑出面板。
// 資料沿用 app.js 的 adminData.products；搜尋與分類／類型／狀態篩選都送到伺服器（篩完再分頁），
// 本頁再依同樣條件挑出要顯示的規格列。
// 儲存：表單由 submitDynamicAdminForm 處理；上架開關以同一個 PATCH /api/admin/variants/:id 送出完整欄位，成功後只更新該列。
import { escapeHtml } from "./product-format.js";
import { adminPrimaryImageSrc } from "./product-image-src.js";
import { adminIcon } from "./admin-icons.js";
import { createAdminSheet, openAdminSheetFor } from "./admin-sheets.js";
import { adminConfirm, adminConfirmChoice } from "./admin-confirm.js";
import { initVariantBatch, syncVariantBatch, variantSelectMarkup } from "./admin-variant-batch.js";
import { offerUndo } from "./admin-undo.js";
import { openStockAdjust } from "./admin-stock-adjust.js";
import { discountPercent, editSheetMarkup, kindPill, priceFormMarkup, pricePreviewText, priceMarkup, relationOne } from "./admin-products-forms.js";
import { snapshotFields, matchField, createFormStateStore } from "./admin-form-state.js";

const PRICE_SHEET_AUTO_CLOSE_MS = 15000;
// 編輯面板某個表單送出成功後，重新載入商品清單需要一點時間；這段時間內若編輯面板重新渲染，
// 視為「這個表單剛存過、已經是最新資料」，不把送出前的快照還原回去蓋掉（否則會把剛存的值又改回舊值）。
const EDIT_FORM_RESTORE_SKIP_MS = 15000;
const EDIT_TAB_KEYS = ["product", "media", "variants"];
const view = { cat: "all", kind: "all", status: "all", unpublishedOpen: false };
let deps = null;
let list = null;
let editSheet = null;
let priceSheet = null;
let editingProductId = null;
let priceSubmittedAt = 0;
// 編輯面板內各表單「剛送出成功」的時間，key 見 editFormKey()
const editFormSubmittedAt = new Map();

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
// 分類篩選值：all、none（未分類）或分類 id，與伺服器 admin_search_product_ids 的 p_category 相同
const matchesCategory = (product) => view.cat === "all" || (view.cat === "none" ? !product.category_id : product.category_id === view.cat);
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
    + '<label class="admin-products-search" hidden><span class="sr-only">搜尋商品</span><input id="admin-product-search" type="search" placeholder="商品名稱、分類或規格" /></label>'
    + '<select data-products-filter="cat" aria-label="分類"></select>'
    + '<select data-products-filter="kind" aria-label="類型"><option value="all">現貨＋預購</option><option value="in_stock">現貨</option><option value="preorder">預購</option></select>'
    + '<select data-products-filter="status" aria-label="上架狀態"><option value="all">全部狀態</option><option value="published">已上架</option><option value="unpublished">未上架</option><option value="sale">限時優惠中</option></select>'
    + `<button class="admin-icon-button admin-products-categories" type="button" data-products-sheet="#admin-category-form" aria-haspopup="dialog" aria-label="分類管理" title="分類管理">${adminIcon("folder")}</button><button class="admin-products-new" type="button" data-products-sheet="#admin-product-form" aria-haspopup="dialog" aria-label="新增商品">${adminIcon("plus")}<span>新增商品</span></button>`
    + '</div><p class="admin-products-count" data-products-count role="status" aria-live="polite"></p>');
}

// 選項列出全部分類（不只本頁出現的），篩選後的空頁也能切換到其他分類
function syncCategoryFilter() {
  const select = document.querySelector('[data-products-filter="cat"]');
  const categories = deps.getCategories();
  if (view.cat !== "all" && view.cat !== "none" && !categories.some((category) => category.id === view.cat)) view.cat = "all";
  const option = (value, label) => `<option value="${escapeHtml(value)}" ${value === view.cat ? "selected" : ""}>${escapeHtml(label)}</option>`;
  select.innerHTML = option("all", "全部分類") + categories.map((category) => option(category.id, category.is_active === false ? `${category.name}（已停用）` : category.name)).join("") + option("none", "未分類");
}

function thumbMarkup(product) {
  const src = adminPrimaryImageSrc(product, { thumb: true });
  return `<span class="admin-product-thumbnail admin-row-thumb">${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" />` : deps.fallbackMarkup()}</span>`;
}

function productCellMarkup(product) {
  const tags = `${product.is_published ? "" : '<span class="admin-pill gray">商品未上架</span>'}${product.points_eligible === false ? '<span class="admin-pill amber">不積點</span>' : ""}`;
  return `<td class="lead-cell"><span class="admin-prod-cell">${thumbMarkup(product)}<span><span class="cell-main">${escapeHtml(product.name)}</span>`
    + `<span class="cell-sub">${escapeHtml(categoryName(product))}</span>${tags ? `<span class="cell-tags">${tags}</span>` : ""}</span></span></td>`;
}

function rowMarkup(product, variant, maxStock) {
  const label = `${product.name}／${variant.name}`;
  const sale = discountPercent(variant);
  const low = variant.stock_on_hand <= variant.safety_stock;
  const percent = maxStock ? Math.round((Math.max(0, variant.stock_on_hand) / maxStock) * 100) : 0;
  const deposit = variant.kind !== "preorder" && Number(variant.deposit_rate) > 0 ? `<span class="cell-sub">訂金 ${Math.round(Number(variant.deposit_rate) * 100)}%</span>` : (variant.kind === "preorder" ? '<span class="cell-sub">訂金 50%</span>' : "");
  return `<tr data-variant-row="${escapeHtml(variant.id)}">${productCellMarkup(product)}`
    + `<td data-l="規格">${variantSelectMarkup(product, variant, escapeHtml)}${escapeHtml(variant.name)}</td>`
    + `<td data-l="類型">${kindPill(variant.kind)}</td>`
    + `<td class="num" data-l="售價"><span class="admin-price-cell">${priceMarkup(variant)}${sale ? `<span class="admin-pill danger">限時優惠 −${sale}%</span>` : ""}${deposit}</span></td>`
    + `<td data-l="庫存"><span class="admin-stock-cell"><span class="admin-stockbar${low ? " low" : ""}"><i data-stock-pct="${percent}"></i></span><span class="cell-sub">庫存 ${variant.stock_on_hand}・安全 ${variant.safety_stock}${low ? "・偏低" : ""}</span></span></td>`
    + `<td data-l="限購">${product.purchase_limit ?? "不限"}</td>`
    + `<td data-l="上架"><button class="admin-switch" type="button" role="switch" aria-checked="${variant.is_published ? "true" : "false"}" aria-label="${escapeHtml(label)} 上架" data-variant-publish="${escapeHtml(variant.id)}"></button></td>`
    + `<td data-l="操作"><span class="admin-row-actions"><button class="admin-row-button${sale ? " is-sale" : ""}" type="button" data-variant-price="${escapeHtml(variant.id)}" aria-label="設定「${escapeHtml(label)}」的優惠價">${adminIcon("tag")}<span>優惠價</span></button>`
    + `<button class="admin-row-button" type="button" data-stock-adjust="${escapeHtml(variant.id)}" aria-label="調整「${escapeHtml(label)}」的庫存">${adminIcon("box")}<span>調整庫存</span></button>`
    + `<button class="admin-row-button" type="button" data-product-edit="${escapeHtml(product.id)}" aria-label="編輯「${escapeHtml(product.name)}」">${adminIcon("edit")}<span>編輯</span></button></span></td></tr>`;
}

function emptyProductRow(product) {
  return `<tr>${productCellMarkup(product)}<td data-l="規格" colspan="6"><span class="cell-sub">此商品尚無規格</span></td>`
    + `<td data-l="操作"><span class="admin-row-actions"><button class="admin-row-button" type="button" data-product-edit="${escapeHtml(product.id)}" aria-label="編輯「${escapeHtml(product.name)}」">${adminIcon("edit")}<span>編輯</span></button></span></td></tr>`;
}

const TABLE_HEAD = '<thead><tr><th>商品</th><th>規格</th><th>類型</th><th class="num">售價</th><th>庫存</th><th>限購</th><th>上架</th><th><span class="sr-only">操作</span></th></tr></thead>';
const isRowUnpublished = ({ product, variant }) => !product.is_published || (variant && !variant.is_published);

function tableMarkup(rows, maxStock) {
  return `<div class="admin-table-wrap"><table class="admin-stack-table">${TABLE_HEAD}<tbody>`
    + rows.map(({ product, variant }) => (variant ? rowMarkup(product, variant, maxStock) : emptyProductRow(product))).join("")
    + "</tbody></table></div>";
}

// 最下方「已下架」區塊：商品或規格任一未上架的列都收在這裡，預設收合；篩選只看未上架時主列表為空，自動展開
function unpublishedSectionMarkup(rows, maxStock, open) {
  return `<section class="admin-unpublished${open ? " is-open" : ""}" data-unpublished-section aria-labelledby="admin-unpublished-title">`
    + `<div class="admin-unpublished-head"><h3 id="admin-unpublished-title">已下架 <span class="admin-pill gray">${rows.length}</span></h3>`
    + `<button class="admin-unpublished-toggle" type="button" data-unpublished-toggle aria-expanded="${open}" aria-controls="admin-unpublished-body">`
    + `<span data-unpublished-toggle-label>${open ? "收合" : "展開"}</span>${adminIcon("chevron")}</button></div>`
    + `<div id="admin-unpublished-body" class="admin-unpublished-body" ${open ? "" : "hidden"}>${tableMarkup(rows, maxStock)}</div></section>`;
}

function drawTable() {
  const products = deps.getProducts();
  syncCategoryFilter();
  const rows = [];
  products.forEach((product) => {
    if (!matchesCategory(product)) return;
    const variants = [...(product.product_variants || [])].sort((a, b) => b.display_order - a.display_order);
    if (!variants.length) {
      if (view.kind === "all" && view.status === "all") rows.push({ product, variant: null });
      return;
    }
    variants.filter((variant) => (view.kind === "all" || variant.kind === view.kind) && STATUS_FILTER[view.status](product, variant))
      .forEach((variant) => rows.push({ product, variant }));
  });
  const maxStock = Math.max(0, ...rows.map(({ variant }) => Number(variant?.stock_on_hand || 0)));
  const saleCount = products.reduce((sum, product) => sum + (product.product_variants || []).filter(isOnSale).length, 0);
  document.querySelector("[data-products-count]").textContent = `本頁 ${products.length} 件商品・${rows.filter((row) => row.variant).length} 個規格${saleCount ? `・限時優惠 ${saleCount} 個` : ""}`;
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">目前沒有符合條件的商品。</div>';
    syncVariantBatch();
    return;
  }
  const activeRows = rows.filter((row) => !isRowUnpublished(row));
  const unpublishedRows = rows.filter(isRowUnpublished);
  list.innerHTML = (activeRows.length ? tableMarkup(activeRows, maxStock) : '<div class="empty-state">目前沒有上架中的商品。</div>')
    + (unpublishedRows.length ? unpublishedSectionMarkup(unpublishedRows, maxStock, view.unpublishedOpen || !activeRows.length) : "");
  // CSP 不允許 style 屬性：庫存條寬度以 CSSOM 設定
  list.querySelectorAll("[data-stock-pct]").forEach((bar) => bar.style.setProperty("width", `${bar.dataset.stockPct}%`));
  syncVariantBatch();
}

function toggleUnpublished(button) {
  const section = button.closest("[data-unpublished-section]");
  const open = button.getAttribute("aria-expanded") !== "true";
  view.unpublishedOpen = open;
  button.setAttribute("aria-expanded", String(open));
  button.querySelector("[data-unpublished-toggle-label]").textContent = open ? "收合" : "展開";
  section.classList.toggle("is-open", open);
  section.querySelector("#admin-unpublished-body").hidden = !open;
}

// ---------- 滑出面板 ----------
function panelHost() {
  return document.querySelector('[data-admin-panel="products"]');
}

// 表單身分 key：對應 admin-products-forms.js 產生的 data-edit-product-form／data-edit-variant-form／
// data-showcase-form；用來跨重新渲染比對「同一個表單」（還原快照、剛送出成功時排除還原）。
function editFormKey(form) {
  if (form.dataset.editProductForm) return `product:${form.dataset.editProductForm}`;
  if (form.dataset.editVariantForm) return `variant:${form.dataset.editVariantForm}`;
  if (form.dataset.showcaseForm) return `showcase:${form.dataset.showcaseForm}`;
  return null;
}

function editFormsIn(body) {
  return [...body.querySelectorAll("form[data-edit-product-form], form[data-edit-variant-form], form[data-showcase-form]")];
}

// 重新渲染前：把「已標記為未儲存」且不是剛送出成功的表單存進快照（DOM 讀取留在這裡，比對邏輯在 admin-form-state.js）
function snapshotDirtyEditForms() {
  const now = Date.now();
  const store = createFormStateStore();
  editFormsIn(editSheet.body).forEach((form) => {
    const key = editFormKey(form);
    if (!key || form.dataset.dirty !== "true") return;
    const submittedAt = editFormSubmittedAt.get(key);
    if (submittedAt && now - submittedAt < EDIT_FORM_RESTORE_SKIP_MS) { editFormSubmittedAt.delete(key); return; }
    store.save(key, snapshotFields([...form.elements]));
  });
  return store;
}

// 重新渲染後：把快照套回同一個表單（用 form key 對上），並重新標記為未儲存
function restoreEditFormSnapshots(store) {
  editFormsIn(editSheet.body).forEach((form) => {
    const key = editFormKey(form);
    const fields = key && store.take(key);
    if (!fields) return;
    [...form.elements].forEach((element) => {
      if (!element.name || element.type === "file") return;
      const match = matchField(fields, element);
      if (!match) return;
      if (element.type === "checkbox" || element.type === "radio") element.checked = match.checked;
      else element.value = match.value;
    });
    form.dataset.dirty = "true";
  });
}

// 分頁上顯示「有未儲存的修改」的小圓點：依目前有哪些分頁的面板內含未儲存表單決定
function updateEditTabDots() {
  if (!editSheet) return;
  const body = editSheet.body;
  const dirtyTabs = new Set(editFormsIn(body)
    .filter((form) => form.dataset.dirty === "true")
    .map((form) => form.closest("[data-edit-panel]")?.dataset.editPanel)
    .filter(Boolean));
  body.querySelectorAll("[data-edit-tab]").forEach((tab) => {
    const dot = tab.querySelector("[data-edit-tab-dot]");
    if (dot) dot.hidden = !dirtyTabs.has(tab.dataset.editTab);
  });
}

function markEditFormDirty(target) {
  if (!editSheet || !(target instanceof Element)) return;
  const form = target.closest("form");
  if (!form || !editSheet.body.contains(form) || !editFormKey(form) || form.dataset.dirty === "true") return;
  form.dataset.dirty = "true";
  updateEditTabDots();
}

function clearEditFormDirty(form) {
  if (!(form instanceof HTMLFormElement) || form.dataset.dirty !== "true") return;
  delete form.dataset.dirty;
  updateEditTabDots();
}

// 切換編輯面板分頁：更新 tab 的 aria-selected／tabindex 與面板的 hidden（CSP 不允許 inline style，一律用屬性）
function activateEditTab(tabKey) {
  if (!editSheet || !EDIT_TAB_KEYS.includes(tabKey)) return;
  const body = editSheet.body;
  body.querySelectorAll("[data-edit-tab]").forEach((tab) => {
    const active = tab.dataset.editTab === tabKey;
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
  });
  body.querySelectorAll("[data-edit-panel]").forEach((panel) => { panel.hidden = panel.dataset.editPanel !== tabKey; });
  body.dataset.activeEditTab = tabKey;
}

// 使用者主動關閉編輯面板前（✕、點遮罩、Esc）：有未儲存的表單才詢問；建立面板時傳給 createAdminSheet 的 beforeClose
async function confirmCloseEditSheet() {
  if (!editSheet) return true;
  const dirty = editFormsIn(editSheet.body).some((form) => form.dataset.dirty === "true");
  if (!dirty) return true;
  return adminConfirm({ title: "有未儲存的修改，確定關閉？", message: "關閉後，尚未儲存的修改會遺失。", confirmLabel: "放棄修改並關閉", danger: true });
}

function renderEditSheet(product, keepState) {
  const openVariants = keepState ? new Set([...editSheet.body.querySelectorAll("details[data-edit-variant][open]")].map((node) => node.dataset.editVariant)) : new Set();
  const scrollTop = keepState ? editSheet.body.scrollTop : 0;
  const activeTab = keepState ? (editSheet.body.dataset.activeEditTab || "product") : "product";
  const snapshotStore = keepState ? snapshotDirtyEditForms() : null;
  editSheet.setTitle(`編輯商品｜${product.name}`);
  editSheet.body.innerHTML = editSheetMarkup(product, helpers(), openVariants, activeTab);
  editSheet.body.scrollTop = scrollTop;
  editSheet.body.dataset.activeEditTab = activeTab;
  if (snapshotStore) restoreEditFormSnapshots(snapshotStore);
  updateEditTabDots();
}

function openEditSheet(productId, trigger) {
  const product = productOf(productId);
  if (!product) return deps.showToast("找不到這件商品，請重新整理後再試", "error");
  editSheet ||= createAdminSheet(panelHost(), "編輯商品", { beforeClose: confirmCloseEditSheet });
  editingProductId = productId;
  editFormSubmittedAt.clear();
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

// 送出單一規格的上架狀態並以伺服器回傳值更新本地資料（單筆開關、批次與復原共用）
// moveToTop：重新上架時一併排到前台最前面（伺服器取全站最大值 + 1）
async function setVariantPublished(variant, next, { moveToTop = false } = {}) {
  const result = await deps.adminFetch(`/api/admin/variants/${variant.id}`, { method: "PATCH", body: JSON.stringify({ ...variantPayload(variant, next), ...(moveToTop ? { move_to_top: true } : {}) }) });
  const saved = result?.variant && !Array.isArray(result.variant) ? result.variant : null;
  variant.is_published = typeof saved?.is_published === "boolean" ? saved.is_published : next;
  if (Number.isInteger(saved?.display_order)) variant.display_order = saved.display_order;
  if (saved?.updated_at) variant.updated_at = saved.updated_at;
  if (result?.moveError) deps.showToast(result.moveError, "error");
}

// 只改商品的上架狀態，其他欄位照目前資料送出（API 需要完整商品內容）
async function setProductPublished(product, isPublished) {
  const result = await deps.adminFetch(`/api/admin/products/${product.id}`, { method: "PATCH", body: JSON.stringify({
    name: product.name, description: product.description || "", category_id: product.category_id || null,
    purchase_limit: product.purchase_limit ?? null, points_eligible: product.points_eligible !== false,
    display_order: Number(product.display_order || 0), is_published: isPublished
  }) });
  product.is_published = typeof result?.product?.is_published === "boolean" ? result.product.is_published : isPublished;
}

// 復原：把剛變更的規格改回原狀態（不再跳確認視窗）
async function undoPublish(items, appliedValue) {
  const failed = [];
  for (const { product, variant, previousOrder, unpublishProduct } of items) {
    // 重新上架時排到最前面的話，復原也要把前台排序還原
    if (Number.isInteger(previousOrder)) variant.display_order = previousOrder;
    try {
      // 這次一併上架了商品：先把商品下架，商品的其他規格也立即從前台隱藏
      if (unpublishProduct) await setProductPublished(product, false);
      await setVariantPublished(variant, !appliedValue);
    } catch (error) { failed.push(`${product.name}／${variant.name}（${error.message}）`); }
  }
  deps.onCatalogChanged();
  drawTable();
  if (failed.length) deps.showToast(`復原失敗：${failed.join("；")}`, "error");
  else deps.showToast(`已復原 ${items.length} 個規格`, "success");
}

async function togglePublish(button) {
  const found = findVariant(button.dataset.variantPublish);
  if (!found || button.disabled) return;
  const { product, variant } = found;
  const next = !variant.is_published;
  const label = `${product.name}／${variant.name}`;
  // 商品本身未上架時，開啟規格會一併上架商品（新增時忘了勾「立即上架」的常見情況），前台才會顯示
  const publishProductToo = next && !product.is_published;
  const message = !next
    ? "下架後前台不再顯示此規格，顧客無法再加入購物車。"
    : publishProductToo
      ? "此商品目前未上架，將同時上架「商品」與此規格，前台會顯示且顧客可加入購物車。"
      : "上架後前台會顯示此規格，顧客可加入購物車。";
  const { confirmed, checked: moveToTop } = await adminConfirmChoice({
    title: `${next ? "上架" : "下架"}「${label}」？`, message, confirmLabel: next ? "確定上架" : "確定下架", danger: !next, trigger: button,
    option: next ? { label: "重新上架並排到最前面（前台排序改為目前最大值 + 1）", checked: false } : null
  });
  if (!confirmed) return;
  const previousOrder = variant.display_order;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    await setVariantPublished(variant, next, { moveToTop });
    let productPublished = false;
    if (publishProductToo) {
      try { await setProductPublished(product, true); productPublished = true; }
      catch (error) { deps.showToast(`規格已上架，但商品上架失敗：${error.message || "請到「編輯」勾選上架商品"}`, "error"); }
    }
    deps.onCatalogChanged();
    drawTable();
    // 表格重繪後按鈕已換新，焦點移回同一規格的開關
    list.querySelector(`[data-variant-publish="${CSS.escape(variant.id)}"]`)?.focus({ preventScroll: true });
    const moved = variant.display_order !== previousOrder;
    offerUndo(variant.is_published ? `已上架：${label}${moved ? "（已排到最前面）" : ""}` : `已下架：${label}（前台隱藏）`, () => undoPublish([{ ...found, previousOrder: moved ? previousOrder : undefined, unpublishProduct: productPublished }], next));
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
    const unpublishedToggle = target.closest("[data-unpublished-toggle]");
    if (unpublishedToggle) return toggleUnpublished(unpublishedToggle);
    const publish = target.closest("[data-variant-publish]");
    if (publish) return void togglePublish(publish);
    const price = target.closest("[data-variant-price]");
    if (price) return openPriceSheet(price.dataset.variantPrice, price);
    const stockAdjust = target.closest("[data-stock-adjust]");
    if (stockAdjust) return openStockAdjust(stockAdjust.dataset.stockAdjust, stockAdjust);
    const edit = target.closest("[data-product-edit]");
    if (edit) return openEditSheet(edit.dataset.productEdit, edit);
    const addVariant = target.closest("[data-products-add-variant]");
    if (addVariant) return openVariantCreator(addVariant.dataset.productsAddVariant, null);
    const sheet = target.closest("[data-products-sheet]");
    if (sheet) return openAdminSheetFor(document.querySelector(sheet.dataset.productsSheet), sheet);
    const editTab = target.closest("[data-edit-tab]");
    if (editTab) activateEditTab(editTab.dataset.editTab);
  });
  // 編輯面板分頁列：左右鍵在分頁間移動並切換（role="tablist" 標準鍵盤操作）
  document.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tab = event.target.closest?.("[data-edit-tab]");
    const tablist = tab?.closest('[role="tablist"]');
    if (!tab || !tablist) return;
    const tabs = [...tablist.querySelectorAll("[data-edit-tab]")];
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    event.preventDefault();
    const next = tabs[(index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    activateEditTab(next.dataset.editTab);
    next.focus();
  });
  // 編輯面板的規格清單一次只能展開一個：開啟一個時收合其他（toggle 事件不會冒泡，用 capture 階段攔截）
  document.addEventListener("toggle", (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.matches("[data-edit-variant]") || !details.open) return;
    details.closest('[data-edit-panel="variants"]')?.querySelectorAll("details[data-edit-variant][open]")
      .forEach((other) => { if (other !== details) other.open = false; });
  }, true);
  document.addEventListener("change", (event) => {
    const filter = event.target.closest?.("[data-products-filter]");
    // 篩選改由伺服器重新查詢並回到第 1 頁；先重畫本頁，等待期間不會顯示不符合條件的列
    if (filter) { view[filter.dataset.productsFilter] = filter.value; drawTable(); deps.reloadProducts(); }
    markEditFormDirty(event.target);
  });
  document.addEventListener("input", (event) => {
    const form = event.target.closest?.("[data-price-form]");
    if (form) syncPricePreview(form);
    markEditFormDirty(event.target);
  });
  // 展示設定表單不會觸發清單重新載入（見 admin-product-gallery.js saveShowcase），成功後改用這個事件清除 dirty 狀態
  document.addEventListener("admin:showcase-saved", (event) => {
    if (event.target instanceof HTMLFormElement && editSheet?.body.contains(event.target)) clearEditFormDirty(event.target);
  });
  // 送出優惠價／編輯面板內的表單：記錄時間。優惠價成功後自動關閉面板；編輯面板的表單用來排除「剛存過」的還原（見 renderEditSheet）
  document.addEventListener("submit", (event) => {
    if (event.target.matches?.("[data-price-form]")) priceSubmittedAt = Date.now();
    if (event.target instanceof HTMLFormElement && editSheet?.body.contains(event.target)) {
      const key = editFormKey(event.target);
      if (key) editFormSubmittedAt.set(key, Date.now());
    }
  }, true);
}

// deps：getProducts、getCategories、reloadProducts、adminFetch、showToast、adminCategoryOptions、splitPreorderArrival、fallbackMarkup、onCatalogChanged
export function initAdminProductsTable(options) {
  if (deps) return;
  deps = options;
  list = document.querySelector("#admin-product-list");
  if (!list) throw new Error("找不到商品列表容器");
  bindEvents();
  initVariantBatch({ findVariant, setVariantPublished, undoPublish, adminConfirm, onCatalogChanged: deps.onCatalogChanged, redraw: drawTable, showToast: deps.showToast, offerUndo });
}

export function renderAdminProductsTable() {
  if (!deps) throw new Error("商品列表尚未初始化");
  ensureToolbar();
  drawTable();
  syncSheetsAfterRender();
}
