// 商品顯示用的純函式：首頁商品格、商品頁與推薦區共用。
// 只做格式化與跳脫，不讀寫任何狀態。

export function money(value) { return `NT$${value.toLocaleString("zh-TW")}`; }
export function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
export function isPreorderItem(item) { return ["預購", "preorder"].includes(String(item?.type || item?.kind || "").toLowerCase()); }
export function productMark(product) {
  const source = String(product?.category || product?.product_name || product?.name || "玩具").replace(/\s+/g, "");
  return escapeHtml(source.slice(0, 2) || "玩具");
}
export function productAvailability(product) {
  if (product?.type === "現貨") return `現貨 ${Number(product.stock || 0)} 件`;
  return product?.preorder_arrival ? `預購 · ${product.preorder_arrival}` : "預購 · 海運與集運依實際進度";
}
export function preorderStockMarkup(product) {
  return isPreorderItem(product) ? `<p class="preorder-stock">預購限量 ${Number(product.stock || 0)} 件</p>` : "";
}
export function hasProductDiscount(product) {
  return Number(product?.compare_at_price || 0) > Number(product?.price || 0);
}
export function productPriceMarkup(product) {
  const price = Number(product?.price || 0);
  return hasProductDiscount(product)
    ? `<s class="price-original">${money(Number(product.compare_at_price))}</s><strong class="price-sale">${money(price)}</strong>`
    : money(price);
}
export function productPromotionBadge(product) {
  return hasProductDiscount(product) ? '<span class="product-promotion-badge">限時優惠</span>' : "";
}
export function productAvailabilityBadge(product) {
  return isPreorderItem(product)
    ? '<span class="product-availability-badge product-availability-badge-preorder">預購</span>'
    : '<span class="product-availability-badge product-availability-badge-in-stock">現貨</span>';
}
export function productTagMarkup(product) {
  const tags = [];
  if (isPreorderItem(product)) tags.push('<span class="product-tag product-tag-deposit">訂金50%</span>');
  if (product?.points_eligible === false) tags.push('<span class="product-tag product-tag-no-points">不可積點</span>');
  return tags.length ? `<div class="product-tags" aria-label="商品標籤">${tags.join("")}</div>` : "";
}
