// 前台型錄：商品列表與搜尋、首頁 Hero 輪播、商品頁入口與載入型錄。
import { escapeHtml, isPreorderItem, productAvailability, productMark, productPriceMarkup } from "./product-format.js";
import { productCardMarkup } from "./product-card.js";
import { loadMoreMarkup, showMore, visibleLimit } from "./catalog-paging.js";
import { mountHeroCarousel } from "./hero-carousel.js";
import { selectHeroSlides } from "./hero-slides.js";
import { showToast } from "./app-core.js";
import { productPage } from "./app.js";

export let products = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", icon: "🌀", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", icon: "⚔️", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

const grid = document.querySelector("#product-grid");
export const search = document.querySelector("#product-search");

const HERO_IMAGE_DECODE_TIMEOUT_MS = 1200;

let heroCarousel = null;
export function renderHeroSpotlight() {
  const spotlight = document.querySelector("#hero-product-spotlight");
  if (!spotlight) return;
  const slides = selectHeroSlides(products);
  if (slides.length) {
    heroCarousel?.destroy();
    heroCarousel = mountHeroCarousel(spotlight, slides);
    return;
  }
  renderSingleHeroSpotlight();
}
function renderSingleHeroSpotlight() {
  const visual = document.querySelector("#hero-product-visual");
  if (!visual) return;
  const product = products.find((item) => item.type === "現貨" && Number(item.stock || 0) > 0) || products.find((item) => Number(item.stock || 0) > 0) || products[0];
  const nameNode = document.querySelector("[data-hero-name]");
  const categoryNode = document.querySelector("[data-hero-category]");
  const availabilityNode = document.querySelector("[data-hero-availability]");
  const typeNode = document.querySelector("[data-hero-type]");
  const priceNode = document.querySelector("[data-hero-price]");
  const addButton = document.querySelector("[data-hero-add]");
  if (!product) {
    visual.innerHTML = '<div class="hero-placeholder"><span>玩具</span><small>目前沒有上架商品</small></div>';
    if (nameNode) nameNode.textContent = "等待下一個喜歡的";
    if (availabilityNode) availabilityNode.textContent = "暫無商品";
    if (addButton) { addButton.disabled = true; addButton.removeAttribute("data-hero-add"); addButton.textContent = "暫無商品"; }
    return;
  }
  const productName = product.product_name || product.name || "好頑選物";
  if (categoryNode) categoryNode.textContent = product.category || "好頑選物";
  if (availabilityNode) availabilityNode.textContent = productAvailability(product);
  if (typeNode) typeNode.textContent = `${product.category || "TOYS"} · ${product.type || "選物"}`;
  if (nameNode) nameNode.textContent = productName;
  if (priceNode) priceNode.innerHTML = productPriceMarkup(product);
  visual.innerHTML = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(productName)}" fetchpriority="high" decoding="async" />`
    : `<div class="hero-placeholder"><span>${productMark(product)}</span><small>${product.type === "現貨" ? "READY TO PLAY" : "COMING FROM AFAR"}</small></div>`;
  if (addButton) {
    const available = Number(product.stock || 0) > 0;
    addButton.dataset.heroAdd = product.id;
    addButton.disabled = !available;
    addButton.textContent = available ? "加入購物車" : "目前無庫存";
  }
}
// 分類篩選按鈕依型錄實際有的分類產生（依商品排序先後），後台新增分類後不用改 HTML
let activeCategory = "all";
const PREORDER_FILTER = "預購";
const filterLabel = (category) => category.replace(/^([A-Za-z0-9]+)(系列)$/, "$1 $2");

export function selectCategory(category) {
  activeCategory = category || "all";
  renderProducts();
}

function renderCategoryFilters() {
  const row = document.querySelector(".filter-row");
  if (!row) return;
  // 依後台分類排序（數字小的在前）；沒有排序資料時維持商品出現順序（sort 為穩定排序）
  const categoryOrder = new Map();
  for (const product of products) if (product.category && !categoryOrder.has(product.category)) categoryOrder.set(product.category, Number.isFinite(product.category_order) ? product.category_order : Infinity);
  const categories = [...categoryOrder.keys()].sort((left, right) => categoryOrder.get(left) - categoryOrder.get(right) || 0);
  const hasPreorder = products.some(isPreorderItem);
  const values = ["all", ...categories, ...(hasPreorder ? [PREORDER_FILTER] : [])];
  if (!values.includes(activeCategory)) activeCategory = "all";
  row.innerHTML = values.map((value) => {
    const label = value === "all" ? "全部" : value === PREORDER_FILTER ? PREORDER_FILTER : filterLabel(value);
    const count = value === "all" ? products.length : value === PREORDER_FILTER ? products.filter(isPreorderItem).length : products.filter((product) => product.category === value).length;
    return `<button class="filter${value === activeCategory ? " active" : ""}" type="button" data-category="${escapeHtml(value)}" aria-pressed="${value === activeCategory}">${escapeHtml(label)}<span class="filter-count" aria-label="${count} 件商品">${count}</span></button>`;
  }).join("");
}

// 「載入更多」區塊放在商品格下方（index.html 不用改）
function loadMoreSlot() {
  let slot = document.querySelector("[data-catalog-more-slot]");
  if (!slot && grid) {
    slot = document.createElement("div");
    slot.className = "catalog-more";
    slot.dataset.catalogMoreSlot = "";
    grid.after(slot);
    slot.addEventListener("click", (event) => {
      if (!event.target.closest("[data-catalog-more]")) return;
      renderProducts({ revealFrom: showMore() });
    });
  }
  return slot;
}

export function renderProducts({ revealFrom = 0 } = {}) {
  renderCategoryFilters();
  const keyword = search.value.trim().toLowerCase();
  const matches = products.filter((product) => (activeCategory === "all" || product.category === activeCategory || product.type === activeCategory) && `${product.category}${product.name}`.toLowerCase().includes(keyword));
  const shown = matches.slice(0, visibleLimit(`${activeCategory}|${keyword}`));
  grid.innerHTML = shown.length ? shown.map(productCardMarkup).join("") : "<p class=\"empty-state\">目前沒有符合的商品。</p>";
  // 剛載入的那批卡片淡入
  if (revealFrom > 0) {
    const revealed = [...grid.children].slice(revealFrom);
    revealed.forEach((card) => card.classList.add("is-revealed"));
    // 按鈕會被重畫掉：焦點移到第一張新商品卡，鍵盤使用者可以接著往下瀏覽（不捲動畫面）
    revealed[0]?.querySelector("a, button")?.focus({ preventScroll: true });
  }
  const slot = loadMoreSlot();
  if (slot) slot.innerHTML = loadMoreMarkup(shown.length, matches.length);
}

// 商品卡、推薦卡與輪播按鈕都以規格 ID 進入獨立商品頁。
export function openProductDetail(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  if (!product.product_id) return showToast("商品資料載入中，請稍後再試");
  productPage.open(product.product_id, product.id);
}

export async function loadProducts() {
  try {
    const response = await fetch("/api/catalog");
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.products) && payload.products.length) products = payload.products.map((product) => ({ ...product, link: product.seller_link, icon: product.category?.startsWith("BX") ? "🌀" : "⚔️" }));
  } catch {
    // 在純靜態預覽時保留示範資料。
  }
}

export function waitForHeroImageDecode(timeoutMs = HERO_IMAGE_DECODE_TIMEOUT_MS) {
  const image = document.querySelector("#hero-product-spotlight img");
  if (!image || !image.getAttribute("src")) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let onLoad = null;
    let onError = null;
    const finish = (decoded) => {
      if (settled) return;
      settled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      if (onLoad) image.removeEventListener("load", onLoad);
      if (onError) image.removeEventListener("error", onError);
      resolve(decoded);
    };
    timeoutId = window.setTimeout(() => finish(false), timeoutMs);
    if (typeof image.decode === "function") {
      // Prefer the browser's decode result when available. A load event can
      // fire before pixels are ready on mobile WebViews, so it must not win
      // over decode success, failure, or the timeout.
      try {
        image.decode().then(() => finish(true)).catch(() => finish(false));
      } catch {
        finish(false);
      }
      return;
    }
    onLoad = () => finish(true);
    onError = () => finish(false);
    if (image.complete) {
      finish(image.naturalWidth > 0);
      return;
    }
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
  });
}
