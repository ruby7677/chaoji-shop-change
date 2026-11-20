// 開機型錄：首頁 Worker 能及時取得型錄時，會把它內嵌在 HTML 最後（id="cj-catalog-data"，見 src/share-meta.ts），
// 並拿掉 <head> 的 <script type="module" async src="/catalog-prefetch.js">；此時本模組只由 app.js 的 import 載入，
// 執行時文件已解析完，直接讀內嵌資料，不發 /api/catalog（iPhone 上這個請求常要等 46 個 JS 載完才發出）。
// 沒有內嵌（Worker 等型錄逾時、靜態預覽）時維持舊做法：<head> 的 async module 下載完立即 fetch，
// storefront-catalog.js import 同一個網址的 module，瀏覽器只會執行一次，型錄只有一次真正的瀏覽器 fetch。
// 不用 <link rel="preload">：/api/catalog 是 no-store，iOS WebKit 不會沿用 preload，會再下載一次。
const CATALOG_DATA_ID = "cj-catalog-data";

function readEmbeddedCatalog() {
  const node = typeof document === "undefined" ? null : document.getElementById(CATALOG_DATA_ID);
  if (!node) return null;
  // 讀完就移除：資料只用一次，不留在 DOM 佔記憶體
  node.remove();
  return Promise.resolve(new Response(node.textContent, { headers: { "Content-Type": "application/json" } }));
}

const embedded = readEmbeddedCatalog();
/** 開機型錄的來源：內嵌在 HTML（inline）或另外請求（request）；給開機計時報告分辨用。 */
export const prefetchedCatalogSource = embedded ? "inline" : "request";
let pending = embedded || fetch("/api/catalog");
// 失敗交給 loadProducts 處理（顯示重新載入提示）；這裡先標記已處理，避免沒被取用時出現未處理的 rejection
pending.catch(() => {});

/** 第一次呼叫回傳開機時的型錄回應，之後回傳 null（後台改商品後重新載入要拿新資料）。 */
export function takePrefetchedCatalog() {
  const response = pending;
  pending = null;
  return response;
}
