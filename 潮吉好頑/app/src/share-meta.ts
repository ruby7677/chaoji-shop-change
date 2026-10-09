// 分享預覽：LINE、Facebook 等抓取網址時不執行 JavaScript，
// 因此由 Worker 回傳 index.html 時以 HTMLRewriter 寫入標題、描述與 Open Graph 標籤。
// 只讀取已上架商品（storefront_variants + anon key），查詢失敗時退回全站預設值，不影響頁面本身。
import { fetchWithTimeout } from "./http";
import { publicCatalog } from "./catalog";
import { type Env } from "./env";
import { firstHeroImageUrl } from "./hero-preload";
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
  image: "/og-share.jpg",
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

// 首頁型錄最多等這麼久（通常命中快取只需幾毫秒）；逾時只少了輪播圖預先載入，不拖慢首頁
const HOME_CATALOG_WAIT_MS = 150;

function isHomePage(url: URL) {
  return url.pathname === "/" || url.pathname === "/index.html";
}

// 型錄 API 一律預先載入（前端 fetch 預設 credentials 為 same-origin，對應 crossorigin=anonymous）；
// 能及時取得型錄時，再預先載入第一張輪播圖
// 型錄讀取會被之後的 /api/catalog 共用（isolate 內同一個 in-flight）：必須用 waitUntil 讓它在首頁回應送出後
// 仍能完成，否則讀取被中斷、in-flight 永遠不會結束，之後所有型錄請求都會卡住
export async function homePreloadMarkup(env: Env, url: URL, ctx?: ExecutionContext) {
  const catalog = publicCatalog(env, url.origin).catch(() => null);
  ctx?.waitUntil(catalog);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), HOME_CATALOG_WAIT_MS));
  const products = await Promise.race([catalog, timeout]);
  const image = products ? firstHeroImageUrl(products) : null;
  // 圖片在 R2 公開網域時先建立連線，第一張輪播圖與商品縮圖不必再等 DNS／TLS
  const origin = imageOrigin(env);
  return '<link rel="preload" href="/api/catalog" as="fetch" crossorigin="anonymous" />'
    + (origin ? `<link rel="preconnect" href="${escapeAttribute(origin)}" />` : "")
    + (image ? `<link rel="preload" href="${escapeAttribute(image)}" as="image" fetchpriority="high" />` : "");
}

export function isShareMetaRequest(request: Request, url: URL) {
  if (request.method !== "GET") return false;
  return url.pathname === "/" || url.pathname === "/index.html" || PRODUCT_PAGE.test(url.pathname);
}

export async function withShareMeta(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  // 不帶條件式標頭向 ASSETS 取 index.html：所有商品頁共用同一個 ETag，
  // 若回 304 瀏覽器會沿用其他商品（或舊名稱）的標籤。
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const assetResponse = await env.ASSETS.fetch(new Request(request.url, { method: "GET", headers }));
  if (!assetResponse.ok || !(assetResponse.headers.get("Content-Type") || "").includes("text/html")) return assetResponse;

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
  const preloadMarkup = isHomePage(url) ? await homePreloadMarkup(env, url, ctx) : "";

  const rewritten = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", meta.description); } })
    .on("head", { element(element) {
      element.append(headMarkup, { html: true });
    } })
    // 預先載入緊接在 charset 之後，比 CSS 更早被瀏覽器發現
    .on("meta[charset]", { element(element) { if (preloadMarkup) element.after(preloadMarkup, { html: true }); } })
    .transform(assetResponse);
  const responseHeaders = new Headers(rewritten.headers);
  responseHeaders.delete("ETag");
  responseHeaders.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(rewritten.body, { status: rewritten.status, headers: responseHeaders });
}
