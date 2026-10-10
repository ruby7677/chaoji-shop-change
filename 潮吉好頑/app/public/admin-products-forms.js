// 商品與規格頁（ADMIN_REDESIGN_PLAN Stage 8）的表單標記：商品編輯、規格編輯、優惠價。
// 欄位名稱與原 renderAdminProducts 相同，送出仍由 app.js 的 submitDynamicAdminForm 以
// [data-edit-product-form]／[data-edit-variant-form] 的 document 委派處理，格式不變。
import { escapeHtml, money } from "./product-format.js";
import { adminProductGalleryMarkup, adminProductShowcaseMarkup } from "./admin-product-gallery.js";

export const relationOne = (value) => (Array.isArray(value) ? value[0] : value);

export function discountPercent(variant) {
  const price = Number(variant?.price || 0);
  const compareAt = Number(variant?.compare_at_price || 0);
  return compareAt > price && price > 0 ? Math.round((1 - price / compareAt) * 100) : 0;
}

export function priceMarkup(variant) {
  const price = Number(variant?.price || 0);
  const compareAt = Number(variant?.compare_at_price || 0);
  return compareAt > price
    ? `<span class="admin-price is-sale"><s class="admin-price-was">${money(compareAt)}</s><span class="admin-price-now">${money(price)}</span></span>`
    : `<span class="admin-price">${money(price)}</span>`;
}

const kindPill = (kind) => (kind === "preorder" ? '<span class="admin-pill amber">預購</span>' : '<span class="admin-pill mint">現貨</span>');

// helpers：{ adminCategoryOptions, splitPreorderArrival }（由 app.js 注入）
function arrivalFieldset(variant, helpers) {
  const arrival = helpers.splitPreorderArrival(variant.preorder_arrival);
  const hint = arrival.raw
    ? `<small class="date-range-legacy">目前文字：${escapeHtml(arrival.raw)}；若選日期後儲存，會改為日期區間。</small>`
    : "<small>可只選一天；預購實際到貨時間仍以海外物流進度為準。</small>";
  return `<fieldset class="wide date-range-field"><legend>預計到貨區間（選填）</legend><div class="date-range-grid"><label>開始日期<input name="preorder_arrival_from" type="date" value="${arrival.from}" /></label><label>結束日期<input name="preorder_arrival_until" type="date" value="${arrival.until}" /></label></div>${hint}<input type="hidden" name="preorder_arrival_raw" value="${escapeHtml(arrival.raw)}" /></fieldset>`;
}

const depositPercent = (variant) => Math.round(Number(variant.deposit_rate) * 100);

export function variantFormMarkup(variant, helpers) {
  return `<form class="admin-form" data-edit-variant-form="${escapeHtml(variant.id)}"><div class="form-grid">`
    + `<label>規格名稱<input name="name" required value="${escapeHtml(variant.name)}" /></label>`
    + `<label>類型<select name="kind"><option value="in_stock" ${variant.kind === "in_stock" ? "selected" : ""}>現貨</option><option value="preorder" ${variant.kind === "preorder" ? "selected" : ""}>預購</option></select></label>`
    + `<label>售價<input name="price" type="number" min="0" step="1" required value="${variant.price}" /></label>`
    + `<label>原價（選填）<input name="compare_at_price" type="number" min="0" step="1" value="${variant.compare_at_price ?? ""}" placeholder="例如 1680" /><small>高於售價時顯示刪除線與限時優惠。</small></label>`
    + `<label>安全庫存<input name="safety_stock" type="number" min="0" step="1" value="${variant.safety_stock}" /></label>`
    + `<label>訂金比例（%）<input name="deposit_rate" type="number" min="0" max="100" value="${depositPercent(variant)}" /></label>`
    + arrivalFieldset(variant, helpers)
    + `<label>前台排序<input name="display_order" type="number" value="${variant.display_order}" /><small>數字越大越前面；新增時自動取目前最大值 + 1</small></label>`
    + `<label class="wide">賣貨便連結<input name="seller_link" type="url" value="${escapeHtml(variant.seller_link || "")}" /></label>`
    + `<label class="check-field"><input name="is_published" type="checkbox" ${variant.is_published ? "checked" : ""} /> 上架此規格</label>`
    + '</div><button class="primary-button" type="submit">儲存規格</button></form>';
}

// 優惠價面板：只顯示售價與原價，其餘欄位以 hidden 帶入目前值，送出內容與完整規格表單相同
export function priceFormMarkup(product, variant, helpers) {
  const arrival = helpers.splitPreorderArrival(variant.preorder_arrival);
  const hidden = [
    ["name", variant.name], ["kind", variant.kind], ["safety_stock", variant.safety_stock],
    ["deposit_rate", depositPercent(variant)], ["preorder_arrival_from", arrival.from], ["preorder_arrival_until", arrival.until],
    ["preorder_arrival_raw", arrival.raw], ["display_order", variant.display_order], ["seller_link", variant.seller_link || ""]
  ];
  if (variant.is_published) hidden.push(["is_published", "on"]);
  return `<form class="admin-form admin-price-form" data-edit-variant-form="${escapeHtml(variant.id)}" data-price-form>`
    + `<p class="admin-price-target"><b>${escapeHtml(product.name)}</b><span>${escapeHtml(variant.name)}</span></p>`
    + hidden.map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`).join("")
    + '<div class="form-grid">'
    + `<label>售價（顧客實付）<input name="price" type="number" min="0" step="1" required value="${variant.price}" /></label>`
    + `<label>原價（選填）<input name="compare_at_price" type="number" min="0" step="1" value="${variant.compare_at_price ?? ""}" placeholder="例如 1680" /><small>高於售價時前台顯示刪除線與「限時優惠」；清空即結束優惠。</small></label>`
    + '</div><p class="admin-price-preview" data-price-preview role="status" aria-live="polite"></p>'
    + '<button class="primary-button" type="submit">儲存優惠價</button></form>';
}

export function pricePreviewText(price, compareAt) {
  const now = Number(price || 0);
  const was = Number(compareAt || 0);
  if (!was) return "目前沒有設定原價，前台只顯示售價。";
  if (was <= now) return "原價需高於售價才會顯示限時優惠。";
  return `前台顯示：${money(was)} 劃線 → ${money(now)}，限時優惠 −${Math.round((1 - now / was) * 100)}%`;
}

function productFormMarkup(product, helpers) {
  const categoryId = product.category_id || relationOne(product.categories)?.id || "";
  return `<form class="admin-form" data-edit-product-form="${escapeHtml(product.id)}" data-category-id="${escapeHtml(product.category_id || "")}"><div class="form-grid">`
    + `<label>商品名稱<input name="name" required value="${escapeHtml(product.name)}" /></label>`
    + `<label>商品分類<select name="category_id">${helpers.adminCategoryOptions(categoryId, { includeInactiveSelected: true })}</select><small>分類位於商品層級，所有規格共用。</small></label>`
    // 商品層級排序不影響前台（前台依規格排序），隱藏但原值照送，避免存檔時被歸零
    + `<input name="display_order" type="hidden" value="${escapeHtml(product.display_order ?? 0)}" />`
    + `<label class="wide">商品說明<textarea name="description" rows="3">${escapeHtml(product.description || "")}</textarea></label>`
    + `<label>每位會員限購數量<input name="purchase_limit" type="number" min="1" step="1" value="${product.purchase_limit ?? ""}" placeholder="留空代表不限購" /></label>`
    + `<label class="check-field admin-points-excluded-field"><input name="points_excluded" type="checkbox" ${product.points_eligible === false ? "checked" : ""} /> 不可累積會員點數<small>啟用後，完成訂單時此商品金額不列入新點數累積。</small></label>`
    + `<label class="check-field"><input name="is_published" type="checkbox" ${product.is_published ? "checked" : ""} /> 上架商品<small>商品未上架時，所有規格在前台都不會顯示。</small></label>`
    + '</div><button class="primary-button" type="submit">儲存商品</button></form>';
}

// 刪除商品放在商品資料最下方，與儲存按鈕分開；點擊後由 admin-product-delete.js 確認並送出
function deleteSectionMarkup(product) {
  return '<section class="admin-edit-section admin-product-delete"><div><h4>刪除商品</h4>'
    + "<p>商品與所有規格會從前台與後台移除，已成立的訂單紀錄保留。還有未完成訂單時無法刪除。</p></div>"
    + `<button class="secondary-button danger-button" type="button" data-product-delete="${escapeHtml(product.id)}" data-product-name="${escapeHtml(product.name)}">刪除商品</button></section>`;
}

function variantDetailsMarkup(variant, helpers, open) {
  const sale = discountPercent(variant);
  return `<details class="admin-edit-variant" data-edit-variant="${escapeHtml(variant.id)}" ${open ? "open" : ""}><summary>`
    + `<span class="admin-edit-variant-name"><b>${escapeHtml(variant.name)}</b></span>`
    + `<span class="admin-edit-variant-meta">${kindPill(variant.kind)}${sale ? `<span class="admin-pill danger">−${sale}%</span>` : ""}${variant.is_published ? "" : '<span class="admin-pill gray">未上架</span>'}${priceMarkup(variant)}</span>`
    + `</summary>${variantFormMarkup(variant, helpers)}</details>`;
}

const EDIT_TABS = [
  { key: "product", label: "商品資料" },
  { key: "media", label: "照片與展示" }
  // 「規格 (N)」在 editSheetMarkup 內另外組字（需要 variants.length），不放在這個固定清單裡
];

function editTabButtonMarkup(key, label, active) {
  // aria-selected／tabindex／面板 hidden 三者只在開啟或分頁切換時同步；實際切換行為在 admin-products-table.js
  return `<button type="button" role="tab" id="admin-edit-tab-${key}" aria-controls="admin-edit-panel-${key}" aria-selected="${active}" tabindex="${active ? 0 : -1}" data-edit-tab="${key}">${label}`
    + `<span class="admin-edit-tab-dot" data-edit-tab-dot hidden><span class="sr-only">有未儲存的修改</span></span></button>`;
}

function editTabPanelMarkup(key, active, inner) {
  return `<div id="admin-edit-panel-${key}" class="admin-edit-panel" role="tabpanel" aria-labelledby="admin-edit-tab-${key}" data-edit-panel="${key}"${active ? "" : " hidden"}>${inner}</div>`;
}

// openVariants：重新渲染前已展開的規格 id（同一時間只會有一個，由 admin-products-table.js 的手風琴行為維持）。
// activeTab：重新渲染前選取的分頁（"product"／"media"／"variants"），預設 "product"。
export function editSheetMarkup(product, helpers, openVariants = new Set(), activeTab = "product") {
  const variants = [...(product.product_variants || [])].sort((a, b) => b.display_order - a.display_order);
  const tab = ["product", "media", "variants"].includes(activeTab) ? activeTab : "product";
  const tabBar = `<div class="admin-edit-tabs" role="tablist" aria-label="編輯商品分頁">`
    + EDIT_TABS.map(({ key, label }) => editTabButtonMarkup(key, label, key === tab)).join("")
    + editTabButtonMarkup("variants", `規格 <span>(${variants.length})</span>`, tab === "variants")
    + "</div>";
  const productPanel = editTabPanelMarkup("product", tab === "product", `<section class="admin-edit-section">${productFormMarkup(product, helpers)}</section>${deleteSectionMarkup(product)}`);
  const mediaPanel = editTabPanelMarkup("media", tab === "media", adminProductGalleryMarkup(product) + adminProductShowcaseMarkup(product));
  const variantsInner = `<section class="admin-edit-section"><header class="admin-edit-section-head"><h4>商品規格 <span>${variants.length}</span></h4><button class="secondary-button" type="button" data-products-add-variant="${escapeHtml(product.id)}">新增規格</button></header>`
    + (variants.map((variant) => variantDetailsMarkup(variant, helpers, openVariants.has(variant.id))).join("") || '<div class="empty-state">此商品尚無規格。</div>')
    + "</section>";
  const variantsPanel = editTabPanelMarkup("variants", tab === "variants", variantsInner);
  return tabBar + productPanel + mediaPanel + variantsPanel;
}

export { kindPill };
