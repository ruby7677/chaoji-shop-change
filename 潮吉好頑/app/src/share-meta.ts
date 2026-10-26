// 分享預覽：LINE、Facebook 等抓取網址時不執行 JavaScript，
// 因此由 Worker 回傳 index.html 時以 HTMLRewriter 寫入標題、描述與 Open Graph 標籤。
// 只讀取已上架商品（storefront_variants + anon key），查詢失敗時退回全站預設值，不影響頁面本身。
import { fetchWithTimeout } from "./http";
import { publicCatalogBoot, runtimeConfig } from "./catalog";
import { type Env } from "./env";
import { imageOrigin, primaryImageUrls } from "./product-image-urls";

export interface ShareMetaEnv {
  ASSETS: Fetcher;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  IMAGE_BASE_URL?: string;
}

type ShareMeta = { title: string; description: string; image: string; type: "website" | "product" };

const PRODUCT_PAGE = /^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const SITE_NAME = "潮吉好頑";
// 預設分享圖 1200×630（約 50KB，LINE／Facebook 建議比例）；商品頁改用商品主圖
const DEFAULT_META: ShareMeta = {
  title: "潮吉好頑｜好頑玩具選物",
  description: "潮吉好頑｜玩具、公仔、戰鬥陀螺選物。現貨先選，預購先保留。",
  image: "/og-share-2.jpg",
  type: "website"
};
const DESCRIPTION_MAX = 110;

function escapeAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summarize(text: string | null | undefined) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1)}…` : flat;
}

async function productMeta(env: ShareMetaEnv, productId: string): Promise<ShareMeta | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=product_name,description,has_image,image_path,image_updated_at&product_id=eq.${productId}&is_published=eq.true&order=display_order.desc,id.desc&limit=1`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) return null;
  const rows = await response.json() as Array<{ product_name?: string; description?: string | null; has_image?: boolean; image_path?: string | null; image_updated_at?: string | null }>;
  const row = rows[0];
  if (!row?.product_name) return null;
  return {
    title: `${row.product_name}｜${SITE_NAME}`,
    description: summarize(row.description) || DEFAULT_META.description,
    image: (row.has_image && primaryImageUrls(env, productId, row.image_path, row.image_updated_at)?.image_url) || DEFAULT_META.image,
    type: "product"
  };
}

// 首頁型錄最多等這麼久（通常命中快取只需幾毫秒）；逾時不拖慢首頁，只是少了輪播圖預先載入與內嵌型錄
// （前台改由 catalog-prefetch.js 另外請求 /api/catalog，遮罩要多等這個請求）
const HOME_CATALOG_WAIT_MS = 150;
// 內嵌型錄的資料區塊 id；public/catalog-prefetch.js 讀取同一個 id
export const CATALOG_DATA_ID = "cj-catalog-data";
// 內嵌執行設定（與 /api/config 相同）的資料區塊 id；public/embedded-config.js 讀取同一個 id
export const CONFIG_DATA_ID = "cj-config-data";

function isHomePage(url: URL) {
  return url.pathname === "/" || url.pathname === "/index.html";
}

/**
 * 內嵌 JSON（型錄、執行設定）：放在不會執行的資料區塊。型錄的商品名稱與說明是後台輸入的，
 * 所有「<」都轉成 JSON 跳脫字元 \u003c，內容裡的 </script>、<!-- 不會提早結束區塊（JSON.parse 會還原成「<」）。
 */
export function jsonDataScript(id: string, value: unknown) {
  const data = JSON.stringify(value).replace(/</g, "\\u003c");
  return `<script type="application/json" id="${id}">${data}</script>`;
}

/** 內嵌型錄（與 /api/catalog 相同的 JSON）：catalog.ts 的 publicCatalogBoot 已轉好且「<」已跳脫，直接放進資料區塊，不再逐次轉字串。 */
export function embeddedCatalogScript(embedText: string) {
  return `<script type="application/json" id="${CATALOG_DATA_ID}">${embedText}</script>`;
}

/** 內嵌執行設定：只來自部署設定（不查資料庫），隨時可得，所以首頁、商品頁與訂單頁（src/orders-page.ts）都內嵌，省掉開機時的 /api/config。 */
export async function configDataScript(env: Env) {
  return jsonDataScript(CONFIG_DATA_ID, await runtimeConfig(env));
}

// 首頁開機資料：能及時取得型錄時，預先載入第一張輪播圖並內嵌型錄（手機不必等 JS 載完才另外請求 /api/catalog）。
// 型錄 API 本身不用 preload：它是 no-store，iOS WebKit 不會沿用而再下載一次。
// 型錄讀取會被之後的 /api/catalog 共用（isolate 內同一個 in-flight）：必須用 waitUntil 讓它在首頁回應送出後
// 仍能完成，否則讀取被中斷、in-flight 永遠不會結束，之後所有型錄請求都會卡住
export async function homeBootMarkup(env: Env, url: URL, ctx?: ExecutionContext) {
  const catalog = publicCatalogBoot(env, url.origin).catch(() => null);
  ctx?.waitUntil(catalog);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), HOME_CATALOG_WAIT_MS));
  const boot = await Promise.race([catalog, timeout]);
  const image = boot?.heroImage ?? null;
  // 圖片在 R2 公開網域時先建立連線，第一張輪播圖與商品縮圖不必再等 DNS／TLS
  const origin = imageOrigin(env);
  const preload = (origin ? `<link rel="preconnect" href="${escapeAttribute(origin)}" />` : "")
    + (image ? `<link rel="preload" href="${escapeAttribute(image)}" as="image" fetchpriority="high" />` : "");
  return { preload, catalogData: boot ? embeddedCatalogScript(boot.embedText) : "" };
}

export async function homePreloadMarkup(env: Env, url: URL, ctx?: ExecutionContext) {
  return (await homeBootMarkup(env, url, ctx)).preload;
}

// LINE SDK：與 public/liff-auth.js 的 LIFF_SDK_URL 相同（Worker 不能 import public/，tests/worker/liff-sdk-preload.test.mjs 比對）
export const LIFF_SDK_URL = "https://static.line-scdn.net/liff/edge/2/sdk.js";
const LIFF_CALLBACK_PARAM = "cj_liff_oauth";

/**
 * 從 LIFF 開啟時才預先載入 LINE SDK：前台要等整棵 app.js import 樹執行完才呼叫 preloadLiffSdk()，
 * 寫在 HTML 裡解析時就開始下載。判斷依據是 LIFF 的網址參數（liff.state 等）、LINE 登入回呼標記，
 * 或 LIFF 瀏覽器 UA 的「LIFF」字樣（非官方規格，只當效能提示；判斷錯只是多或少一次預載，登入流程不依賴它）。
 * 一般瀏覽器與 LINE 內建瀏覽器開一般連結不下載 SDK。crossorigin 要與 liff-auth.js 建立的 <script> 一致才會沿用。
 */
export function liffSdkPreloadMarkup(request: Request, url: URL) {
  const fromLiff = [...url.searchParams.keys()].some((key) => key.startsWith("liff.") || key === LIFF_CALLBACK_PARAM)
    || /\bLIFF\b/.test(request.headers.get("User-Agent") || "");
  return fromLiff ? `<link rel="preload" href="${LIFF_SDK_URL}" as="script" crossorigin="anonymous" />` : "";
}

export function isShareMetaRequest(request: Request, url: URL) {
  if (request.method !== "GET") return false;
  return url.pathname === "/" || url.pathname === "/index.html" || PRODUCT_PAGE.test(url.pathname);
}

/**
 * 向 ASSETS 取要改寫的 HTML：不帶條件式標頭。改寫結果依頁面與部署設定而定，靜態檔沒變時
 * 回 304 會讓瀏覽器沿用改寫前、別頁（所有商品頁共用同一個 ETag）或舊設定的內容。
 */
export function fetchHtmlAsset(request: Request, env: Pick<ShareMetaEnv, "ASSETS">) {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  return env.ASSETS.fetch(new Request(request.url, { method: "GET", headers }));
}

export function isHtmlResponse(response: Response) {
  return response.ok && (response.headers.get("Content-Type") || "").includes("text/html");
}

/** 改寫後的 HTML：拿掉靜態檔的 ETag（內容已不同），每次向伺服器確認。 */
export function rewrittenHtmlResponse(rewritten: Response) {
  const headers = new Headers(rewritten.headers);
  headers.delete("ETag");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(rewritten.body, { status: rewritten.status, headers });
}

export async function withShareMeta(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const assetResponse = await fetchHtmlAsset(request, env);
  if (!isHtmlResponse(assetResponse)) return assetResponse;

  let meta = DEFAULT_META;
  const productMatch = url.pathname.match(PRODUCT_PAGE);
  if (productMatch) {
    try { meta = (await productMeta(env, productMatch[1])) || DEFAULT_META; }
    catch { meta = DEFAULT_META; }
  }
  const canonical = `${url.origin}${url.pathname === "/index.html" ? "/" : url.pathname}`;
  const tags: Array<[string, string, string]> = [
    ["property", "og:type", meta.type],
    ["property", "og:site_name", SITE_NAME],
    ["property", "og:locale", "zh_TW"],
    ["property", "og:title", meta.title],
    ["property", "og:description", meta.description],
    ["property", "og:url", canonical],
    ["property", "og:image", new URL(meta.image, url.origin).toString()],
    ["name", "twitter:card", "summary_large_image"]
  ];
  const headMarkup = tags.map(([attribute, name, content]) => `<meta ${attribute}="${name}" content="${escapeAttribute(content)}" />`).join("")
    + `<link rel="canonical" href="${escapeAttribute(canonical)}" />`;
  const { preload: preloadMarkup, catalogData } = isHomePage(url) ? await homeBootMarkup(env, url, ctx) : { preload: "", catalogData: "" };
  const bootData = (await configDataScript(env)) + catalogData;
  const liffPreload = liffSdkPreloadMarkup(request, url);

  const rewritten = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", meta.description); } })
    .on("head", { element(element) {
      element.append(headMarkup, { html: true });
    } })
    // 預先載入緊接在 charset 之後，比 CSS 更早被瀏覽器發現
    .on("meta[charset]", { element(element) { if (preloadMarkup || liffPreload) element.after(liffPreload + preloadMarkup, { html: true }); } })
    // 已內嵌型錄：拿掉 <head> 的提早請求；catalog-prefetch.js 仍由 app.js 的 import 載入，執行時（文件已解析完）改讀內嵌資料
    .on('script[src="/catalog-prefetch.js"]', { element(element) { if (catalogData) element.remove(); } })
    // 放在 body 最後：不擋開機畫面先出現；app.js 是 module，文件解析完才執行，讀得到這個區塊
    .on("body", { element(element) { element.append(bootData, { html: true }); } })
    .transform(assetResponse);
  const response = rewrittenHtmlResponse(rewritten);
  // 是否預載 LINE SDK 依 UA 而定
  response.headers.append("Vary", "User-Agent");
  return response;
}
