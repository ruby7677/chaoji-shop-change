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
    if (productId) return onProduct(productId, variantFromLocation());
    // 有記錄離開時的捲動位置就回原位；網址的錨點只在沒有記錄時使用（例如直接開啟 /#quick-pick）。
    const scrollY = history.state?.homeScrollY;
    onHome({ scrollY, hash: Number.isFinite(scrollY) ? "" : location.hash.slice(1) });
  }

  function openProduct(productId, variantId = null) {
    const current = productIdFromLocation();
    // 離開首頁前把捲動位置記在首頁這筆歷史紀錄，按「上一頁」時還原。
    if (!current) history.replaceState({ ...(history.state || {}), homeScrollY: window.scrollY }, "");
    const url = `/products/${encodeURIComponent(productId)}${variantId ? `?v=${encodeURIComponent(variantId)}` : ""}`;
    if (current === productId) {
      history.replaceState(history.state, "", url);
      onProduct(productId, variantId);
      return;
    }
    // homeDepth：這筆商品頁距離首頁列表幾筆歷史紀錄（從列表點進來為 1，再點推薦商品累加）；直接開分享連結則沒有。
    const fromDepth = current ? history.state?.homeDepth : 0;
    history.pushState(Number.isInteger(fromDepth) ? { view: "product", homeDepth: fromDepth + 1 } : { view: "product" }, "", url);
    onProduct(productId, variantId);
  }

  // 從列表進來的商品頁：退回列表那筆紀錄，由 popstate 還原離開時的捲動位置；直接開啟的商品頁回傳 false。
  function backToList() {
    const depth = history.state?.homeDepth;
    if (!Number.isInteger(depth) || depth < 1) return false;
    history.go(-depth);
    return true;
  }

  function goHome(hash = "") {
    history.pushState({ view: "home" }, "", `/${hash ? `#${hash}` : ""}`);
    onHome({ hash, scrollY: 0 });
  }

  window.addEventListener("popstate", sync);
  return { sync, openProduct, goHome, backToList };
}
