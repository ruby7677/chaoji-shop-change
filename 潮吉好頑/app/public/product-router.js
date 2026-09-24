// 商品頁路由：以 History API 使用 /products/:productId（不可用 hash，LINE 登入會在 hash 帶 token）。
// Worker 已設定 SPA fallback，直接開啟商品網址也會回 index.html。

const PRODUCT_PATH = /^\/products\/([^/?#]+)\/?$/;

export function productIdFromLocation() {
  const match = location.pathname.match(PRODUCT_PATH);
  return match ? decodeURIComponent(match[1]) : null;
}

function variantFromLocation() {
  return new URLSearchParams(location.search).get("v");
}

export function createProductRouter({ onProduct, onHome }) {
  function sync() {
    const productId = productIdFromLocation();
    if (productId) onProduct(productId, variantFromLocation());
    else onHome({ scrollY: history.state?.homeScrollY, hash: location.hash.slice(1) });
  }

  function openProduct(productId, variantId = null) {
    const current = productIdFromLocation();
    // 離開首頁前把捲動位置記在首頁這筆歷史紀錄，按「上一頁」時還原。
    if (!current) history.replaceState({ ...(history.state || {}), homeScrollY: window.scrollY }, "");
    const url = `/products/${encodeURIComponent(productId)}${variantId ? `?v=${encodeURIComponent(variantId)}` : ""}`;
    if (current === productId) history.replaceState(history.state, "", url);
    else history.pushState({ view: "product" }, "", url);
    onProduct(productId, variantId);
  }

  function goHome(hash = "") {
    history.pushState({ view: "home" }, "", `/${hash ? `#${hash}` : ""}`);
    onHome({ hash, scrollY: 0 });
  }

  window.addEventListener("popstate", sync);
  return { sync, openProduct, goHome };
}
