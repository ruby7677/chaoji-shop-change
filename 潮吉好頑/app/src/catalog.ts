// 前台型錄與前端 runtime config（商品主圖路由與上傳在 product-image-primary.ts）。
import { type Env, type Product } from "./env";
import { primaryImageUrls } from "./product-image-urls";
import { deleteEdgeCatalog, readEdgeCatalog, writeEdgeCatalog } from "./catalog-edge-cache";
import { fetchWithTimeout, serviceHeaders } from "./http";

const demoProducts: Product[] = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

// 前台型錄放 Worker isolate 內的記憶體快取：TTL 30 秒，
// 併發請求共用同一個 in-flight promise，讀取失敗不快取。回應給瀏覽器的 Cache-Control 仍是 no-store，
// 這個快取只影響 Worker 內部是否重打 Supabase。
const CATALOG_CACHE_TTL_MS = 30_000;
let catalogCache: { data: Product[]; expiresAt: number } | null = null;
let catalogInflight: Promise<Product[]> | null = null;
// 失效時遞增：失效前就開始的讀取完成後不可把舊資料寫回快取
let catalogGeneration = 0;

/** 任何會改變前台型錄資料的寫入成功後呼叫（並 await），強制下一次 publicCatalog() 重新讀取，也清除本機房的邊緣快取。 */
export async function invalidateCatalogCache(request?: Request): Promise<void> {
  catalogGeneration += 1;
  catalogCache = null;
  catalogInflight = null;
  await deleteEdgeCatalog(request ? new URL(request.url).origin : undefined);
}

// 分類排序（anon 沒有 display_order 欄位權限，用 service role 只讀名稱與排序）；
// 讀取失敗不影響型錄，前台會退回依商品出現順序排列系列按鈕。
async function loadCategoryOrder(env: Env): Promise<Map<string, number>> {
  const order = new Map<string, number>();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return order;
  try {
    const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/categories?select=name,display_order`, { headers: serviceHeaders(env) });
    if (!response.ok) return order;
    for (const row of await response.json() as Array<{ name: string; display_order: number | null }>) order.set(row.name, Number(row.display_order ?? 0));
  } catch { /* 逾時或網路錯誤：維持空排序 */ }
  return order;
}

async function loadPublicCatalog(env: Env): Promise<Product[]> {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id,category,name,price,compare_at_price,stock,type,preorder_arrival,seller_link,display_order,product_id,has_image,image_path,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible,hero_rank,hero_tagline,image_width,image_height&is_published=eq.true&order=display_order.desc,id.desc`, {
    headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error("Unable to load catalog");
  const rows = await response.json() as Array<Product & { has_image?: boolean; image_path?: string | null; image_updated_at?: string; image_width?: number | null; image_height?: number | null }>;
  const categoryOrder = await loadCategoryOrder(env);
  return rows.map(({ has_image, image_path, image_updated_at, image_width, image_height, ...product }) => {
    const urls = has_image && product.product_id ? primaryImageUrls(env, product.product_id, image_path, image_updated_at) : null;
    return {
      ...product,
      ...(categoryOrder.has(product.category) ? { category_order: categoryOrder.get(product.category) } : {}),
      image_url: urls?.image_url,
      thumb_url: urls?.thumb_url,
      ...(urls && image_width && image_height ? { image_width, image_height } : {})
    };
  });
}

/** origin：請求網址的來源，提供時多一層同機房共用的邊緣快取（見 catalog-edge-cache.ts）。 */
export async function publicCatalog(env: Env, origin?: string): Promise<Product[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoProducts;
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.data;
  if (catalogInflight) return catalogInflight;
  const generation = catalogGeneration;
  const load = async () => {
    const edge = origin ? await readEdgeCatalog(origin) : null;
    if (edge) return edge;
    const loadedAt = Date.now();
    const data = await loadPublicCatalog(env);
    // 讀取期間若已失效，不把可能過期的資料寫進邊緣快取（跨 isolate 的失效由 loadedAt 與失效時間比對）
    if (origin && generation === catalogGeneration) await writeEdgeCatalog(origin, data, loadedAt);
    return data;
  };
  const inflight = load().then((data) => {
    if (generation === catalogGeneration) {
      catalogCache = { data, expiresAt: Date.now() + CATALOG_CACHE_TTL_MS };
      catalogInflight = null;
    }
    return data;
  }).catch((error) => {
    if (generation === catalogGeneration) catalogInflight = null;
    throw error;
  });
  catalogInflight = inflight;
  return inflight;
}

export async function runtimeConfig(env: Env) {
  const provider = env.SUPABASE_CUSTOM_PROVIDER ?? "custom:line-web";
  // Supabase's public /auth/v1/settings response only reports built-in
  // providers; Custom OAuth/OIDC providers are not included in `external`.
  const lineEnabled = env.LINE_AUTH_ENABLED === "true";
  return {
    supabaseUrl: env.SUPABASE_URL ?? null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? null,
    lineProvider: provider,
    authEnabled: lineEnabled,
    liffId: env.LIFF_ID ?? null,
    liffEnabled: Boolean(env.LIFF_ID && env.LINE_LOGIN_CHANNEL_ID),
    ordersLiffId: env.ORDERS_LIFF_ID || null,
    // 後台縮圖與多圖預覽用；空值代表圖片仍走 Worker 路由
    imageBaseUrl: (env.IMAGE_BASE_URL || "").trim().replace(/\/+$/, "") || null,
    adminIdentityMode: "line_user_id+is_admin"
  };
}
