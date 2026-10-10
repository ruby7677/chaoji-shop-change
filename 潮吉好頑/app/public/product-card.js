// 商品卡標記：首頁商品格與商品頁「您可能也喜歡」共用同一份 HTML。
import { escapeHtml, hasProductDiscount, preorderStockMarkup, productAvailability, productAvailabilityBadge, productMark, productPriceMarkup, productPromotionBadge, productTagMarkup } from "./product-format.js";

// 商品卡只需要縮圖，完整原圖留給 srcset 的高解析度分支。
// sizes 依實測卡寬（手機 2 欄約 44vw、4 欄約 21vw），斷點對齊 styles.css 的 .product-grid（760px 以下 2 欄）；
// 高估會讓 2 倍螢幕改下載 1600w 原圖，改欄數或斷點時要一起改。
// thumb_url 由 Worker 提供（R2 公開網域或 Worker 路由的 size=thumb）；縮圖一定存在，小圖的縮圖就是原圖。
function productCardImageMarkup(product) {
  if (!product.image_url) return `<div class="product-placeholder"><span>${productMark(product)}</span><small>潮吉好頑選物</small></div>`;
  const thumbnailUrl = product.thumb_url || product.image_url;
  return `<img src="${escapeHtml(thumbnailUrl)}" srcset="${escapeHtml(thumbnailUrl)} 640w, ${escapeHtml(product.image_url)} 1600w" sizes="(min-width: 761px) 21vw, 45vw" alt="${escapeHtml(product.name)}" loading="lazy" />`;
}

export function productPageHref(product) {
  return `/products/${encodeURIComponent(product.product_id)}?v=${encodeURIComponent(product.id)}`;
}

// 名稱是真正的連結：鍵盤、報讀器、長按另開分頁都能進商品頁；連結範圍以 CSS 延伸到整張卡。
// 示範資料沒有 product_id，無商品頁可進，維持純文字。
function productNameMarkup(product) {
  const name = escapeHtml(product.name);
  return product.product_id ? `<a class="product-card-link" href="${escapeHtml(productPageHref(product))}">${name}</a>` : name;
}

export function productCardMarkup(product) {
  return `<article class="product-card" data-product-id="${escapeHtml(product.id)}"><div class="product-image">${productAvailabilityBadge(product)}${productPromotionBadge(product)}${productCardImageMarkup(product)}</div><div class="product-info"><div class="product-head"><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.type)}</span><h3>${productNameMarkup(product)}</h3></div><div class="product-meta">${productTagMarkup(product)}<p class="stock">${escapeHtml(productAvailability(product))}</p>${preorderStockMarkup(product)}</div><div class="price${hasProductDiscount(product) ? " price-discounted" : ""}">${productPriceMarkup(product)}</div>${cardActionsMarkup(product)}</div></article>`;
}

// 「加入購物車」留在原頁繼續逛；「直接購買」加入後打開購物車（手機版只留加入購物車，直接購買改在商品頁，見 storefront-legibility.css）。
// 商品頁入口由圖片與名稱進入。
function cardActionsMarkup(product) {
  const id = escapeHtml(product.id);
  const soldOut = Number(product.stock || 0) <= 0;
  return `<div class="card-actions"><button type="button" data-add="${id}" ${soldOut ? "disabled" : ""}>加入購物車</button><button type="button" class="detail-button buy-now-button" data-buy-now="${id}" ${soldOut ? "disabled" : ""}>${soldOut ? "已售完" : "直接購買"}</button></div>`;
}
