// 前台型錄的邊緣快取（Cache API，同一機房的所有 isolate 共用）：降低重打 Supabase 的次數與流量。
// 只存在讀取型錄的機房；後台修改或下單時清除「該次請求所在機房」的副本（台灣客人與管理員多半在同一機房），
// 其他機房最多延遲 EDGE_TTL_SECONDS。下單時伺服器仍會重新檢查庫存，延遲只影響顯示的可售量。
// 不使用 Workers Caching：啟用後靜態檔請求也會計入每日請求數。
import type { Product } from "./env";

export const CATALOG_EDGE_TTL_SECONDS = 300;
const KEY_PATH = "/__edge-cache/catalog/v1";

type EdgeCache = { match(key: string): Promise<Response | undefined>; put(key: string, response: Response): Promise<void>; delete(key: string): Promise<boolean> };

// 最近一次型錄請求的網址來源；失效時用它組出同一把 key（workers.dev 或自訂網域都適用）
let knownOrigin: string | null = null;

function edgeCache(): EdgeCache | null {
  return typeof caches === "undefined" ? null : (caches as unknown as { default: EdgeCache }).default ?? null;
}

const keyFor = (origin: string) => `${origin}${KEY_PATH}`;

export async function readEdgeCatalog(origin: string): Promise<Product[] | null> {
  knownOrigin = origin;
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
  try {
    await cache.put(keyFor(origin), new Response(JSON.stringify(products), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CATALOG_EDGE_TTL_SECONDS}` }
    }));
  } catch { /* 寫入失敗只是少一次快取，不影響回應 */ }
}

export async function deleteEdgeCatalog(): Promise<void> {
  const cache = edgeCache();
  if (!cache || !knownOrigin) return;
  try { await cache.delete(keyFor(knownOrigin)); } catch { /* 刪除失敗時最多延遲 TTL */ }
}
