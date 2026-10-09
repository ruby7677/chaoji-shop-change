// 一次性搬檔：把資料庫仍在使用的商品照片從 Supabase Storage 複製到 R2（含縮圖；沒有縮圖的小圖以原圖當縮圖）。
// 搬完、確認公開網域可讀取後移除本檔與 index.ts 的路由。
// 只接受 service role key 當 Bearer（金鑰只存在 Worker secret 與店主本機 .dev.vars），呼叫端不需要另外的管理員登入。
// 可重複執行：R2 已有的物件會略過。每次最多搬 limit 張（免費方案每次請求 50 個外部子請求）、最多檢查 SCAN_BATCH 個路徑
// （每個路徑兩次 R2 head，內部子請求上限 1000）；回應的 next_cursor 不為 null 時帶 ?after= 繼續呼叫。
// 搬失敗的路徑列在 failed、游標仍會往後走；全部跑完後不帶 after 再跑一次即可重試。
import { imageContentType, putImageObject, storageObjectUrl, thumbnailPathFor } from "./product-image-storage";
import { type Env } from "./env";
import { UPLOAD_TIMEOUT_MS, fetchWithTimeout, json, serviceHeaders } from "./http";

const DEFAULT_BATCH = 15;
const MAX_BATCH = 20;
const SCAN_BATCH = 200;
const PAGE_SIZE = 1000;
// 免費方案每次請求最多 50 個外部子請求；清單分頁用掉的次數要先扣掉，每張圖最多再用 2 次（原圖＋縮圖）
const FETCH_BUDGET = 48;

function sameSecret(given: string, expected: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

// Data API 單次最多回傳 1000 列：依路徑排序分頁讀完
async function allPaths(env: Env, table: string, column: string, counter: { fetches: number }) {
  const paths: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    counter.fetches += 1;
    const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/${table}?select=${column}&${column}=not.is.null&order=${column}&limit=${PAGE_SIZE}&offset=${offset}`, { headers: serviceHeaders(env) });
    if (!response.ok) throw new Error(`讀取圖片清單失敗 ${table} status=${response.status}`);
    const rows = await response.json() as Array<Record<string, string>>;
    paths.push(...rows.map((row) => row[column]));
    if (rows.length < PAGE_SIZE) return paths;
  }
}

async function referencedImageKeys(env: Env) {
  const counter = { fetches: 0 };
  const [products, gallery] = await Promise.all([allPaths(env, "products", "image_path", counter), allPaths(env, "product_images", "storage_path", counter)]);
  return { keys: [...new Set([...products, ...gallery])].sort(), listFetches: counter.fetches };
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
  const requestedLimit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_BATCH) : DEFAULT_BATCH;
  const dryRun = url.searchParams.get("dry_run") === "1";

  const after = url.searchParams.get("after") || "";

  const { keys, listFetches } = await referencedImageKeys(env);
  const limit = Math.min(requestedLimit, Math.floor((FETCH_BUDGET - listFetches) / 2));
  if (!dryRun && limit < 1) return json({ error: "圖片清單過大，單次請求無法同時讀清單與搬檔" }, { status: 507 });
  const scan = keys.filter((imageKey) => imageKey > after).slice(0, SCAN_BATCH);
  let pending = 0;
  let copied = 0;
  let lastScanned = after;
  const failed: Array<{ key: string; error: string }> = [];
  for (const imageKey of scan) {
    // 本批搬滿就停在這裡，下次從這個路徑繼續（尚未檢查的路徑不算進 pending）
    if (!dryRun && copied + failed.length >= limit) break;
    lastScanned = imageKey;
    const [main, thumbnail] = await Promise.all([env.PRODUCT_IMAGES.head(imageKey), env.PRODUCT_IMAGES.head(thumbnailPathFor(imageKey))]);
    if (main && thumbnail) continue;
    pending += 1;
    if (dryRun) continue;
    try { await copyImage(env, imageKey, Boolean(main), Boolean(thumbnail)); copied += 1; }
    catch (error) { failed.push({ key: imageKey, error: error instanceof Error ? error.message : String(error) }); }
  }
  const done = !keys.some((imageKey) => imageKey > lastScanned);
  return json({ total: keys.length, scanned_after: after || null, pending_in_batch: pending, copied, failed, next_cursor: done ? null : lastScanned });
}
