// 商品頁增強（ADMIN_REDESIGN_PLAN Stage 5）：限時優惠標籤、折扣百分比、「優惠價」捷徑與優惠篩選。
// 只在 renderAdminProducts 產生的 DOM 上加標記；價格仍由原規格表單（compare_at_price）儲存。
import { adminIcon } from "./admin-icons.js";

let list = null;
let saleOnly = false;
let filterButton = null;

function discountOf(variantCard) {
  const was = variantCard.querySelector(".admin-price-discount s")?.textContent;
  const now = variantCard.querySelector(".admin-price-discount b")?.textContent;
  const toNumber = (text) => Number(String(text || "").replace(/[^\d]/g, ""));
  const before = toNumber(was);
  const after = toNumber(now);
  return before > after && after > 0 ? Math.round((1 - after / before) * 100) : 0;
}

function enhanceVariant(variantCard) {
  if (variantCard.dataset.adminEnhanced) return;
  variantCard.dataset.adminEnhanced = "true";
  const summary = variantCard.querySelector("summary .variant-summary");
  if (!summary) return;
  const percent = discountOf(variantCard);
  if (percent) summary.insertAdjacentHTML("afterbegin", `<em class="admin-chip admin-chip-sale">限時優惠 −${percent}%</em>`);
  const shortcut = document.createElement("button");
  shortcut.type = "button";
  shortcut.className = "admin-price-shortcut";
  shortcut.dataset.adminPriceShortcut = "";
  shortcut.innerHTML = `${adminIcon("tag")}<span>優惠價</span>`;
  shortcut.setAttribute("aria-label", `設定 ${variantCard.querySelector(".variant-identity b")?.textContent || "此規格"} 的原價與限時優惠`);
  summary.append(shortcut);
}

function enhanceProduct(card) {
  card.querySelectorAll(".admin-variant-card").forEach(enhanceVariant);
  const onSale = Boolean(card.querySelector(".admin-price-discount"));
  card.classList.toggle("is-on-sale", onSale);
  const labels = card.querySelector(".admin-product-labels");
  if (onSale && labels && !labels.querySelector(".admin-chip-sale")) labels.insertAdjacentHTML("beforeend", '<span class="admin-chip admin-chip-sale">限時優惠</span>');
}

function applyFilter() {
  const cards = [...list.querySelectorAll(".admin-product-card")];
  const saleCount = cards.filter((card) => card.classList.contains("is-on-sale")).length;
  cards.forEach((card) => card.classList.toggle("hidden-by-sale-filter", saleOnly && !card.classList.contains("is-on-sale")));
  if (filterButton) {
    filterButton.textContent = `只看限時優惠（本頁 ${saleCount}）`;
    filterButton.setAttribute("aria-pressed", String(saleOnly));
  }
}

function ensureFilterButton() {
  if (filterButton?.isConnected) return;
  const toolbar = document.querySelector(".admin-product-toolbar");
  if (!toolbar) return;
  filterButton = document.createElement("button");
  filterButton.type = "button";
  filterButton.className = "admin-sale-filter";
  filterButton.dataset.adminSaleFilter = "";
  toolbar.append(filterButton);
}

function enhanceAll() {
  list.querySelectorAll(".admin-product-card").forEach(enhanceProduct);
  ensureFilterButton();
  applyFilter();
}

function openPriceEditor(button) {
  const details = button.closest(".admin-variant-card");
  if (!details) return;
  details.open = true;
  // 原價欄由 renderAdminProducts 動態插入，展開後聚焦並捲入視野
  const input = details.querySelector("input[name='compare_at_price']") || details.querySelector("input[name='price']");
  input?.focus();
  input?.scrollIntoView({ block: "center", behavior: "smooth" });
}

export function initAdminProductsUI() {
  if (list) return;
  list = document.querySelector("#admin-product-list");
  if (!list) return;
  new MutationObserver(enhanceAll).observe(list, { childList: true });
  document.addEventListener("click", (event) => {
    const shortcut = event.target.closest("[data-admin-price-shortcut]");
    if (shortcut) {
      // 按鈕位於 <summary> 內，阻止預設的展開／收合切換，改為固定展開
      event.preventDefault();
      openPriceEditor(shortcut);
      return;
    }
    if (event.target.closest("[data-admin-sale-filter]")) {
      saleOnly = !saleOnly;
      applyFilter();
    }
  });
  enhanceAll();
}
