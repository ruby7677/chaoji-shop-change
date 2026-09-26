// 前台型錄、商品主圖代理與上傳、前端 runtime config。
import { IMAGE_CACHE_CONTROL, IMAGE_STALE_VERSION_CACHE_CONTROL, PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES, hasImageSignature, imageContentType, productImageCacheKey, productImageEdgeCache, purgeProductImageCache, requestedImageVersion, storageObjectUrl, thumbnailPathFor } from "./product-image-storage";
import { requireAdmin } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env, type Product } from "./env";
import { SECURITY_HEADERS, UPLOAD_TIMEOUT_MS, fetchWithTimeout, json, serviceHeaders } from "./http";

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

/** 任何會改變前台型錄資料的管理端寫入成功後呼叫，強制下一次 publicCatalog() 重新讀取。 */
export function invalidateCatalogCache() {
  catalogGeneration += 1;
  catalogCache = null;
  catalogInflight = null;
}

async function loadPublicCatalog(env: Env): Promise<Product[]> {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id,category,name,price,compare_at_price,stock,type,preorder_arrival,seller_link,display_order,product_id,has_image,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible,hero_rank,hero_tagline&is_published=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error("Unable to load catalog");
  const rows = await response.json() as Array<Product & { has_image?: boolean; image_updated_at?: string }>;
  return rows.map(({ has_image, image_updated_at, ...product }) => ({
    ...product,
    image_url: has_image && product.product_id
      ? `/api/product-images/${product.product_id}?v=${encodeURIComponent(image_updated_at || "1")}`
      : undefined
  }));
}

export async function publicCatalog(env: Env): Promise<Product[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoProducts;
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache.data;
  if (catalogInflight) return catalogInflight;
  const generation = catalogGeneration;
  const inflight = loadPublicCatalog(env).then((data) => {
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

export async function serveProductImage(request: Request, env: Env, productId: string, ctx: ExecutionContext): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  // The edge key includes the version query (see product-image-storage.ts), so
  // a changed primary image is served under a new key in every data center.
  // size=thumb 也併入 cache key，避免縮圖與完整圖共用同一份邊緣快取。
  const version = requestedImageVersion(request);
  const wantsThumbnail = new URL(request.url).searchParams.get("size") === "thumb";
  const cacheKey = productImageCacheKey(request, productId, undefined, version, wantsThumbnail ? "thumb" : undefined);
  const edgeCache = productImageEdgeCache();
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;
  // Unpublished product images must not be exposed by guessing an old UUID.
  const productResponse = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?select=image_path,image_updated_at&id=eq.${productId}&is_published=eq.true&limit=1`, {
    headers: serviceHeaders(env)
  });
  if (!productResponse.ok) return json({ error: "圖片暫時無法載入" }, { status: 503 });
  const products = await productResponse.json() as Array<{ image_path?: string; image_updated_at?: string | null }>;
  const imagePath = products[0]?.image_path;
  const isCurrentVersion = version === (products[0]?.image_updated_at || "1");
  if (!imagePath) return json({ error: "商品尚未上傳照片" }, { status: 404 });

  const storageObjectHeaders = { apikey: env.SUPABASE_SERVICE_ROLE_KEY as string, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const fetchImageObject = (path: string) => fetchWithTimeout(storageObjectUrl(env, path), { headers: storageObjectHeaders }, UPLOAD_TIMEOUT_MS);

  let servedPath = imagePath;
  // 縮圖不存在時 Supabase Storage 回 400（不是 404）；縮圖讀不到一律改用主圖
  let imageResponse = wantsThumbnail ? await fetchImageObject(thumbnailPathFor(imagePath)).catch(() => null) : null;
  if (imageResponse && (!imageResponse.ok || !imageResponse.body)) imageResponse = null;
  if (imageResponse) servedPath = thumbnailPathFor(imagePath);
  else imageResponse = await fetchImageObject(imagePath);

  if (!imageResponse.ok || !imageResponse.body) return json({ error: "圖片暫時無法載入" }, { status: imageResponse.status === 404 ? 404 : 503 });
  const imageHeaders = new Headers(SECURITY_HEADERS);
  imageHeaders.set("Content-Type", imageContentType(servedPath, imageResponse.headers.get("Content-Type")));
  imageHeaders.set("Cache-Control", isCurrentVersion ? IMAGE_CACHE_CONTROL : IMAGE_STALE_VERSION_CACHE_CONTROL);
  const response = new Response(imageResponse.body, {
    headers: imageHeaders
  });
  // Only the current version enters the public cache; stale or made-up
  // versions get the current bytes with a short browser TTL instead.
  if (isCurrentVersion) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

export async function uploadProductImage(request: Request, env: Env, productId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  // formData() 會依 Content-Length 緩衝整個請求；在解析前先用這個標頭擋下缺少大小
  // 或明顯過大的請求，避免完全依賴用戶端提供的數字。
  const contentLengthHeader = request.headers.get("Content-Length");
  const requestSize = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
  if (!Number.isInteger(requestSize)) return json({ error: "上傳請求缺少檔案大小" }, { status: 411 });
  if (requestSize > PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES) return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return json({ error: "照片上傳格式錯誤" }, { status: 400 }); }
  const image = formData.get("image");
  if (!(image instanceof File)) return json({ error: "請選擇商品照片" }, { status: 400 });
  const extension = PRODUCT_IMAGE_TYPES[image.type];
  if (!extension) return json({ error: "照片僅支援 JPG、PNG 或 WebP" }, { status: 400 });
  if (!image.size || image.size > PRODUCT_IMAGE_MAX_BYTES) return json({ error: "商品照片必須小於 5MB" }, { status: 400 });
  if (!(await hasImageSignature(image, image.type))) return json({ error: "照片格式與檔案內容不一致" }, { status: 400 });

  // 縮圖是選填欄位，但一旦附上就套用與主圖相同的驗證（另加限定 WebP）；
  // 驗證在任何 storage 寫入之前失敗，讓整個請求連同主圖一起被拒絕，管理員才會注意到問題。
  const thumbnailField = formData.get("thumbnail");
  let thumbnail: File | null = null;
  if (thumbnailField instanceof File && thumbnailField.size > 0) {
    if (thumbnailField.type !== "image/webp") return json({ error: "縮圖僅支援 WebP" }, { status: 400 });
    if (thumbnailField.size > PRODUCT_IMAGE_MAX_BYTES) return json({ error: "縮圖檔案必須小於 5MB" }, { status: 400 });
    if (!(await hasImageSignature(thumbnailField, "image/webp"))) return json({ error: "縮圖格式與檔案內容不一致" }, { status: 400 });
    thumbnail = thumbnailField;
  }

  const productResponse = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path,image_updated_at&id=eq.${productId}&limit=1`, { headers: serviceHeaders(env) });
  if (!productResponse.ok) return json({ error: "無法確認商品資料" }, { status: 503 });
  const productRows = await productResponse.json() as Array<{ id: string; image_path?: string; image_updated_at?: string | null }>;
  if (!productRows.length) return json({ error: "找不到商品" }, { status: 404 });
  const previousImagePath = productRows[0].image_path;
  const previousVersion = productRows[0].image_updated_at || "1";

  const imagePath = `${productId}/primary.${extension}`;
  const thumbnailPath = thumbnailPathFor(imagePath);
  const uploadResponse = await fetchWithTimeout(storageObjectUrl(env, imagePath), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": image.type,
      "x-upsert": "true"
    },
    body: image
  }, UPLOAD_TIMEOUT_MS);
  if (!uploadResponse.ok) return json({ error: "照片上傳失敗，請稍後重試" }, { status: 502 });

  const updatedAt = new Date().toISOString();
  const updateResponse = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product_image`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_path: imagePath, p_image_updated_at: updatedAt })
  });
  if (!updateResponse.ok) return databaseError(updateResponse);
  invalidateCatalogCache();
  await purgeProductImageCache(request, productId, undefined, previousVersion);
  await purgeProductImageCache(request, productId, undefined, previousVersion, "thumb");
  if (previousImagePath && previousImagePath !== imagePath) {
    const previousThumbnailPath = thumbnailPathFor(previousImagePath);
    const prefixes = previousThumbnailPath === thumbnailPath ? [previousImagePath] : [previousImagePath, previousThumbnailPath];
    await fetchWithTimeout(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}`, {
      method: "DELETE",
      headers: serviceHeaders(env),
      body: JSON.stringify({ prefixes })
    });
  }

  // 縮圖上傳採最佳努力：主圖已成功，縮圖失敗只記錄、不讓整個請求失敗。
  // 縮圖路徑固定，沒有新縮圖（未附上或上傳失敗）時要刪掉同路徑的舊縮圖，
  // 否則 size=thumb 會服務到與新主圖不一致的舊照片；刪除不存在的物件不會回錯。
  let thumbnailStored = false;
  if (thumbnail) {
    try {
      const thumbnailUploadResponse = await fetchWithTimeout(storageObjectUrl(env, thumbnailPath), {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "image/webp",
          "x-upsert": "true"
        },
        body: thumbnail
      }, UPLOAD_TIMEOUT_MS);
      thumbnailStored = thumbnailUploadResponse.ok;
      if (!thumbnailStored) console.error(`商品縮圖上傳失敗 productId=${productId} status=${thumbnailUploadResponse.status}`);
    } catch (error) {
      console.error(`商品縮圖上傳發生例外 productId=${productId}`, error);
    }
  }
  if (!thumbnailStored) {
    try {
      await fetchWithTimeout(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}`, {
        method: "DELETE",
        headers: serviceHeaders(env),
        body: JSON.stringify({ prefixes: [thumbnailPath] })
      }, UPLOAD_TIMEOUT_MS);
    } catch (error) {
      console.error(`清除舊商品縮圖發生例外 productId=${productId}`, error);
    }
  }

  return json({ image_url: `/api/product-images/${productId}?v=${encodeURIComponent(updatedAt)}` });
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
    adminIdentityMode: "line_user_id+is_admin"
  };
}
