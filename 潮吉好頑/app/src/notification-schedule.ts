// 每 5 分鐘的通知排程：先重試到期的通知，剩下的子請求額度（Workers Free 每次 50）依序給建單通知補發與取消通知補送。
// 建單補發先扣掉替取消補送保留的一筆額度，兩者都有積壓時每次都各有進度。
import { type Env } from "./env";
import { retryDueNotificationDeliveries } from "./notification-delivery";
import { cancelledSweepReserve, notifyMissedCancelledOrders } from "./order-cancelled-sweep";
import { notifyMissedCreatedOrders, orderNoticeCost, scheduledRetryBatch, scheduledSweepBudget } from "./order-created-sweep";

export async function runFiveMinuteNotifications(env: Env, now: Date) {
  const retried = await retryDueNotificationDeliveries(env, scheduledRetryBatch(env));
  const budget = scheduledSweepBudget(retried);
  const createdBudget = Math.max(budget - cancelledSweepReserve(env), 0);
  const resent = await notifyMissedCreatedOrders(env, createdBudget, now).catch((error) => {
    console.error("建單通知補發失敗", error instanceof Error ? error.message : "unknown");
    return null;
  });
  // 補發失敗時不知道用了多少，當作整份額度都已用掉
  const createdUsed = resent === null ? createdBudget : Math.min(createdBudget, 1 + resent * orderNoticeCost(env));
  await notifyMissedCancelledOrders(env, budget - createdUsed, now);
}
