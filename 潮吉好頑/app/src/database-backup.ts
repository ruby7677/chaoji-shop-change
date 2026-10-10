// 每週資料備份：以 service role 唯讀匯出營運資料表到私有 R2 bucket（BACKUPS，沒有公開網域）。
// 由專用的每週 Cron Trigger 呼叫（見 wrangler.jsonc 的 BACKUP_CRON 與 index.ts），獨立一次執行，不和通知排程共用子請求額度。
// 回應本體不解析、直接寫入 R2，CPU 用量很低；舊備份由 bucket 的生命週期規則自動刪除（見 SECURITY_OPERATIONS_CHECKLIST.md）。
import type { Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { taipeiDate } from "./notifications";

/** 每週日 19:00 UTC（台灣週一 03:00，離峰）；必須與 wrangler.jsonc 的 crons 項目一致。 */
export const BACKUP_CRON = "0 19 * * 0";

/** 與 PostgREST 預設 max-rows 相同，每頁一個 R2 物件。 */
export const BACKUP_PAGE_SIZE = 1000;

/** 免費方案每次執行最多 50 個外部子請求；保留餘裕，超過就停止並在 manifest 標記未完成。 */
export const BACKUP_FETCH_BUDGET = 45;

/**
 * 要備份的資料表與排序鍵（分頁需要穩定排序）。刻意不備份：
 * liff_session_vault（登入工作階段密文）、member_cart_items（暫存購物車）、
 * line_low_stock_states／notification_deliveries（通知暫存狀態）。auth.users 不在 PostgREST 可讀範圍。
 */
export const BACKUP_TABLES: ReadonlyArray<readonly [table: string, order: string]> = [
  ["orders", "id"],
  ["order_items", "id"],
  ["order_status_history", "id"],
  ["profiles", "id"],
  ["point_ledger", "id"],
  ["point_settings", "id"],
  ["inventory_movements", "id"],
  ["inventory_reservations", "id"],
  ["categories", "id"],
  ["products", "id"],
  ["product_variants", "id"],
  ["product_images", "id"],
  ["coupons", "id"],
  ["coupon_members", "coupon_id,member_id"],
  ["coupon_products", "coupon_id,product_id"],
  ["coupon_redemptions", "id"],
  ["birthday_coupon_issues", "member_id,birthday_year"],
  ["birthday_coupon_settings", "id"],
  ["bank_accounts", "id"],
  ["audit_logs", "id"]
];

type TableResult = { table: string; rows: number; pages: number; error?: string };

/** Content-Range「0-999/1234」或「* /0」的總筆數；沒有總數時回傳 null。 */
export function totalFromContentRange(header: string | null): number | null {
  const total = header?.split("/")[1];
  return total && /^\d+$/.test(total) ? Number(total) : null;
}

/** 執行一次備份；回傳每張表的結果。缺設定時不做任何事。單一資料表失敗不影響其他表。 */
export async function runDatabaseBackup(env: Env, now = new Date()): Promise<TableResult[] | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.BACKUPS) {
    console.warn("database backup skipped: missing Supabase settings or BACKUPS binding");
    return null;
  }
  const bucket = env.BACKUPS;
  const prefix = `weekly/${taipeiDate(now)}`;
  const results: TableResult[] = [];
  let fetches = 0;
  let truncated = false;

  for (const [table, order] of BACKUP_TABLES) {
    const result: TableResult = { table, rows: 0, pages: 0 };
    results.push(result);
    try {
      for (let offset = 0; ; offset += BACKUP_PAGE_SIZE) {
        if (fetches >= BACKUP_FETCH_BUDGET) { truncated = true; result.error = "fetch budget exhausted"; break; }
        fetches += 1;
        const url = `${env.SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}&limit=${BACKUP_PAGE_SIZE}&offset=${offset}`;
        const response = await fetchWithTimeout(url, { headers: { ...serviceHeaders(env, "count=exact"), Accept: "application/json" } });
        if (!response.ok) {
          await response.arrayBuffer();
          throw new Error(`HTTP ${response.status}`);
        }
        const total = totalFromContentRange(response.headers.get("Content-Range"));
        const body = await response.arrayBuffer();
        await bucket.put(`${prefix}/${table}/${String(result.pages).padStart(3, "0")}.json`, body, { httpMetadata: { contentType: "application/json" } });
        result.pages += 1;
        if (total === null) throw new Error("missing Content-Range total");
        result.rows = total;
        if (offset + BACKUP_PAGE_SIZE >= total) break;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : "unknown error";
    }
    if (truncated) break;
  }

  const failed = results.filter((item) => item.error);
  const manifest = { created_at: now.toISOString(), complete: failed.length === 0 && !truncated, tables: results };
  await bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), { httpMetadata: { contentType: "application/json" } });
  if (failed.length || truncated) console.error(`database backup incomplete: ${failed.map((item) => `${item.table} (${item.error})`).join(", ")}`);
  return results;
}
