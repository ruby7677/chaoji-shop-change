// Supabase 保活：每日對資料庫送一次唯讀請求，避免專案因長時間沒有 API 活動被暫停。
// 不論通知是否啟用、有沒有訂單都會執行；由每小時的 Cron Trigger 在固定時刻呼叫（見 index.ts）。
import type { Env } from "./env";
import { fetchWithTimeout } from "./http";

/** 每日執行的 UTC 小時（18:00 UTC = 台灣 02:00，離峰）。 */
export const KEEPALIVE_UTC_HOUR = 18;

export function isKeepaliveHour(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCHours() === KEEPALIVE_UTC_HOUR;
}

/** 只讀取公開型錄 view 的一列 id（anon 本來就可讀），不寫入任何資料。回傳是否成功；失敗只記錄，不丟出。 */
export async function pingSupabase(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">): Promise<boolean> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return false;
  try {
    const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id&limit=1`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
    });
    // 讀掉回應本體，讓連線正常釋放。
    await response.arrayBuffer();
    if (!response.ok) console.warn(`supabase keepalive failed: HTTP ${response.status}`);
    return response.ok;
  } catch (error) {
    console.warn("supabase keepalive failed", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
