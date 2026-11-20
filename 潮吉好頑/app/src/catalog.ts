// 前台型錄與前端 runtime config（商品主圖路由與上傳在 product-image-primary.ts）。
import { type Env, type Product } from "./env";
import { primaryImageUrls } from "./product-image-urls";
import { deleteEdgeCatalog, readEdgeCatalogEntry, writeEdgeCatalog } from "./catalog-edge-cache";
import { firstHeroImageUrl } from "./hero-preload";
import { fetchWithTimeout, serviceHeaders } from "./http";

const demoProducts: Product[] = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨" }
];

// 前台型錄放 Worker isolate 內的記憶體快取：TTL 30 秒，
// 併發請求共用同一個 in-flight promise，讀取失敗不快取。回應給瀏覽器的 Cache-Control 仍是 no-store，
// 這個快取只影響 Worker 內部是否重打 Supabase。
const CATALOG_CACHE_TTL_MS = 30_000;
// 快取的是「型錄快照」：物件與 JSON 文字各自惰性產生一次。首頁要物件、/api/catalog 要文字，
// 從邊緣快取讀到文字時 /api/catalog 不必解析再轉回字串，從 Supabase 讀到物件時文字也只轉一次。
// 首頁另需第一張輪播圖與「<」已跳脫的內嵌文字：一樣惰性產生並記住，30 秒內的首頁請求不再逐次轉字串。
// 邊緣快取有記錄輪播圖時（heroImage 不是 undefined），首頁完全不必解析型錄。
type CatalogSnapshot = { products: () => Product[]; text: () => string; heroImage: () => string | null; embedText: () => string };
function snapshot(init: { products?: Product[]; text?: string; heroImage?: string | null }): CatalogSnapshot {
  let products = init.products;
  let text = init.text;
  let heroImage = init.heroImage;
  let embedText: string | undefined;
  const self: CatalogSnapshot = {
    products: () => (products ??= JSON.parse(text as string) as Product[]),
    text: () => (text ??= JSON.stringify(products)),
    heroImage: () => (heroImage === undefined ? (heroImage = firstHeroImageUrl(self.products())) : heroImage),
    embedText: () => (embedText ??= `{"products":${self.text()}}`.replace(/</g, "\\u003c"))
  };
  return self;
}
const demoSnapshot = snapshot({ products: demoProducts });
let catalogCache: { data: CatalogSnapshot; expiresAt: number } | null = null;
let catalogInflight: Promise<CatalogSnapshot> | null = null;
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

const ALL_DELIVERY_METHODS = ["store_pickup", "cvs_delivery", "home_delivery"];
// 型錄瘦身：三種取貨方式全開時不送（前台 cart-delivery-rules.js 缺欄位即視為全開），
// 縮圖網址也不送（前台 product-image-src.js 的 thumbnailUrlFor 由主圖網址推回）；賣貨便已停用，不讀 seller_link。
function deliveryMethodsField(methods: string[] | undefined) {
  return Array.isArray(methods) && ALL_DELIVERY_METHODS.every((method) => methods.includes(method)) ? {} : { allowed_delivery_methods: methods };
}

async function loadPublicCatalog(env: Env): Promise<Product[]> {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id,category,name,price,compare_at_price,stock,type,preorder_arrival,display_order,product_id,has_image,image_path,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible,allowed_delivery_methods,hero_rank,hero_tagline,image_width,image_height,show_stock,image_id&is_published=eq.true&order=display_order.desc,id.desc`, {
    headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error("Unable to load catalog");
  const rows = await response.json() as Array<Product & { has_image?: boolean; image_path?: string | null; image_updated_at?: string; image_width?: number | null; image_height?: number | null; image_id?: string | null }>;
  const categoryOrder = await loadCategoryOrder(env);
  return rows.map(({ has_image, image_path, image_updated_at, image_width, image_height, allowed_delivery_methods, image_id, ...product }) => {
    const urls = has_image && product.product_id ? primaryImageUrls(env, product.product_id, image_path, image_updated_at) : null;
    return {
      ...product,
      ...deliveryMethodsField(allowed_delivery_methods),
      ...(categoryOrder.has(product.category) ? { category_order: categoryOrder.get(product.category) } : {}),
      image_url: urls?.image_url,
      // 規格指定的商品多圖（商品頁切換規格時跳到該張）；沒指定時不送，型錄維持精簡
      ...(image_id ? { image_id } : {}),
      ...(urls && image_width && image_height ? { image_width, image_height } : {})
    };
  });
}

async function catalogSnapshot(env: Env, origin?: string): Promise<CatalogSnapshot> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoSnapshot;
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.data;
  if (catalogInflight) return catalogInflight;
  const generation = catalogGeneration;
  const load = async () => {
    const edge = origin ? await readEdgeCatalogEntry(origin) : null;
    if (edge !== null) return snapshot(edge);
    const loadedAt = Date.now();
    const data = snapshot({ products: await loadPublicCatalog(env) });
    // 讀取期間若已失效，不把可能過期的資料寫進邊緣快取（跨 isolate 的失效由 loadedAt 與失效時間比對）
    if (origin && generation === catalogGeneration) await writeEdgeCatalog(origin, data.text(), loadedAt, data.heroImage());
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

/** origin：請求網址的來源，提供時多一層同機房共用的邊緣快取（見 catalog-edge-cache.ts）。 */
export async function publicCatalog(env: Env, origin?: string): Promise<Product[]> {
  return (await catalogSnapshot(env, origin)).products();
}

/** /api/catalog 的回應本文：與 JSON.stringify({ products }) 相同，但沿用快取住的文字。 */
export async function publicCatalogJson(env: Env, origin?: string): Promise<string> {
  return `{"products":${(await catalogSnapshot(env, origin)).text()}}`;
}

/** 首頁開機資料：第一張輪播圖網址與可直接放進 <script type="application/json"> 的型錄文字（同 /api/catalog，「<」已跳脫）。 */
export async function publicCatalogBoot(env: Env, origin?: string): Promise<{ heroImage: string | null; embedText: string }> {
  const data = await catalogSnapshot(env, origin);
  return { heroImage: data.heroImage(), embedText: data.embedText() };
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
