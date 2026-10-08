// 商品主圖寬高：上傳時寫入，既有照片由每小時排程補齊（每次最多 BACKFILL_BATCH 張，只讀檔頭）。
// 寬高只用來讓前台先保留照片空間，寫入失敗不影響上傳或型錄。
import { type ImageDimensions, readImageDimensions } from "./image-dimensions";
import { storageObjectUrl } from "./product-image-storage";
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";

const BACKFILL_BATCH = 30;
const HEADER_BYTES = 65535;

export async function saveProductImageDimensions(env: Env, productId: string, dimensions: ImageDimensions | null) {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
    method: "PATCH",
    headers: { ...serviceHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ image_width: dimensions?.width ?? null, image_height: dimensions?.height ?? null })
  });
  if (!response.ok) console.error(`商品主圖寬高寫入失敗 productId=${productId} status=${response.status}`);
  return response.ok;
}

async function readStoredImageDimensions(env: Env, imagePath: string) {
  const response = await fetchWithTimeout(storageObjectUrl(env, imagePath), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY as string, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Range: `bytes=0-${HEADER_BYTES}` }
  });
  if (!response.ok) return null;
  return readImageDimensions(await response.arrayBuffer());
}

/** 回傳本次補上寬高的商品數；無法辨識的照片留空，下次排程再試（數量受 BACKFILL_BATCH 限制）。 */
export async function backfillProductImageDimensions(env: Env): Promise<number> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path&image_path=not.is.null&image_width=is.null&order=image_updated_at.desc.nullslast&limit=${BACKFILL_BATCH}`, {
    headers: serviceHeaders(env)
  });
  if (!response.ok) {
    console.error(`商品主圖寬高補齊：查詢失敗 status=${response.status}`);
    return 0;
  }
  const rows = await response.json() as Array<{ id: string; image_path: string }>;
  let saved = 0;
  for (const row of rows) {
    try {
      const dimensions = await readStoredImageDimensions(env, row.image_path);
      if (dimensions && await saveProductImageDimensions(env, row.id, dimensions)) saved += 1;
    } catch (error) {
      console.error(`商品主圖寬高補齊失敗 productId=${row.id}`, error);
    }
  }
  return saved;
}
