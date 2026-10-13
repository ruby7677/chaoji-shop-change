// 多規格商品卡的快速選購面板：在列表上選規格、數量後直接加入購物車或直接購買，不必進商品頁。
// 規格按鈕沿用商品頁的 .pp-option 樣式；加入購物車與直接購買沿用 cart.js 的同一套數量規則。
import { escapeHtml, hasProductDiscount, preorderStockMarkup, productAvailability, productMark, productPriceMarkup } from "./product-format.js";
import { variantMaxQuantity } from "./cart-quantity.js";
import { productPageHref } from "./product-card.js";

export function createVariantSheet(deps) {
  const dialog = document.querySelector("#variant-sheet");
  const panel = dialog?.querySelector("[data-vs-panel]");
  let state = null;

  const selected = () => state?.variants.find((variant) => variant.id === state.variantId);

  function imageMarkup(variant) {
    if (!variant.image_url) return `<div class="vs-thumb vs-thumb-empty" aria-hidden="true">${productMark(variant)}</div>`;
    return `<img class="vs-thumb" src="${escapeHtml(variant.thumb_url || variant.image_url)}" alt="" />`;
  }

  function optionsMarkup() {
    return state.variants.map((item) => {
      const inStock = Number(item.stock) > 0;
      return `<label class="pp-option${inStock ? "" : " is-sold-out"}"><input type="radio" name="vs-variant" value="${escapeHtml(item.id)}" ${item.id === state.variantId ? "checked" : ""} /><span>${escapeHtml(item.variant_name || item.name)}</span>${inStock ? "" : "<small>無庫存</small>"}</label>`;
    }).join("");
  }

  function render() {
    const variant = selected();
    if (!variant) return;
    const max = variantMaxQuantity(variant);
    state.quantity = Math.min(Math.max(state.quantity, 1), Math.max(max, 1));
    const name = variant.product_name || variant.name;
    const disabled = max > 0 ? "" : "disabled";
    // 只重畫面板內容：showToast() 會把全站共用的 #toast 移進開啟中的 dialog，不能整個 dialog 重寫
    panel.innerHTML = `<button class="dialog-close" type="button" data-vs-close aria-label="關閉">×</button><div class="vs-head">${imageMarkup(variant)}<div class="vs-head-text"><h2 id="variant-sheet-title">${escapeHtml(name)}</h2><div class="price${hasProductDiscount(variant) ? " price-discounted" : ""}">${productPriceMarkup(variant)}</div><p class="vs-stock">${escapeHtml(productAvailability(variant))}</p>${preorderStockMarkup(variant)}</div></div><fieldset class="pp-options vs-options"><legend>規格</legend><div class="pp-option-list">${optionsMarkup()}</div></fieldset><div class="vs-qty"><label for="vs-quantity">數量</label><div class="pp-stepper"><button type="button" data-vs-step="-1" aria-label="減少數量" ${disabled}>−</button><input id="vs-quantity" type="number" inputmode="numeric" min="1" max="${Math.max(max, 1)}" step="1" value="${state.quantity}" ${disabled} /><button type="button" data-vs-step="1" aria-label="增加數量" ${disabled}>+</button></div></div><div class="vs-actions"><button class="primary-button" type="button" data-vs-add ${disabled}>${max > 0 ? "加入購物車" : "目前無可售庫存"}</button>${max > 0 ? '<button class="secondary-button" type="button" data-vs-buy-now>直接購買</button>' : ""}</div><a class="vs-detail-link" href="${escapeHtml(productPageHref(variant))}" data-vs-detail>查看商品詳情 <span aria-hidden="true">→</span></a>`;
  }

  function open(cardVariantId) {
    const card = deps.getProducts().find((item) => item.id === cardVariantId);
    if (!card?.product_id || !panel) return false;
    const variants = deps.getProducts().filter((item) => item.product_id === card.product_id);
    const lead = variants.find((item) => item.id === cardVariantId && Number(item.stock) > 0) || variants.find((item) => Number(item.stock) > 0) || card;
    state = { productId: card.product_id, variants, variantId: lead.id, quantity: 1 };
    render();
    deps.showDialog(dialog);
    return true;
  }

  function close() {
    deps.closeDialog(dialog);
  }

  function quantity() {
    return Number(dialog.querySelector("#vs-quantity")?.value);
  }

  dialog?.addEventListener("click", (event) => {
    // 點面板外的背景（dialog 本身）關閉
    if (event.target === dialog || event.target.closest("[data-vs-close]")) return close();
    const step = event.target.closest("[data-vs-step]");
    const input = dialog.querySelector("#vs-quantity");
    if (step && input && !input.disabled) {
      const next = Number(input.value || 1) + Number(step.dataset.vsStep);
      input.value = String(Math.min(Math.max(next, 1), Number(input.max) || 1));
      state.quantity = Number(input.value);
      return;
    }
    if (event.target.closest("[data-vs-add]:not([disabled])")) {
      const result = deps.addToCart(state.variantId, quantity());
      // 成功先關面板再提示，提示才不會跟著面板一起隱藏；失敗則留在面板內提示
      if (result.ok) close();
      deps.showToast(result.message, result.ok ? "success" : "warning");
      return;
    }
    if (event.target.closest("[data-vs-buy-now]")) {
      const variantId = state.variantId;
      const amount = quantity();
      close();
      const result = deps.buyNow(variantId, amount);
      if (result.message) deps.showToast(result.message, result.ok ? "success" : "warning");
      return;
    }
    const detail = event.target.closest("[data-vs-detail]");
    if (detail && !(event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0)) {
      event.preventDefault();
      const { productId, variantId } = state;
      close();
      deps.openProduct(productId, variantId);
    }
  });
  dialog?.addEventListener("input", (event) => {
    if (event.target.matches("#vs-quantity") && state) state.quantity = Number(event.target.value) || 1;
  });
  dialog?.addEventListener("change", (event) => {
    if (!event.target.matches('input[name="vs-variant"]') || !state) return;
    state.variantId = event.target.value;
    state.quantity = 1;
    render();
    dialog.querySelector('input[name="vs-variant"]:checked')?.focus({ preventScroll: true });
  });
  dialog?.addEventListener("close", () => { state = null; deps.syncScrollLock(); });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest(".product-card [data-choose-variant]");
    if (!trigger) return;
    if (open(trigger.dataset.chooseVariant)) event.preventDefault();
  });

  return { open, close };
}
