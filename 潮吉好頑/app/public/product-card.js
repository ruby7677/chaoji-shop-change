// 商品卡標記：首頁商品格與商品頁「您可能也喜歡」共用同一份 HTML。
import { escapeHtml, hasProductDiscount, preorderStockMarkup, productAvailability, productAvailabilityBadge, productMark, productPriceMarkup, productPromotionBadge, productTagMarkup } from "./product-format.js";

function productCardImageMarkup(product) {
  return product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" loading="lazy" />`
    : `<div class="product-placeholder"><span>${productMark(product)}</span><small>潮吉好頑選物</small></div>`;
}

export function productCardMarkup(product) {
  return `<article class="product-card" data-product-id="${escapeHtml(product.id)}"><div class="product-image">${productAvailabilityBadge(product)}${productPromotionBadge(product)}${productCardImageMarkup(product)}</div><div class="product-info"><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.type)}</span><h3>${escapeHtml(product.name)}</h3>${productTagMarkup(product)}<p class="stock">${escapeHtml(productAvailability(product))}</p>${preorderStockMarkup(product)}<div class="price${hasProductDiscount(product) ? " price-discounted" : ""}">${productPriceMarkup(product)}</div><div class="card-actions"><button type="button" data-add="${escapeHtml(product.id)}">加入選物盒</button><button type="button" class="detail-button" data-detail="${escapeHtml(product.id)}">查看規格</button></div></div></article>`;
}
