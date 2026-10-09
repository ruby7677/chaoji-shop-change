// 商品頁資料、多圖代理與後台多圖／展示欄位管理。
// 共用的 HTTP、授權與錯誤處理由 index.ts 以 ShowcaseDeps 注入，避免循環 import。
import {
  IMAGE_CACHE_CONTROL,
  IMAGE_STALE_VERSION_CACHE_CONTROL,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_TYPES,
  PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES,
  deleteImageObjects,
  hasImageSignature,
  imageContentType,
  productImageCacheKey,
  productImageEdgeCache,
  purgeProductImageCache,
  putImageWithThumbnail,
  readImageObject,
  requestedImageVersion,
  thumbnailPathFor
} from "./product-image-storage";
import { galleryImageUrl, primaryImageUrls } from "./product-image-urls";
import { fetchWithTimeout } from "./http";
import { databaseErrors } from "./database-errors";
import { invalidateCatalogCache } from "./catalog";

export interface ShowcaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  PRODUCT_IMAGES?: R2Bucket;
  IMAGE_BASE_URL?: string;
}

export interface ShowcaseDeps<E extends ShowcaseEnv> {
  json(data: unknown, init?: ResponseInit): Response;
  serviceHeaders(env: E, prefer?: string): Record<string, string>;
  requireAdmin(request: Request, env: E): Promise<{ user: { id: string } } | Response>;
  databaseError(response: Response): Promise<Response>;
  securityHeaders: Record<string, string>;
}

const MAX_IMAGES_PER_PRODUCT = 10;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_PATTERN = new RegExp(`^${UUID}$`, "i");
const PUBLIC_PRODUCT_ROUTE = new RegExp(`^/api/products/(${UUID})$`, "i");
const GALLERY_IMAGE_ROUTE = new RegExp(`^/api/product-images/(${UUID})/(${UUID})$`, "i");
const ADMIN_IMAGES_ROUTE = new RegExp(`^/api/admin/products/(${UUID})/images$`, "i");
const ADMIN_IMAGE_ORDER_ROUTE = new RegExp(`^/api/admin/products/(${UUID})/images/order$`, "i");
const ADMIN_IMAGE_ROUTE = new RegExp(`^/api/admin/products/(${UUID})/images/(${UUID})$`, "i");
const ADMIN_SHOWCASE_ROUTE = new RegExp(`^/api/admin/products/(${UUID})/showcase$`, "i");
// 與首頁 /api/catalog 相同欄位，前台規格選擇、限購與價格邏輯可直接共用。
const STOREFRONT_VARIANT_SELECT = "id,category,name,price,compare_at_price,stock,type,preorder_arrival,seller_link,display_order,product_id,has_image,image_path,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible";

type GalleryImageRow = { id: string; storage_path: string; width: number | null; height: number | null; alt_text: string | null; updated_at: string };
type StorefrontVariantRow = Record<string, unknown> & { product_id?: string; has_image?: boolean; image_path?: string | null; image_updated_at?: string };

function optionalDimension(value: FormDataEntryValue | null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 20000 ? number : null;
}

export function createProductShowcase<E extends ShowcaseEnv>(deps: ShowcaseDeps<E>) {
  const { json, serviceHeaders, requireAdmin, databaseError } = deps;

  async function publicProduct(env: E, productId: string): Promise<Response> {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "商品服務尚未設定" }, { status: 503 });
    const base = env.SUPABASE_URL;
    const [productResponse, variantResponse, imageResponse] = await Promise.all([
      fetchWithTimeout(`${base}/rest/v1/products?select=id,name,description,details&id=eq.${productId}&is_published=eq.true&limit=1`, { headers: serviceHeaders(env) }),
      // 規格走與首頁型錄相同的 anon view，可售量與上架規則維持一致。
      fetchWithTimeout(`${base}/rest/v1/storefront_variants?select=${STOREFRONT_VARIANT_SELECT}&product_id=eq.${productId}&is_published=eq.true&order=display_order.desc,id.desc`, {
        headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
      }),
      fetchWithTimeout(`${base}/rest/v1/product_images?select=id,storage_path,width,height,alt_text,updated_at&product_id=eq.${productId}&order=sort_order.asc&limit=${MAX_IMAGES_PER_PRODUCT}`, { headers: serviceHeaders(env) })
    ]);
    if (!productResponse.ok || !variantResponse.ok || !imageResponse.ok) return json({ error: "商品暫時無法載入" }, { status: 503 });
    const products = await productResponse.json() as Array<{ id: string; name: string; description?: string | null; details?: string | null }>;
    const variants = await variantResponse.json() as StorefrontVariantRow[];
    if (!products.length || !variants.length) return json({ error: "商品已下架或不存在" }, { status: 404 });
    const images = await imageResponse.json() as GalleryImageRow[];
    const product = products[0];
    return json({
      product: { id: product.id, name: product.name, description: product.description || "", details: product.details || "" },
      variants: variants.map(({ has_image, image_path, image_updated_at, ...variant }) => {
        const urls = has_image ? primaryImageUrls(env, productId, image_path, image_updated_at) : null;
        return { ...variant, image_url: urls?.image_url, thumb_url: urls?.thumb_url };
      }),
      images: images.map((image) => ({ id: image.id, url: galleryImageUrl(env, productId, image), width: image.width, height: image.height, alt: image.alt_text || product.name }))
    }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=60" } });
  }

  async function serveGalleryImage(request: Request, env: E, productId: string, imageId: string, ctx: ExecutionContext): Promise<Response> {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
    // 快取 key 含版本，快取策略見 product-image-storage.ts。
    const version = requestedImageVersion(request);
    const cacheKey = productImageCacheKey(request, productId, imageId, version);
    const edgeCache = productImageEdgeCache();
    const cached = await edgeCache.match(cacheKey);
    if (cached) return cached;
    // 圖片必須屬於該商品且商品已上架，避免以舊 UUID 猜出未上架或他人商品的圖片。
    const lookup = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/product_images?select=storage_path,updated_at,products!inner(is_published)&id=eq.${imageId}&product_id=eq.${productId}&products.is_published=eq.true&limit=1`, { headers: serviceHeaders(env) });
    if (!lookup.ok) return json({ error: "圖片暫時無法載入" }, { status: 503 });
    const rows = await lookup.json() as Array<{ storage_path: string; updated_at: string }>;
    const storagePath = rows[0]?.storage_path;
    if (!storagePath) return json({ error: "找不到商品照片" }, { status: 404 });
    const isCurrentVersion = version === rows[0].updated_at;
    const image = await readImageObject(env, storagePath);
    if (!image) return json({ error: "圖片暫時無法載入" }, { status: 404 });
    const headers = new Headers(deps.securityHeaders);
    headers.set("Content-Type", image.contentType || imageContentType(storagePath, null));
    headers.set("Cache-Control", isCurrentVersion ? IMAGE_CACHE_CONTROL : IMAGE_STALE_VERSION_CACHE_CONTROL);
    const response = new Response(image.body, { headers });
    if (isCurrentVersion) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
    return response;
  }

  // 連同同名縮圖一起刪除（R2 與搬移前的 Supabase 舊檔；不存在的物件不會回錯）
  async function deleteStorageObject(env: E, path: string) {
    await deleteImageObjects(env, [path, thumbnailPathFor(path)]);
  }

  async function addProductImage(request: Request, env: E, productId: string): Promise<Response> {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PRODUCT_IMAGES) return json({ error: "圖片服務尚未設定" }, { status: 503 });
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
    // 縮圖選填（長邊超過 640px 才會附上），驗證規則與單張主圖上傳相同；驗證失敗時整個請求在寫入前就拒絕
    const thumbnailField = formData.get("thumbnail");
    let thumbnail: File | null = null;
    if (thumbnailField instanceof File && thumbnailField.size > 0) {
      if (thumbnailField.type !== "image/webp") return json({ error: "縮圖僅支援 WebP" }, { status: 400 });
      if (thumbnailField.size > PRODUCT_IMAGE_MAX_BYTES) return json({ error: "縮圖檔案必須小於 5MB" }, { status: 400 });
      if (!(await hasImageSignature(thumbnailField, "image/webp"))) return json({ error: "縮圖格式與檔案內容不一致" }, { status: 400 });
      thumbnail = thumbnailField;
    }

    const imageId = crypto.randomUUID();
    const storagePath = `${productId}/${imageId}.${extension}`;
    // 縮圖在建立資料列前寫入：照片一出現在型錄就已有縮圖（沒附縮圖時以原圖代替，見 putImageWithThumbnail）
    try { await putImageWithThumbnail(env, storagePath, image, thumbnail, `productId=${productId}`); }
    catch (error) {
      console.error(`商品多圖上傳失敗 productId=${productId}`, error);
      await deleteStorageObject(env, storagePath);
      return json({ error: "照片上傳失敗，請稍後重試" }, { status: 502 });
    }
    const altText = String(formData.get("alt") || "").slice(0, 120);
    const rpc = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_add_product_image`, {
      method: "POST",
      headers: serviceHeaders(env),
      body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_id: imageId, p_storage_path: storagePath, p_width: optionalDimension(formData.get("width")), p_height: optionalDimension(formData.get("height")), p_alt_text: altText })
    });
    if (!rpc.ok) {
      // 資料列沒建立（上限、商品不存在等）就移除剛上傳的物件，避免孤兒檔案。
      await deleteStorageObject(env, storagePath);
      return databaseError(rpc);
    }
    const row = await rpc.json() as GalleryImageRow;
    await invalidateCatalogCache(request);
    // 主圖若改變，image_updated_at 會更新，前台改用新版本網址，不需 purge。
    return json({ image: { id: row.id, url: galleryImageUrl(env, productId, { ...row, storage_path: storagePath }), width: row.width, height: row.height, alt: row.alt_text } }, { status: 201 });
  }

  async function reorderProductImages(request: Request, env: E, productId: string): Promise<Response> {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;
    let body: { image_ids?: unknown };
    try { body = await request.json() as { image_ids?: unknown }; }
    catch { return json({ error: "排序資料格式錯誤" }, { status: 400 }); }
    const imageIds = body.image_ids;
    if (!Array.isArray(imageIds) || imageIds.length > MAX_IMAGES_PER_PRODUCT || !imageIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
      return json({ error: "排序資料格式錯誤" }, { status: 400 });
    }
    const rpc = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_reorder_product_images`, {
      method: "POST",
      headers: serviceHeaders(env),
      body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_ids: imageIds })
    });
    if (!rpc.ok) return databaseError(rpc);
    await invalidateCatalogCache(request);
    // 排序會更新各圖 updated_at 與主圖版本，前台自動改用新網址。
    return json({ ok: true });
  }

  async function deleteProductImage(request: Request, env: E, productId: string, imageId: string): Promise<Response> {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;
    // 先記下目前版本，刪除後才能清掉本機房對應的快取 key。
    const before = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/product_images?select=updated_at&id=eq.${imageId}&product_id=eq.${productId}&limit=1`, { headers: serviceHeaders(env) });
    const beforeRows = before.ok ? await before.json() as Array<{ updated_at: string }> : [];
    const rpc = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_delete_product_image`, {
      method: "POST",
      headers: serviceHeaders(env),
      body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_id: imageId })
    });
    if (!rpc.ok) return databaseError(rpc);
    const { storage_path: storagePath } = await rpc.json() as { storage_path: string };
    await deleteStorageObject(env, storagePath);
    await invalidateCatalogCache(request);
    if (beforeRows[0]) await purgeProductImageCache(request, productId, imageId, beforeRows[0].updated_at);
    return json({ ok: true });
  }

  async function updateProductShowcase(request: Request, env: E, productId: string): Promise<Response> {
    const admin = await requireAdmin(request, env);
    if (admin instanceof Response) return admin;
    let body: { details?: unknown; hero_rank?: unknown; hero_tagline?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return json({ error: "展示設定格式錯誤" }, { status: 400 }); }
    const details = body.details ?? "";
    const heroTagline = body.hero_tagline ?? "";
    const heroRank = body.hero_rank === null || body.hero_rank === "" || body.hero_rank === undefined ? null : Number(body.hero_rank);
    if (typeof details !== "string" || details.length > 8000 || typeof heroTagline !== "string" || heroTagline.length > 80
      || (heroRank !== null && (!Number.isInteger(heroRank) || heroRank < 1 || heroRank > 12))) {
      return json({ error: "展示設定格式錯誤：介紹上限 8000 字、導購文上限 80 字、輪播排序 1–12" }, { status: 400 });
    }
    const rpc = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product_showcase`, {
      method: "POST",
      headers: serviceHeaders(env),
      body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_details: details, p_hero_rank: heroRank, p_hero_tagline: heroTagline })
    });
    if (!rpc.ok) return databaseError(rpc);
    await invalidateCatalogCache(request);
    return json(await rpc.json());
  }

  // 回傳 null 代表不是本模組的路由，交回 index.ts 繼續比對。
  async function route(request: Request, env: E, url: URL, ctx: ExecutionContext): Promise<Response | null> {
    const { method } = request;
    const publicMatch = url.pathname.match(PUBLIC_PRODUCT_ROUTE);
    if (method === "GET" && publicMatch) return publicProduct(env, publicMatch[1]);
    const galleryMatch = url.pathname.match(GALLERY_IMAGE_ROUTE);
    if (method === "GET" && galleryMatch) return serveGalleryImage(request, env, galleryMatch[1], galleryMatch[2], ctx);
    const imagesMatch = url.pathname.match(ADMIN_IMAGES_ROUTE);
    if (method === "POST" && imagesMatch) return addProductImage(request, env, imagesMatch[1]);
    const orderMatch = url.pathname.match(ADMIN_IMAGE_ORDER_ROUTE);
    if (method === "PATCH" && orderMatch) return reorderProductImages(request, env, orderMatch[1]);
    const imageMatch = url.pathname.match(ADMIN_IMAGE_ROUTE);
    if (method === "DELETE" && imageMatch) return deleteProductImage(request, env, imageMatch[1], imageMatch[2]);
    const showcaseMatch = url.pathname.match(ADMIN_SHOWCASE_ROUTE);
    if (method === "PATCH" && showcaseMatch) return updateProductShowcase(request, env, showcaseMatch[1]);
    return null;
  }

  return { route };
}

// index.ts 的 JSON body 大小限制需放行多圖上傳的 multipart 請求。
export function isShowcaseImageUpload(request: Request, url: URL) {
  return request.method === "POST" && ADMIN_IMAGES_ROUTE.test(url.pathname);
}
