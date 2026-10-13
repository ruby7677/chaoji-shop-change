// 建單通知補發：資料庫已建單、但 Worker 沒收到 RPC 回應（逾時、斷線）時，POST /api/orders 不會觸發建單通知。
// 每 5 分鐘排程找出近期仍待付款、且有收件人還沒有 created 通知紀錄的訂單補送。
// 每位收件人的通知由 claim（channel＋event key＋收件人唯一）保護，與正常流程或重試同時執行時只有一方會取得；
// 與其他通知相同為「至少一次」：服務商已收下但完成紀錄寫入失敗時，重試仍可能再送一次。
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { createdNoticeRecipients, resendCreatedNotice } from "./notifications";

// 建立不到這段時間的訂單交給正常流程（回應後的 waitUntil）處理
export const CREATED_SWEEP_GRACE_MS = 5 * 60 * 1000;
// 只補近期訂單：太久以前的建單通知對客人已沒有意義
export const CREATED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 每次最多補送的筆數：每筆約 1＋3×收件人數次子請求，與同一排程的通知重試共用單次執行額度
export const CREATED_SWEEP_LIMIT = 2;
export const CREATED_SWEEP_PAGE_SIZE = 100;
export const CREATED_SWEEP_MAX_PAGES = 3;
// 只用來判斷是否有任何管道啟用：LINE 啟用時任何會員都有一位 LINE 收件人
const PROBE_LINE_USER = "probe";

type CandidateRow = { id?: unknown; created_at?: unknown; profiles?: { line_user_id?: unknown } | null };
type Candidate = { id: string; createdAt: string; lineUserId: string | null };

const recipientKey = (channel: string, recipientId: string) => `${channel}:${recipientId}`;

export async function notifyMissedCreatedOrders(env: Env, now = new Date()) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !createdNoticeRecipients(env, PROBE_LINE_USER).length) return;
  const since = new Date(now.getTime() - CREATED_SWEEP_WINDOW_MS).toISOString();
  const until = new Date(now.getTime() - CREATED_SWEEP_GRACE_MS).toISOString();
  const missing: string[] = [];
  let cursor: Candidate | null = null;
  // 以 (created_at, id) 游標往後翻頁：已通知或沒有收件人的訂單不會卡住後面的訂單
  for (let page = 0; page < CREATED_SWEEP_MAX_PAGES && missing.length < CREATED_SWEEP_LIMIT; page += 1) {
    const candidates = await loadCandidates(env, since, until, cursor);
    if (!candidates) return;
    if (!candidates.length) break;
    const pending = candidates.filter((order) => createdNoticeRecipients(env, order.lineUserId).length > 0);
    const recorded = pending.length ? await recordedRecipients(env, pending.map((order) => order.id)) : new Map<string, Set<string>>();
    // 讀不到通知紀錄時不猜測，下一次排程再試
    if (!recorded) return;
    for (const order of pending) {
      const done = recorded.get(order.id) ?? new Set<string>();
      const expected = createdNoticeRecipients(env, order.lineUserId);
      if (expected.some((recipient) => !done.has(recipientKey(recipient.channel, recipient.recipientId)))) missing.push(order.id);
      if (missing.length >= CREATED_SWEEP_LIMIT) break;
    }
    if (candidates.length < CREATED_SWEEP_PAGE_SIZE) break;
    cursor = candidates[candidates.length - 1];
  }
  for (const orderId of missing) {
    await resendCreatedNotice(env, orderId).catch((error) => console.error("建單通知補發失敗", orderId, error instanceof Error ? error.message : "unknown"));
  }
}

async function loadCandidates(env: Env, since: string, until: string, cursor: Candidate | null): Promise<Candidate[] | null> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id,created_at,profiles!orders_member_id_fkey(line_user_id)");
  // 已付款、已取消，或宅配已通知運費的訂單不再補「訂單已成立」；送出前會以當下訂單再確認一次
  url.searchParams.set("status", "eq.pending_payment");
  url.searchParams.set("shipping_fee_notified_at", "is.null");
  url.searchParams.append("created_at", `gte.${since}`);
  url.searchParams.append("created_at", `lte.${until}`);
  if (cursor) url.searchParams.set("or", `(created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id}))`);
  url.searchParams.set("order", "created_at.asc,id.asc");
  url.searchParams.set("limit", String(CREATED_SWEEP_PAGE_SIZE));
  const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
  if (!response.ok) return null;
  return (await response.json() as CandidateRow[]).flatMap((row) => {
    if (typeof row.id !== "string" || !/^[0-9a-f-]{36}$/i.test(row.id) || typeof row.created_at !== "string") return [];
    const lineUserId = typeof row.profiles?.line_user_id === "string" && row.profiles.line_user_id ? row.profiles.line_user_id : null;
    return [{ id: row.id, createdAt: row.created_at, lineUserId }];
  });
}

/** 每筆訂單已有 created 通知紀錄的收件人（channel:recipient）；讀取失敗回 null。 */
async function recordedRecipients(env: Env, orderIds: string[]): Promise<Map<string, Set<string>> | null> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/notification_deliveries`);
  url.searchParams.set("select", "event_key,channel,recipient_id");
  url.searchParams.set("event_key", `in.(${orderIds.map((id) => `created:${id}`).join(",")})`);
  const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
  if (!response.ok) return null;
  const rows = await response.json() as Array<{ event_key?: unknown; channel?: unknown; recipient_id?: unknown }>;
  const recorded = new Map<string, Set<string>>();
  for (const row of rows) {
    if (typeof row.event_key !== "string" || typeof row.channel !== "string" || typeof row.recipient_id !== "string") continue;
    const orderId = row.event_key.slice("created:".length);
    if (!recorded.has(orderId)) recorded.set(orderId, new Set());
    recorded.get(orderId)!.add(recipientKey(row.channel, row.recipient_id));
  }
  return recorded;
}
