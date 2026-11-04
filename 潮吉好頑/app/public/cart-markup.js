// 購物車畫面的 HTML 組裝（只回傳字串）：單一品項與「現貨／預購」分組區塊。狀態與事件在 cart.js。
import { deliveryRestrictionLabel } from "./cart-delivery-rules.js";
import { escapeHtml, isPreorderItem, money } from "./product-format.js";

export function cartItemMarkup(item) {
  const restriction = deliveryRestrictionLabel(item);
  const restrictionTag = restriction ? `<small class="cart-item-restriction">${escapeHtml(restriction)}</small>` : "";
  return `<div class="cart-item"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price)} · ${escapeHtml(item.category)} · ${isPreorderItem(item) ? "預購" : "現貨"}</small>${restrictionTag}<div class="quantity"><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1" aria-label="減少「${escapeHtml(item.name)}」數量">−</button><b>${item.quantity}</b><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1" aria-label="增加「${escapeHtml(item.name)}」數量">＋</button></div></div><div><strong>${money(item.price * item.quantity)}</strong><button class="remove" type="button" data-remove="${escapeHtml(item.id)}">移除</button></div></div>`;
}

/** options：[值, 名稱, 說明] 清單（已依商品限制過濾）；method：目前選擇。 */
export function cartGroupMarkup({ scope, group, method, options }) {
  const title = scope === "in_stock" ? "現貨商品" : "預購商品";
  const subtotal = group.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const choices = options.map(([value, label, note]) => `<label class="cart-delivery-option"><input type="radio" name="cart_group_delivery_method_${scope}" value="${value}" data-group-delivery="${scope}" ${method === value ? "checked" : ""} /> <span><strong>${label}</strong><small>${note}</small></span></label>`).join("");
  return `<section class="cart-group" data-cart-group="${scope}"><header><div><span class="eyebrow">${scope === "in_stock" ? "READY" : "PREORDER"}</span><h3>${title}</h3></div><strong>${money(subtotal)}</strong></header><div class="cart-group-items">${group.map(cartItemMarkup).join("")}</div><fieldset class="cart-group-delivery"><legend>此組商品取貨方式</legend>${choices}</fieldset><p class="cart-delivery-feedback hidden" data-group-feedback="${scope}" role="status" aria-live="polite"></p><button class="primary-button cart-group-checkout" type="button" data-checkout-scope="${scope}">${scope === "in_stock" ? "結帳現貨商品" : "結帳預購商品"}</button></section>`;
}
