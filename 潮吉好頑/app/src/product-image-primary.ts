// 商品主圖：Worker 圖片路由 /api/product-images/:productId（未設定 IMAGE_BASE_URL 時前台使用，之後保留給舊網址）
// 與後台單張上傳。儲存規則見 product-image-storage.ts。
import { IMAGE_CACHE_CONTROL, IMAGE_STALE_VERSION_CACHE_CONTROL, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES, deleteImageObjects, hasImageSignature, imageContentType, productImageCacheKey, productImageEdgeCache, purgeProductImageCache, putImageWithThumbnail, readImageObject, requestedImageVersion, thumbnailPathFor } from "./product-image-storage";
import { primaryImageUrls } from "./product-image-urls";
import { requireAdmin } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env } from "./env";
import { readImageDimensions } from "./image-dimensions";
import { saveProductImageDimensions } from "./product-image-dimensions";
import { invalidateCatalogCache } from "./catalog";
import { SECURITY_HEADERS, fetchWithTimeout, json, serviceHeaders } from "./http";

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

  // 搬到 R2 前的舊照片可能沒有縮圖；縮圖讀不到一律改用主圖
  let servedPath = imagePath;
  let image = wantsThumbnail ? await readImageObject(env, thumbnailPathFor(imagePath)) : null;
  if (image) servedPath = thumbnailPathFor(imagePath);
  else image = await readImageObject(env, imagePath);
  if (!image) return json({ error: "圖片暫時無法載入" }, { status: 404 });

  const imageHeaders = new Headers(SECURITY_HEADERS);
  imageHeaders.set("Content-Type", image.contentType || imageContentType(servedPath, null));
  imageHeaders.set("Cache-Control", isCurrentVersion ? IMAGE_CACHE_CONTROL : IMAGE_STALE_VERSION_CACHE_CONTROL);
  const response = new Response(image.body, { headers: imageHeaders });
  // Only the current version enters the public cache; stale or made-up
  // versions get the current bytes with a short browser TTL instead.
  if (isCurrentVersion) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

export async function uploadProductImage(request: Request, env: Env, productId: string): Promise<Response> {
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
  const dimensions = readImageDimensions(await image.arrayBuffer());

  // 縮圖是選填欄位，但一旦附上就套用與主圖相同的驗證（另加限定 WebP）；
  // 驗證在任何儲存寫入之前失敗，讓整個請求連同主圖一起被拒絕，管理員才會注意到問題。
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
  const previousVersion = productRows[0].image_updated_at || "1";

  // 每次上傳都是新檔名：公開網域的 CDN 快取不會拿到同網址的舊照片，也不必清除舊縮圖
  const imagePath = `${productId}/${crypto.randomUUID()}.${extension}`;
  try { await putImageWithThumbnail(env, imagePath, image, thumbnail, `productId=${productId}`); }
  catch (error) {
    console.error(`商品照片上傳失敗 productId=${productId}`, error);
    await deleteImageObjects(env, [imagePath, thumbnailPathFor(imagePath)]);
    return json({ error: "照片上傳失敗，請稍後重試" }, { status: 502 });
  }

  const updatedAt = new Date().toISOString();
  const updateResponse = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product_image`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_path: imagePath, p_image_updated_at: updatedAt })
  });
  if (!updateResponse.ok) {
    await deleteImageObjects(env, [imagePath, thumbnailPathFor(imagePath)]);
    return databaseError(updateResponse);
  }
  // 寬高寫入失敗只影響前台保留空間，不讓上傳失敗；讀不到時寫 null，避免沿用舊照片的比例
  await saveProductImageDimensions(env, productId, dimensions, { imagePath, imageUpdatedAt: updatedAt }).catch((error) => console.error(`商品主圖寬高寫入發生例外 productId=${productId}`, error));
  await invalidateCatalogCache(request);
  await purgeProductImageCache(request, productId, undefined, previousVersion);
  await purgeProductImageCache(request, productId, undefined, previousVersion, "thumb");
  // 舊主圖（admin_update_product_image 換掉的多圖第一張）刻意不刪：其他機房的型錄快取（最多 5 分鐘）與已開啟的頁面
  // 仍可能用舊網址載入，刪掉會出現破圖。留下的檔案只占少量 R2 空間；明確刪除多圖時才刪檔。

  return json({ image_url: primaryImageUrls(env, productId, imagePath, updatedAt)?.image_url });
}
