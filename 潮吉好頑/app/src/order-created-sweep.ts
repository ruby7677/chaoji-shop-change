// 建單通知補發：資料庫已建單、但 Worker 沒收到 RPC 回應（逾時、斷線）時，POST /api/orders 不會觸發建單通知。
// 每 5 分鐘排程由資料庫 missing_created_notifications（202610130003）直接找出仍待付款、且有預期收件人缺 created 紀錄的訂單，
// 依付款期限由近到遠補送；已通知的訂單不會擋住後面的訂單。
// 每位收件人的通知由 claim（channel＋event key＋收件人唯一）保護，與正常流程或重試同時執行時只有一方會取得；
// 與其他通知相同為「至少一次」：服務商已收下但完成紀錄寫入失敗時，重試仍可能再送一次。
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { createdNoticeRecipients, resendCreatedNotice } from "./notifications";

// 建立不到這段時間的訂單交給正常流程（回應後的 waitUntil）處理
export const CREATED_SWEEP_GRACE_MS = 5 * 60 * 1000;
// 只補近期訂單：付款期限最長 24 小時，更早的訂單已不在待付款
export const CREATED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 只用來判斷 LINE 是否啟用與 Telegram 管理員名單：LINE 啟用時任何會員都有一位 LINE 收件人
const PROBE_LINE_USER = "probe";
// Workers Free 每次執行 50 個子請求，保留 2 次餘裕
const SUBREQUESTS_PER_RUN = 48;

/** 同一次排程的通知重試用掉後，留給補發的子請求數：重試查詢每管道 1 次，每筆補送最多 3 次。 */
export function scheduledSweepBudget(retried: number) {
  return Math.max(SUBREQUESTS_PER_RUN - 2 - 3 * retried, 0);
}

/**
 * 在可用子請求數內補送：查詢 1 次，每筆補發最多 1＋3×收件人數次（讀訂單；每位收件人 claim、送出、完成）。
 * 回傳補送的筆數。
 */
export async function notifyMissedCreatedOrders(env: Env, budget: number, now = new Date()): Promise<number> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const recipients = createdNoticeRecipients(env, PROBE_LINE_USER);
  if (!recipients.length) return 0;
  const limit = Math.floor((budget - 1) / (1 + 3 * recipients.length));
  if (limit < 1) return 0;
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/missing_created_notifications`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({
      p_since: new Date(now.getTime() - CREATED_SWEEP_WINDOW_MS).toISOString(),
      p_until: new Date(now.getTime() - CREATED_SWEEP_GRACE_MS).toISOString(),
      p_line_enabled: recipients.some((recipient) => recipient.channel === "line"),
      p_telegram_recipients: recipients.filter((recipient) => recipient.channel === "telegram").map((recipient) => recipient.recipientId),
      p_limit: limit
    })
  });
  if (!response.ok) return 0;
  const rows = await response.json() as Array<{ order_id?: unknown }>;
  const orderIds = rows
    .map((row) => row.order_id)
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, limit);
  for (const orderId of orderIds) {
    await resendCreatedNotice(env, orderId).catch((error) => console.error("建單通知補發失敗", orderId, error instanceof Error ? error.message : "unknown"));
  }
  return orderIds.length;
}
