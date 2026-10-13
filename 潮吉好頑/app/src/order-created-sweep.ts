// 建單通知補發：資料庫已建單、但 Worker 沒收到 RPC 回應（逾時、斷線）時，POST /api/orders 不會觸發建單通知。
// 每小時排程找出近期仍待付款、卻沒有任何 created 通知紀錄的訂單補送；通知以 event key `created:<id>` 去重，
// 與正常流程或另一次排程同時送出也不會重複。
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { notifyOrderEvent, orderNotificationsConfigured } from "./notifications";

// 建立不到這段時間的訂單交給正常流程（回應後的 waitUntil）處理
export const CREATED_SWEEP_GRACE_MS = 5 * 60 * 1000;
// 只補近期訂單：太久以前的建單通知對客人已沒有意義
export const CREATED_SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
// 每次最多補送的筆數，避免積壓時用完單次執行的子請求額度
export const CREATED_SWEEP_LIMIT = 20;

export async function notifyMissedCreatedOrders(env: Env, now = new Date()) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !orderNotificationsConfigured(env)) return;
  const headers = serviceHeaders(env);
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id");
  // 已付款、已取消，或宅配已通知運費的訂單不再補「訂單已成立」（與重試時的過期判斷一致）
  url.searchParams.set("status", "eq.pending_payment");
  url.searchParams.set("shipping_fee_notified_at", "is.null");
  url.searchParams.append("created_at", `gte.${new Date(now.getTime() - CREATED_SWEEP_WINDOW_MS).toISOString()}`);
  url.searchParams.append("created_at", `lte.${new Date(now.getTime() - CREATED_SWEEP_GRACE_MS).toISOString()}`);
  url.searchParams.set("order", "created_at.asc,id.asc");
  url.searchParams.set("limit", "200");
  const ordersResponse = await fetchWithTimeout(url, { headers });
  if (!ordersResponse.ok) return;
  const orderIds = (await ordersResponse.json() as Array<{ id?: unknown }>)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
  if (!orderIds.length) return;

  const deliveriesUrl = new URL(`${env.SUPABASE_URL}/rest/v1/notification_deliveries`);
  deliveriesUrl.searchParams.set("select", "event_key");
  deliveriesUrl.searchParams.set("event_key", `in.(${orderIds.map((id) => `created:${id}`).join(",")})`);
  const deliveriesResponse = await fetchWithTimeout(deliveriesUrl, { headers });
  // 讀不到通知紀錄時不猜測，下一次排程再試
  if (!deliveriesResponse.ok) return;
  const notified = new Set((await deliveriesResponse.json() as Array<{ event_key?: unknown }>).map((row) => row.event_key));
  const missing = orderIds.filter((id) => !notified.has(`created:${id}`)).slice(0, CREATED_SWEEP_LIMIT);
  for (const orderId of missing) {
    await notifyOrderEvent(env, orderId, "created").catch((error) => console.error("建單通知補發失敗", orderId, error instanceof Error ? error.message : "unknown"));
  }
}
