// 獨立訂單頁（/orders）：回傳 orders.html 時把執行設定（與 /api/config 相同）內嵌在 body 最後，
// 訂單頁開機直接讀取（public/embedded-config.js），不必等 /api/config 往返。
import { type Env } from "./env";
import { configDataScript, fetchHtmlAsset, isHtmlResponse, rewrittenHtmlResponse } from "./share-meta";

export function isOrdersPageRequest(request: Request, url: URL) {
  return request.method === "GET" && url.pathname === "/orders";
}

export async function withOrdersBootData(request: Request, env: Env): Promise<Response> {
  // 不帶條件式標頭：改了部署設定（例如訂單頁 LIFF ID）而 orders.html 沒變時，304 會讓瀏覽器沿用舊設定
  const assetResponse = await fetchHtmlAsset(request, env);
  if (!isHtmlResponse(assetResponse)) return assetResponse;
  const bootData = await configDataScript(env);
  const rewritten = new HTMLRewriter()
    // 放在 body 最後：orders-page.js 是 module，文件解析完才執行，讀得到這個區塊
    .on("body", { element(element) { element.append(bootData, { html: true }); } })
    .transform(assetResponse);
  return rewrittenHtmlResponse(rewritten);
}
