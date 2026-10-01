// 分享預覽：LINE、Facebook 等抓取網址時不執行 JavaScript，
// 因此由 Worker 回傳 index.html 時以 HTMLRewriter 寫入標題、描述與 Open Graph 標籤。
// 只讀取已上架商品（storefront_variants + anon key），查詢失敗時退回全站預設值，不影響頁面本身。
import { fetchWithTimeout } from "./http";

export interface ShareMetaEnv {
  ASSETS: Fetcher;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

type ShareMeta = { title: string; description: string; image: string; type: "website" | "product" };

const PRODUCT_PAGE = /^\/products\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const SITE_NAME = "潮吉好頑";
const DEFAULT_META: ShareMeta = {
  title: "潮吉好頑｜好頑玩具選物",
  description: "潮吉好頑｜玩具、公仔、戰鬥陀螺選物。現貨先選，預購先保留。",
  image: "/Logo.png",
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
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=product_name,description,has_image,image_updated_at&product_id=eq.${productId}&is_published=eq.true&order=display_order.desc,id.desc&limit=1`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) return null;
  const rows = await response.json() as Array<{ product_name?: string; description?: string | null; has_image?: boolean; image_updated_at?: string | null }>;
  const row = rows[0];
  if (!row?.product_name) return null;
  return {
    title: `${row.product_name}｜${SITE_NAME}`,
    description: summarize(row.description) || DEFAULT_META.description,
    image: row.has_image ? `/api/product-images/${productId}?v=${encodeURIComponent(row.image_updated_at || "1")}` : DEFAULT_META.image,
    type: "product"
  };
}

export function isShareMetaRequest(request: Request, url: URL) {
  if (request.method !== "GET") return false;
  return url.pathname === "/" || url.pathname === "/index.html" || PRODUCT_PAGE.test(url.pathname);
}

export async function withShareMeta(request: Request, env: ShareMetaEnv, url: URL): Promise<Response> {
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

  const rewritten = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(element) { element.setAttribute("content", meta.description); } })
    .on("head", { element(element) { element.append(headMarkup, { html: true }); } })
    .transform(assetResponse);
  const responseHeaders = new Headers(rewritten.headers);
  responseHeaders.delete("ETag");
  responseHeaders.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(rewritten.body, { status: rewritten.status, headers: responseHeaders });
}
