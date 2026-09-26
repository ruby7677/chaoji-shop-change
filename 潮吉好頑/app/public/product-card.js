// 商品卡標記：首頁商品格與商品頁「您可能也喜歡」共用同一份 HTML。
import { escapeHtml, hasProductDiscount, preorderStockMarkup, productAvailability, productAvailabilityBadge, productMark, productPriceMarkup, productPromotionBadge, productTagMarkup } from "./product-format.js";

// 商品卡只需要縮圖（實際渲染約 180–300 CSS px），完整原圖留給 srcset 的高解析度分支；
// image_url 本身可能已帶 ?v= 版本參數，用 & 或 ? 接上 size=thumb 視情況而定。
function withThumbnailQuery(imageUrl) {
  return `${imageUrl}${imageUrl.includes("?") ? "&" : "?"}size=thumb`;
}

function productCardImageMarkup(product) {
  if (!product.image_url) return `<div class="product-placeholder"><span>${productMark(product)}</span><small>潮吉好頑選物</small></div>`;
  const thumbnailUrl = withThumbnailQuery(product.image_url);
  return `<img src="${escapeHtml(thumbnailUrl)}" srcset="${escapeHtml(thumbnailUrl)} 640w, ${escapeHtml(product.image_url)} 1600w" sizes="(min-width: 768px) 25vw, 50vw" alt="${escapeHtml(product.name)}" loading="lazy" />`;
}

export function productCardMarkup(product) {
  return `<article class="product-card" data-product-id="${escapeHtml(product.id)}"><div class="product-image">${productAvailabilityBadge(product)}${productPromotionBadge(product)}${productCardImageMarkup(product)}</div><div class="product-info"><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.type)}</span><h3>${escapeHtml(product.name)}</h3>${productTagMarkup(product)}<p class="stock">${escapeHtml(productAvailability(product))}</p>${preorderStockMarkup(product)}<div class="price${hasProductDiscount(product) ? " price-discounted" : ""}">${productPriceMarkup(product)}</div>${cardActionsMarkup(product)}</div></article>`;
}

// 「加入購物車」留在原頁繼續逛；「直接購買」加入後打開購物車。商品頁入口改由圖片與名稱進入。
function cardActionsMarkup(product) {
  const id = escapeHtml(product.id);
  const soldOut = Number(product.stock || 0) <= 0;
  return `<div class="card-actions"><button type="button" data-add="${id}" ${soldOut ? "disabled" : ""}>加入購物車</button><button type="button" class="detail-button buy-now-button" data-buy-now="${id}" ${soldOut ? "disabled" : ""}>${soldOut ? "已售完" : "直接購買"}</button></div>`;
}
