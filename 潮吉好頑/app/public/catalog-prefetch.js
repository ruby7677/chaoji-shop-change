// 開機型錄提早請求：index.html 以 <script type="module" async> 在 <head> 載入，下載完立即發出 /api/catalog，
// 不必等 app.js 的整個 import 樹（約 44 個 module）載完。storefront-catalog.js import 同一個網址的 module，
// 瀏覽器只會執行一次，所以拿到的就是這個請求：型錄只有一次真正的瀏覽器 fetch。
// 取代原本的 <link rel="preload">：/api/catalog 是 no-store，iOS WebKit 不會沿用 preload，會再下載一次。
let pending = fetch("/api/catalog");
// 失敗交給 loadProducts 處理（顯示重新載入提示）；這裡先標記已處理，避免沒被取用時出現未處理的 rejection
pending.catch(() => {});

/** 第一次呼叫回傳開機時的請求，之後回傳 null（後台改商品後重新載入要拿新資料）。 */
export function takePrefetchedCatalog() {
  const response = pending;
  pending = null;
  return response;
}
