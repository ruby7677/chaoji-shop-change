// 前台型錄的邊緣快取（Cache API，同一機房的所有 isolate 共用）：降低重打 Supabase 的次數與流量。
// 快取鍵依網址來源區分；後台修改或下單時，以「寫入請求的來源」清除該次請求所在機房的副本
// （台灣客人與管理員多半在同一機房）。其他機房，或管理員與客人使用不同網域時，最多延遲 EDGE_TTL_SECONDS。
// 下單時伺服器仍會重新檢查庫存，延遲只影響顯示的可售量。
// 不使用 Workers Caching：啟用後靜態檔請求也會計入每日請求數。
import type { Product } from "./env";

export const CATALOG_EDGE_TTL_SECONDS = 300;
const KEY_PATH = "/__edge-cache/catalog/v1";

type EdgeCache = { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean> };

// 這個 isolate 讀過型錄的來源（失效時一併清除），以及尚未完成的寫入（失效要等它寫完再刪，避免舊資料在刪除後才寫回）
const knownOrigins = new Set<string>();
const pendingPuts = new Set<Promise<void>>();

function edgeCache(): EdgeCache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default: EdgeCache }).default ?? null;
}

const keyFor = (origin: string) => `${origin}${KEY_PATH}`;

export async function readEdgeCatalog(origin: string): Promise<Product[] | null> {
  knownOrigins.add(origin);
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const cached = await cache.match(keyFor(origin));
    return cached ? await cached.json() as Product[] : null;
  } catch {
    return null;
  }
}

export async function writeEdgeCatalog(origin: string, products: Product[]): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  const put = cache.put(keyFor(origin), new Response(JSON.stringify(products), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CATALOG_EDGE_TTL_SECONDS}` }
  })).catch(() => { /* 寫入失敗只是少一次快取 */ });
  pendingPuts.add(put);
  try { await put; } finally { pendingPuts.delete(put); }
}

/** origin：觸發失效的寫入請求來源；即使這個 isolate 還沒讀過型錄也能清掉同機房的共享副本。 */
export async function deleteEdgeCatalog(origin?: string): Promise<void> {
  const cache = edgeCache();
  if (!cache) return;
  if (pendingPuts.size) await Promise.all(pendingPuts);
  const origins = new Set(knownOrigins);
  if (origin) origins.add(origin);
  await Promise.all([...origins].map((each) => cache.delete(keyFor(each)).catch(() => false)));
}
