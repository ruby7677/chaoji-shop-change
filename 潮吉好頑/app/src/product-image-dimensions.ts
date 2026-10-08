// 商品主圖寬高：上傳時寫入，既有照片由每小時排程補齊（每次最多 BACKFILL_BATCH 張，只讀檔頭）。
// 寬高只用來讓前台先保留照片空間，寫入失敗不影響上傳或型錄。
// 主圖更換時資料庫 trigger（202610080003）會清掉舊寬高，排程再重新讀取。
import { type ImageDimensions, readImageDimensions } from "./image-dimensions";
import { storageObjectUrl } from "./product-image-storage";
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";

const BACKFILL_BATCH = 30;
const HEADER_BYTES = 65535;

type ImageVersion = { imagePath: string; imageUpdatedAt: string | null };

// 只在主圖仍是讀取時那一張（路徑與版本相同）才寫入，避免讀取期間換了新圖、又被舊圖寬高蓋掉
function versionFilter(version: ImageVersion) {
  const updatedAt = version.imageUpdatedAt === null ? "is.null" : `eq.${encodeURIComponent(version.imageUpdatedAt)}`;
  return `&image_path=eq.${encodeURIComponent(version.imagePath)}&image_updated_at=${updatedAt}`;
}

export async function saveProductImageDimensions(env: Env, productId: string, dimensions: ImageDimensions | null, version?: ImageVersion) {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?id=eq.${productId}${version ? versionFilter(version) : ""}`, {
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

type PendingRow = { id: string; image_path: string; image_updated_at: string | null };

async function pendingRows(env: Env, idFilter: string, limit: number): Promise<PendingRow[]> {
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path,image_updated_at&image_path=not.is.null&image_width=is.null&id=${idFilter}&order=id&limit=${limit}`, {
    headers: serviceHeaders(env)
  });
  if (!response.ok) throw new Error(`商品主圖寬高補齊：查詢失敗 status=${response.status}`);
  return await response.json() as PendingRow[];
}

// 每次從隨機位置依 id 往後取、不足再從頭補：讀不到的照片不會每次都占滿同一批名額，其他照片仍會輪到
async function pickBatch(env: Env, start: string) {
  const rows = await pendingRows(env, `gte.${start}`, BACKFILL_BATCH);
  if (rows.length < BACKFILL_BATCH) rows.push(...await pendingRows(env, `lt.${start}`, BACKFILL_BATCH - rows.length));
  return rows;
}

/** 回傳本次補上寬高的商品數；無法辨識的照片留空，之後的排程再試。 */
export async function backfillProductImageDimensions(env: Env, start: string = crypto.randomUUID()): Promise<number> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  let saved = 0;
  for (const row of await pickBatch(env, start)) {
    try {
      const dimensions = await readStoredImageDimensions(env, row.image_path);
      if (dimensions && await saveProductImageDimensions(env, row.id, dimensions, { imagePath: row.image_path, imageUpdatedAt: row.image_updated_at })) saved += 1;
    } catch (error) {
      console.error(`商品主圖寬高補齊失敗 productId=${row.id}`, error);
    }
  }
  return saved;
}
