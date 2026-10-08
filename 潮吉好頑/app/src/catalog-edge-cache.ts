// 前台型錄的邊緣快取（Cache API，同一機房的所有 isolate 共用）：降低重打 Supabase 的次數與流量。
// 快取鍵依網址來源區分；後台修改或下單時，以「寫入請求的來源」清除該次請求所在機房的副本
// （台灣客人與管理員多半在同一機房）。其他機房，或管理員與客人使用不同網域時，最多延遲 EDGE_TTL_SECONDS。
// 下單時伺服器仍會重新檢查庫存，延遲只影響顯示的可售量。
// 不使用 Workers Caching：啟用後靜態檔請求也會計入每日請求數。
//
// 跨 isolate 的失效：清除時另存一筆「失效時間」（同機房共用）；每份型錄副本記下開始讀取 Supabase 的時間，
// 早於失效時間的副本一律視為過期。因此別的 isolate 在失效前開始讀取、失效後才寫回的舊資料不會被使用。
import type { Product } from "./env";

export const CATALOG_EDGE_TTL_SECONDS = 300;
const KEY_PATH = "/__edge-cache/catalog/v1";
const INVALIDATED_PATH = "/__edge-cache/catalog/v1-invalidated-at";
const LOADED_AT_HEADER = "X-Catalog-Loaded-At";

type EdgeCache = { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean> };

// 這個 isolate 讀過型錄的來源（失效時一併清除）與進行中的清除（讀取要等它完成，避免讀到正要刪掉的副本）
const knownOrigins = new Set<string>();
let pendingInvalidation: Promise<void> | null = null;

function edgeCache(): EdgeCache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default: EdgeCache }).default ?? null;
}

const keyFor = (origin: string) => `${origin}${KEY_PATH}`;
const invalidatedKeyFor = (origin: string) => `${origin}${INVALIDATED_PATH}`;
const cacheHeaders = { "Cache-Control": `public, max-age=${CATALOG_EDGE_TTL_SECONDS}` };

async function invalidatedAt(cache: EdgeCache, origin: string): Promise<number> {
  const marker = await cache.match(invalidatedKeyFor(origin));
  return marker ? Number(await marker.text()) || 0 : 0;
}

export async function readEdgeCatalog(origin: string): Promise<Product[] | null> {
  knownOrigins.add(origin);
  if (pendingInvalidation) await pendingInvalidation;
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const [cached, invalidated] = await Promise.all([cache.match(keyFor(origin)), invalidatedAt(cache, origin)]);
    if (!cached) return null;
    const loadedAt = Number(cached.headers.get(LOADED_AT_HEADER)) || 0;
    return loadedAt > invalidated ? await cached.json() as Product[] : null;
  } catch {
    return null;
  }
}

/** loadedAt：開始向 Supabase 讀取這份型錄的時間（毫秒）。 */
export async function writeEdgeCatalog(origin: string, products: Product[], loadedAt: number): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  try {
    if (loadedAt <= await invalidatedAt(cache, origin)) return;
    await cache.put(keyFor(origin), new Response(JSON.stringify(products), {
      headers: { "Content-Type": "application/json", [LOADED_AT_HEADER]: String(loadedAt), ...cacheHeaders }
    }));
  } catch { /* 寫入失敗只是少一次快取，不影響回應 */ }
}

/** origin：觸發失效的寫入請求來源；即使這個 isolate 還沒讀過型錄也能清掉同機房的共享副本。 */
export async function deleteEdgeCatalog(origin?: string): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const origins = new Set(knownOrigins);
  if (origin) origins.add(origin);
  const now = Date.now();
  // 失效時間只往後推：Cache API 沒有原子的比較後寫入，並行失效時較早的寫入可能較晚完成而把時間倒退，
  // 所以寫入前取較大值、刪除後再確認一次並補寫。殘餘時間窗極短，最壞情況仍受 TTL 上限保護。
  const markInvalidated = async (each: string) => {
    const marker = Math.max(now, await invalidatedAt(cache, each));
    await cache.put(invalidatedKeyFor(each), new Response(String(marker), { headers: cacheHeaders }));
  };
  const run = Promise.all([...origins].map(async (each) => {
    try {
      await markInvalidated(each);
      await cache.delete(keyFor(each));
      if (await invalidatedAt(cache, each) < now) await markInvalidated(each);
    } catch { /* 清除失敗時最多延遲 TTL */ }
  })).then(() => undefined);
  pendingInvalidation = run;
  try { await run; } finally { if (pendingInvalidation === run) pendingInvalidation = null; }
}
