// 一次性搬檔：把資料庫仍在使用的商品照片從 Supabase Storage 複製到 R2（含縮圖；沒有縮圖的小圖以原圖當縮圖）。
// 搬完、確認公開網域可讀取後移除本檔與 index.ts 的路由。
// 只接受 service role key 當 Bearer（金鑰只存在 Worker secret 與店主本機 .dev.vars），呼叫端不需要另外的管理員登入。
// 可重複執行：R2 已有的物件會略過；每次最多搬 limit 張，避免超過免費方案每次請求 50 個外部子請求的上限。
import { PRODUCT_IMAGE_BUCKET, imageContentType, putImageObject, storageObjectUrl, thumbnailPathFor } from "./product-image-storage";
import { type Env } from "./env";
import { UPLOAD_TIMEOUT_MS, fetchWithTimeout, json, serviceHeaders } from "./http";

const DEFAULT_BATCH = 15;
const MAX_BATCH = 20;

function sameSecret(given: string, expected: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function referencedImageKeys(env: Env) {
  const [products, gallery] = await Promise.all([
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?select=image_path&image_path=not.is.null`, { headers: serviceHeaders(env) }),
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/product_images?select=storage_path`, { headers: serviceHeaders(env) })
  ]);
  if (!products.ok || !gallery.ok) throw new Error(`讀取圖片清單失敗 products=${products.status} gallery=${gallery.status}`);
  const keys = new Set<string>();
  for (const row of await products.json() as Array<{ image_path: string }>) keys.add(row.image_path);
  for (const row of await gallery.json() as Array<{ storage_path: string }>) keys.add(row.storage_path);
  return [...keys].sort();
}

async function fetchSupabaseObject(env: Env, key: string) {
  const response = await fetchWithTimeout(storageObjectUrl(env, key), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY as string, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  }, UPLOAD_TIMEOUT_MS);
  // Supabase 物件不存在時回 400
  if (!response.ok) return null;
  return { bytes: await response.arrayBuffer(), contentType: response.headers.get("Content-Type") };
}

async function copyImage(env: Env, key: string, hasMain: boolean, hasThumbnail: boolean) {
  let main: { bytes: ArrayBuffer; contentType: string | null } | null = null;
  if (!hasMain || !hasThumbnail) main = await fetchSupabaseObject(env, key);
  if (!hasMain) {
    if (!main) throw new Error("Supabase 找不到原圖");
    await putImageObject(env, key, main.bytes, main.contentType || imageContentType(key, null));
  }
  if (hasThumbnail) return;
  const thumbnailKey = thumbnailPathFor(key);
  const thumbnail = await fetchSupabaseObject(env, thumbnailKey);
  if (thumbnail) await putImageObject(env, thumbnailKey, thumbnail.bytes, "image/webp");
  else if (main) await putImageObject(env, thumbnailKey, main.bytes, main.contentType || imageContentType(key, null));
  else throw new Error("Supabase 找不到原圖，無法補縮圖");
}

export async function migrateProductImagesToR2(request: Request, env: Env, url: URL): Promise<Response> {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key || !token || !sameSecret(token, key)) return json({ error: "Unauthorized" }, { status: 401 });
  if (!env.SUPABASE_URL || !env.PRODUCT_IMAGES) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  const requested = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_BATCH) : DEFAULT_BATCH;
  const dryRun = url.searchParams.get("dry_run") === "1";

  const keys = await referencedImageKeys(env);
  let pending = 0;
  let copied = 0;
  const failed: Array<{ key: string; error: string }> = [];
  for (const imageKey of keys) {
    const [main, thumbnail] = await Promise.all([env.PRODUCT_IMAGES.head(imageKey), env.PRODUCT_IMAGES.head(thumbnailPathFor(imageKey))]);
    if (main && thumbnail) continue;
    pending += 1;
    if (dryRun || copied + failed.length >= limit) continue;
    try { await copyImage(env, imageKey, Boolean(main), Boolean(thumbnail)); copied += 1; }
    catch (error) { failed.push({ key: imageKey, error: error instanceof Error ? error.message : String(error) }); }
  }
  return json({ bucket: PRODUCT_IMAGE_BUCKET, total: keys.length, pending_before: pending, copied, failed, remaining: pending - copied });
}
