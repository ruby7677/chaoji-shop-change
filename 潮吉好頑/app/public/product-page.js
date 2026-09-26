// 商品頁視圖（/products/:productId）：多圖、購買欄、詳細介紹、推薦商品。
// 規格、價格、庫存沿用首頁型錄資料（與購物車同一份），詳細介紹與多圖另向 /api/products/:id 取得。
import { escapeHtml, hasProductDiscount, isPreorderItem, preorderStockMarkup, productAvailability, productPriceMarkup, productTagMarkup } from "./product-format.js";
import { productCardMarkup } from "./product-card.js";
import { formatProductDetails } from "./product-details-format.js";
import { bindProductGallery, productGalleryMarkup } from "./product-gallery.js";
import { createProductRouter } from "./product-router.js";
import { scrollToAnchor } from "./anchor-scroll.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECOMMEND_COUNT = 4;
const NOTICES = {
  preorder: ["訂金 50%，訂單成立後 2 小時內完成付訂，逾期自動取消。", "海外海運與集運依實際進度到貨，不保證固定天數；到貨後由客服通知尾款。"],
  inStock: ["匯款訂單請於 24 小時內完成付款，逾期自動取消。", "可選到店取貨（台南民生路二段 93 號）、賣貨便或宅配；宅配運費於到貨後由客服通知。"]
};

function purchaseLimit(variant) {
  const limit = Number(variant.purchase_limit);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

function maxQuantity(variant) {
  const stock = Math.max(Number(variant.stock || 0), 0);
  const limit = purchaseLimit(variant);
  return limit ? Math.min(stock, limit) : stock;
}

export function createProductPage(deps) {
  const page = document.querySelector("#product-page");
  const metaDescription = document.querySelector('meta[name="description"]');
  const home = { title: document.title, description: metaDescription?.content || "" };
  const detailCache = new Map();
  let state = null;
  let renderToken = 0;
  let gallery = null;
  let observers = [];

  const variantsOf = (productId) => deps.getProducts().filter((variant) => variant.product_id === productId);
  const selectedVariant = () => state?.variants.find((variant) => variant.id === state.variantId);
  const isActive = () => document.body.classList.contains("is-product-view");

  function teardown() {
    gallery?.destroy();
    gallery = null;
    observers.forEach((observer) => observer.disconnect());
    observers = [];
  }

  async function loadDetail(productId) {
    if (detailCache.has(productId)) return detailCache.get(productId);
    try {
      const response = await fetch(`/api/products/${productId}`);
      const detail = response.ok ? await response.json() : { failed: true };
      if (response.ok) detailCache.set(productId, detail);
      return detail;
    } catch {
      return { failed: true };
    }
  }

  function galleryImages() {
    const lead = selectedVariant();
    const name = lead.product_name || lead.name;
    if (state.detail?.images?.length) return state.detail.images;
    return lead.image_url ? [{ url: lead.image_url, alt: name }] : [];
  }

  function renderGallery() {
    const target = page.querySelector("[data-pp-gallery]");
    if (!target) return;
    gallery?.destroy();
    const lead = selectedVariant();
    const name = lead.product_name || lead.name;
    const images = galleryImages();
    target.innerHTML = productGalleryMarkup(images, name);
    gallery = bindProductGallery(target, { images, name, showDialog: deps.showDialog, closeDialog: deps.closeDialog });
  }

  function noticeMarkup(preorder) {
    const lines = preorder ? NOTICES.preorder : NOTICES.inStock;
    return `<aside class="pp-notice" aria-label="購物須知摘要"><strong>${preorder ? "預購須知" : "現貨須知"}</strong><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><a href="/#policy-title" data-pp-home="policy-title">完整購物須知 <span aria-hidden="true">→</span></a></aside>`;
  }

  function variantMarkup(variant) {
    if (state.variants.length < 2) return `<p class="pp-variant"><span>規格</span>${escapeHtml(variant.variant_name || "單一規格")}</p>`;
    const options = state.variants.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === variant.id ? "selected" : ""}>${escapeHtml(item.variant_name || item.name)}${Number(item.stock) > 0 ? "" : "（無庫存）"}</option>`).join("");
    return `<label class="pp-field" for="pp-variant">規格<select id="pp-variant">${options}</select></label>`;
  }

  function renderBuy() {
    const target = page.querySelector("[data-pp-buy]");
    const variant = selectedVariant();
    if (!target || !variant) return;
    const max = maxQuantity(variant);
    const limit = purchaseLimit(variant);
    const preorder = isPreorderItem(variant);
    state.quantity = Math.min(Math.max(state.quantity, 1), Math.max(max, 1));
    const name = variant.product_name || variant.name;
    const buttonLabel = max > 0 ? "加入購物車" : "目前無可售庫存";
    target.innerHTML = `<span class="product-category">${escapeHtml(variant.category || "好頑選物")} · ${escapeHtml(variant.type)}</span><h1 id="pp-title" tabindex="-1">${escapeHtml(name)}</h1>${variant.description ? `<p class="pp-summary">${escapeHtml(variant.description)}</p>` : ""}${productTagMarkup(variant)}<div class="pp-price price${hasProductDiscount(variant) ? " price-discounted" : ""}">${productPriceMarkup(variant)}</div><p class="pp-stock">${escapeHtml(productAvailability(variant))}</p>${preorderStockMarkup(variant)}${variantMarkup(variant)}<div class="pp-field pp-qty"><label for="pp-quantity">數量</label><div class="pp-stepper"><button type="button" data-pp-step="-1" aria-label="減少數量" ${max > 0 ? "" : "disabled"}>−</button><input id="pp-quantity" type="number" inputmode="numeric" min="1" max="${Math.max(max, 1)}" step="1" value="${state.quantity}" ${max > 0 ? "" : "disabled"} /><button type="button" data-pp-step="1" aria-label="增加數量" ${max > 0 ? "" : "disabled"}>+</button></div></div>${limit ? `<small class="pp-limit">每位會員限購 ${limit} 件</small>` : ""}<button class="primary-button pp-add" type="button" data-pp-add data-pp-add-main ${max > 0 ? "" : "disabled"}>${buttonLabel}</button>${noticeMarkup(preorder)}`;
    const sticky = page.querySelector("[data-pp-sticky]");
    if (sticky) sticky.innerHTML = `<div><small>${escapeHtml(name)}</small><strong class="price${hasProductDiscount(variant) ? " price-discounted" : ""}">${productPriceMarkup(variant)}</strong></div><button class="primary-button" type="button" data-pp-add ${max > 0 ? "" : "disabled"}>${buttonLabel}</button>`;
    observeSticky();
  }

  function renderDetails() {
    const target = page.querySelector("[data-pp-details]");
    if (!target) return;
    const variant = selectedVariant();
    if (!state.detail) { target.innerHTML = '<p class="pp-loading">載入商品介紹中…</p>'; return; }
    const text = state.detail.product?.details || variant.description || "";
    if (text) target.innerHTML = formatProductDetails(text);
    else target.innerHTML = state.detail.failed ? '<p class="pp-loading">商品介紹暫時無法載入，請稍後重新整理。</p>' : '<p class="pp-loading">尚未提供詳細介紹。</p>';
  }

  // 推薦：排除本商品與全數無庫存的商品；同分類優先，其次同類型（現貨／預購），再依上架排序。
  function renderRecommendations() {
    const section = page.querySelector("[data-pp-rec-section]");
    const grid = page.querySelector("[data-pp-recommend]");
    if (!section || !grid) return;
    const current = selectedVariant();
    const groups = new Map();
    for (const variant of deps.getProducts()) {
      if (!variant.product_id || variant.product_id === state.productId) continue;
      if (!groups.has(variant.product_id)) groups.set(variant.product_id, []);
      groups.get(variant.product_id).push(variant);
    }
    const picks = [...groups.values()]
      .map((variants) => variants.find((variant) => Number(variant.stock) > 0))
      .filter(Boolean)
      .map((variant) => ({ variant, score: (variant.category === current.category ? 2 : 0) + (variant.type === current.type ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || Number(a.variant.display_order || 0) - Number(b.variant.display_order || 0))
      .slice(0, RECOMMEND_COUNT)
      .map(({ variant }) => variant);
    section.hidden = !picks.length;
    grid.innerHTML = picks.map(productCardMarkup).join("");
  }

  // 手機購買按鈕捲出畫面後，底部出現固定購買列。
  function observeSticky() {
    const button = page.querySelector("[data-pp-add-main]");
    const sticky = page.querySelector("[data-pp-sticky]");
    if (!button || !sticky || !("IntersectionObserver" in window)) return;
    // 底部 rootMargin 放大：按鈕在畫面下方也算「相交」，只有捲到畫面上方才不相交。
    // 否則快速滑動直接由下方跳到上方時不會跨過門檻，回呼不觸發。
    const observer = new IntersectionObserver(([entry]) => {
      const show = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sticky.classList.toggle("is-visible", show);
      sticky.inert = !show;
    }, { rootMargin: "0px 0px 100000px 0px" });
    observer.observe(button);
    observers.push(observer);
  }

  function observeReveal() {
    const targets = page.querySelectorAll("[data-reveal]");
    if (!("IntersectionObserver" in window)) { targets.forEach((node) => node.classList.add("is-revealed")); return; }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-revealed");
      observer.unobserve(entry.target);
    }), { rootMargin: "0px 0px -10% 0px" });
    targets.forEach((node) => observer.observe(node));
    observers.push(observer);
  }

  function setMeta(title, description) {
    document.title = title;
    if (metaDescription) metaDescription.content = description;
  }

  function renderMissing() {
    page.innerHTML = '<div class="pp-missing"><h1 id="pp-title" tabindex="-1">商品已下架或不存在</h1><p>這個商品目前無法購買，看看其他選物吧。</p><a class="primary-button" href="/#quick-pick" data-pp-home="quick-pick">回到商品列表</a></div>';
    setMeta(`找不到商品｜潮吉好頑`, home.description);
    page.querySelector("#pp-title")?.focus({ preventScroll: true });
  }

  async function show(productId, variantId) {
    const token = ++renderToken;
    teardown();
    document.body.classList.add("is-product-view");
    // 全站 html 設有 scroll-behavior:smooth；換頁時需立即定位，不做捲動動畫。
    window.scrollTo({ top: 0, behavior: "instant" });
    const variants = UUID_PATTERN.test(productId) ? variantsOf(productId) : [];
    if (!variants.length) return renderMissing();
    const variant = variants.find((item) => item.id === variantId) || variants.find((item) => Number(item.stock) > 0) || variants[0];
    state = { productId, variants, variantId: variant.id, quantity: 1, detail: detailCache.get(productId) || null };
    const name = variant.product_name || variant.name;
    page.innerHTML = `<nav class="pp-breadcrumb" aria-label="目前位置"><a href="/" data-pp-home="">首頁</a><span aria-hidden="true">/</span><a href="/#quick-pick" data-pp-home="quick-pick">${escapeHtml(variant.category || "商品")}</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(name)}</span></nav><div class="pp-main"><div class="pp-media" data-pp-gallery></div><div class="pp-buy" data-pp-buy></div></div><section class="pp-section" data-reveal aria-labelledby="pp-details-title"><h2 id="pp-details-title">商品介紹</h2><div class="pp-details" data-pp-details></div></section><section class="pp-section" data-reveal data-pp-rec-section aria-labelledby="pp-rec-title"><h2 id="pp-rec-title">您可能也喜歡</h2><div class="product-grid" data-pp-recommend></div></section><div class="pp-sticky-cta" data-pp-sticky inert></div>`;
    renderGallery();
    renderBuy();
    renderDetails();
    renderRecommendations();
    observeReveal();
    setMeta(`${name}｜潮吉好頑`, variant.description || home.description);
    page.querySelector("#pp-title")?.focus({ preventScroll: true });
    if (state.detail) return;
    const detail = await loadDetail(productId);
    if (token !== renderToken) return;
    state.detail = detail;
    renderGallery();
    renderDetails();
  }

  function hide({ hash = "", scrollY = 0 } = {}) {
    if (!isActive()) return;
    renderToken += 1;
    teardown();
    state = null;
    document.body.classList.remove("is-product-view");
    page.innerHTML = "";
    setMeta(home.title, home.description);
    requestAnimationFrame(() => {
      // 回首頁指定區塊：與首頁錨點同一套計算，停在導航列下方；沒有指定區塊則還原先前捲動位置。
      if (hash && hash !== "top" && scrollToAnchor(hash)) return;
      window.scrollTo({ top: Number(scrollY) || 0, behavior: "instant" });
    });
  }

  const router = createProductRouter({ onProduct: show, onHome: hide });

  function addSelected(button) {
    const variant = selectedVariant();
    const input = page.querySelector("#pp-quantity");
    if (!variant || !input) return;
    const result = deps.addToCart(variant.id, Number(input.value));
    deps.showToast(result.message, result.ok ? "success" : "warning");
    if (!result.ok) return;
    button.classList.add("is-added");
    window.setTimeout(() => button.classList.remove("is-added"), 1200);
  }

  page.addEventListener("click", (event) => {
    const step = event.target.closest("[data-pp-step]");
    const add = event.target.closest("[data-pp-add]");
    const input = page.querySelector("#pp-quantity");
    if (step && input && !input.disabled) {
      const next = Number(input.value || 1) + Number(step.dataset.ppStep);
      input.value = String(Math.min(Math.max(next, 1), Number(input.max) || 1));
      state.quantity = Number(input.value);
    }
    if (add && !add.disabled) addSelected(add);
  });
  page.addEventListener("input", (event) => {
    if (event.target.matches("#pp-quantity") && state) state.quantity = Number(event.target.value) || 1;
  });
  page.addEventListener("change", (event) => {
    if (!event.target.matches("#pp-variant") || !state) return;
    state.variantId = event.target.value;
    state.quantity = 1;
    history.replaceState(history.state, "", `/products/${encodeURIComponent(state.productId)}?v=${encodeURIComponent(state.variantId)}`);
    renderBuy();
  });

  // 商品頁中點首頁錨點（頁首選單、麵包屑、購物須知）要先回首頁再捲動到區塊。
  document.addEventListener("click", (event) => {
    const homeLink = event.target.closest("a[data-pp-home]") || (isActive() ? event.target.closest('a[href^="#"]') : null);
    if (homeLink && isActive()) {
      event.preventDefault();
      router.goHome(homeLink.dataset.ppHome ?? homeLink.getAttribute("href").slice(1));
      return;
    }
    // 商品卡的圖片與名稱也能進入商品頁。
    const cardTarget = event.target.closest(".product-card .product-image, .product-card h3");
    const variantId = cardTarget?.closest(".product-card")?.dataset.productId;
    const variant = variantId && deps.getProducts().find((item) => item.id === variantId);
    if (variant?.product_id) router.openProduct(variant.product_id, variant.id);
  });

  return {
    open: (productId, variantId) => router.openProduct(productId, variantId),
    sync: router.sync,
    isActive
  };
}
