// 前台型錄、商品主圖代理與上傳、前端 runtime config。
import { IMAGE_CACHE_CONTROL, IMAGE_STALE_VERSION_CACHE_CONTROL, PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, hasImageSignature, imageContentType, productImageCacheKey, productImageEdgeCache, purgeProductImageCache, requestedImageVersion, storageObjectUrl } from "./product-image-storage";
import { requireAdmin } from "./auth";
import { databaseError } from "./database-errors";
import { type Env, type Product } from "./env";
import { SECURITY_HEADERS, json, serviceHeaders } from "./http";

const demoProducts: Product[] = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

export async function publicCatalog(env: Env): Promise<Product[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoProducts;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id,category,name,price,compare_at_price,stock,type,preorder_arrival,seller_link,display_order,product_id,has_image,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible,hero_rank,hero_tagline&is_published=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
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

export async function serveProductImage(request: Request, env: Env, productId: string, ctx: ExecutionContext): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  // The edge key includes the version query (see product-image-storage.ts), so
  // a changed primary image is served under a new key in every data center.
  const version = requestedImageVersion(request);
  const cacheKey = productImageCacheKey(request, productId, undefined, version);
  const edgeCache = productImageEdgeCache();
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;
  // Unpublished product images must not be exposed by guessing an old UUID.
  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=image_path,image_updated_at&id=eq.${productId}&is_published=eq.true&limit=1`, {
    headers: serviceHeaders(env)
  });
  if (!productResponse.ok) return json({ error: "圖片暫時無法載入" }, { status: 503 });
  const products = await productResponse.json() as Array<{ image_path?: string; image_updated_at?: string | null }>;
  const imagePath = products[0]?.image_path;
  const isCurrentVersion = version === (products[0]?.image_updated_at || "1");
  if (!imagePath) return json({ error: "商品尚未上傳照片" }, { status: 404 });
  const imageResponse = await fetch(storageObjectUrl(env, imagePath), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!imageResponse.ok || !imageResponse.body) return json({ error: "圖片暫時無法載入" }, { status: imageResponse.status === 404 ? 404 : 503 });
  const imageHeaders = new Headers(SECURITY_HEADERS);
  imageHeaders.set("Content-Type", imageContentType(imagePath, imageResponse.headers.get("Content-Type")));
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
  const requestSize = Number(request.headers.get("Content-Length") || 0);
  if (requestSize > PRODUCT_IMAGE_MAX_BYTES + 256 * 1024) return json({ error: "商品照片不可超過 5MB" }, { status: 413 });

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return json({ error: "照片上傳格式錯誤" }, { status: 400 }); }
  const image = formData.get("image");
  if (!(image instanceof File)) return json({ error: "請選擇商品照片" }, { status: 400 });
  const extension = PRODUCT_IMAGE_TYPES[image.type];
  if (!extension) return json({ error: "照片僅支援 JPG、PNG 或 WebP" }, { status: 400 });
  if (!image.size || image.size > PRODUCT_IMAGE_MAX_BYTES) return json({ error: "商品照片必須小於 5MB" }, { status: 400 });
  if (!(await hasImageSignature(image, image.type))) return json({ error: "照片格式與檔案內容不一致" }, { status: 400 });

  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path,image_updated_at&id=eq.${productId}&limit=1`, { headers: serviceHeaders(env) });
  if (!productResponse.ok) return json({ error: "無法確認商品資料" }, { status: 503 });
  const productRows = await productResponse.json() as Array<{ id: string; image_path?: string; image_updated_at?: string | null }>;
  if (!productRows.length) return json({ error: "找不到商品" }, { status: 404 });
  const previousImagePath = productRows[0].image_path;
  const previousVersion = productRows[0].image_updated_at || "1";

  const imagePath = `${productId}/primary.${extension}`;
  const uploadResponse = await fetch(storageObjectUrl(env, imagePath), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": image.type,
      "x-upsert": "true"
    },
    body: image
  });
  if (!uploadResponse.ok) return json({ error: "照片上傳失敗，請稍後重試" }, { status: 502 });

  const updatedAt = new Date().toISOString();
  const updateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product_image`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_path: imagePath, p_image_updated_at: updatedAt })
  });
  if (!updateResponse.ok) return databaseError(updateResponse);
  await purgeProductImageCache(request, productId, undefined, previousVersion);
  if (previousImagePath && previousImagePath !== imagePath) {
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}`, {
      method: "DELETE",
      headers: serviceHeaders(env),
      body: JSON.stringify({ prefixes: [previousImagePath] })
    });
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
