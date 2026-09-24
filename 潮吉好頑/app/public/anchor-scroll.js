// 頁內錨點捲動：依固定導航列「實際高度」計算落點，讓目標停在導航列下方。
// 不依賴 CSS scroll-margin-top（iOS Safari 對錨點跳轉的處理與 Chrome 不一致，店主手機實測會停錯位置）。
const GAP_BELOW_HEADER = 20;

function headerHeight() {
  return document.querySelector(".site-header")?.getBoundingClientRect().height || 0;
}

function scrollBehavior(smooth) {
  return smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant";
}

// id 為空或 "top" 時回到頁面最頂端；找不到目標回傳 false，交給瀏覽器預設行為。
export function scrollToAnchor(id, { smooth = true } = {}) {
  const behavior = scrollBehavior(smooth);
  if (!id || id === "top") {
    window.scrollTo({ top: 0, behavior });
    return true;
  }
  const target = document.getElementById(id);
  if (!target) return false;
  const top = target.getBoundingClientRect().top + window.scrollY - headerHeight() - GAP_BELOW_HEADER;
  window.scrollTo({ top: Math.max(0, top), behavior });
  return true;
}

export function initAnchorScroll() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // 商品頁中的首頁錨點由 product-page.js 處理（先回首頁再捲動）。
    if (document.body.classList.contains("is-product-view")) return;
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const id = decodeURIComponent(link.getAttribute("href").slice(1));
    if (id !== "top" && (!id || !document.getElementById(id))) return;
    event.preventDefault();
    history.pushState(history.state, "", id === "top" ? `${location.pathname}${location.search}` : `#${id}`);
    scrollToAnchor(id);
  });
}
