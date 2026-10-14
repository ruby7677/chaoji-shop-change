// 取消通知補送：已取消、但還沒交給通知狀態機的訂單（cancellation_notified_at 為空）由每 5 分鐘排程依剩餘子請求額度逐筆送出。
// 每筆的所有收件人都取得 claim 後立刻標記，之後的失敗由通知重試接手；標記失敗的訂單下次再送時 claim 已存在，
// 只多花 claim 的子請求，不會重複通知。積壓再多，每次執行也只處理額度內的筆數，不會超過 Workers Free 的 50 次上限。
import { type Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { notifyOrderEvent } from "./notifications";
import { orderNoticeCost } from "./order-created-sweep";

// 只補近期取消的訂單：晚了幾天的取消通知已沒有意義，也讓一直失敗的訂單不會永遠占用額度
export const CANCELLED_SWEEP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** 每筆取消補送最多用掉的子請求：一筆訂單通知加上標記 1 次。 */
function cancelledOrderCost(env: Env) {
  return orderNoticeCost(env) + 1;
}

/** 替取消補送保留的額度：查詢 1 次＋一筆訂單。 */
export function cancelledSweepReserve(env: Env) {
  return 1 + cancelledOrderCost(env);
}

async function markCancellationNotified(env: Env, orderId: string) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("status", "eq.cancelled");
  url.searchParams.set("cancellation_notified_at", "is.null");
  await fetchWithTimeout(url, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ cancellation_notified_at: new Date().toISOString() })
  });
}

/**
 * 在可用子請求數內補送取消通知，最近取消的先送（舊訂單一直失敗也不會擋住新的取消）。
 * 依序處理，每筆送完就標記；回傳標記的筆數。
 */
export async function notifyMissedCancelledOrders(env: Env, budget: number, now = new Date()): Promise<number> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return 0;
  const limit = Math.floor((budget - 1) / cancelledOrderCost(env));
  if (limit < 1) return 0;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id");
  url.searchParams.set("status", "eq.cancelled");
  url.searchParams.set("cancellation_notified_at", "is.null");
  url.searchParams.set("cancelled_at", `gte.${new Date(now.getTime() - CANCELLED_SWEEP_WINDOW_MS).toISOString()}`);
  url.searchParams.set("order", "cancelled_at.desc,id.desc");
  url.searchParams.set("limit", String(limit));
  const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
  if (!response.ok) return 0;
  const rows = await response.json() as Array<{ id?: unknown }>;
  const orderIds = rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, limit);
  let marked = 0;
  for (const orderId of orderIds) {
    try {
      // 有收件人沒取得 claim 就不標記，下次排程再送
      if (!await notifyOrderEvent(env, orderId, "status_changed")) continue;
      await markCancellationNotified(env, orderId);
      marked += 1;
    } catch (error) {
      console.error("取消通知補送失敗", orderId, error instanceof Error ? error.message : "unknown");
    }
  }
  return marked;
}
