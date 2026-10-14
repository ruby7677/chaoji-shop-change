// 每 5 分鐘的通知排程：先重試到期的通知，剩下的子請求額度（Workers Free 每次 50）給建單通知補發與取消通知補送。
// 額度夠兩者各處理一筆時，建單補發先扣掉替取消補送保留的額度；不夠時（收件人很多）每 5 分鐘輪流優先，
// 先跑的拿到全部額度、後跑的用剩下的，兩者都有積壓時仍會輪流前進。
import { type Env } from "./env";
import { retryDueNotificationDeliveries } from "./notification-delivery";
import { cancelledSweepReserve, notifyMissedCancelledOrders } from "./order-cancelled-sweep";
import { notifyMissedCreatedOrders, orderNoticeCost, scheduledRetryBatch, scheduledSweepBudget } from "./order-created-sweep";

const SLOT_MS = 5 * 60 * 1000;

type Sweep = { reserve: number; perOrder: number; run: (budget: number) => Promise<number> };

/** 執行一種補送；回傳實際可能用掉的子請求數（查詢 1 次＋處理筆數×每筆上限）。失敗時當作整份額度都已用掉。 */
async function runSweep(sweep: Sweep, budget: number, label: string) {
  if (budget < sweep.reserve) return 0;
  const processed = await sweep.run(budget).catch((error) => {
    console.error(label, error instanceof Error ? error.message : "unknown");
    return null;
  });
  return processed === null ? budget : Math.min(budget, 1 + processed * sweep.perOrder);
}

export async function runFiveMinuteNotifications(env: Env, now: Date) {
  const retried = await retryDueNotificationDeliveries(env, scheduledRetryBatch(env));
  const budget = scheduledSweepBudget(retried);
  const cost = orderNoticeCost(env);
  const created: Sweep = { reserve: 1 + cost, perOrder: cost, run: (allowed) => notifyMissedCreatedOrders(env, allowed, now) };
  const cancelled: Sweep = { reserve: cancelledSweepReserve(env), perOrder: cost + 1, run: (allowed) => notifyMissedCancelledOrders(env, allowed, now) };
  const bothFit = budget >= created.reserve + cancelled.reserve;
  const cancelledFirst = !bothFit && Math.floor(now.getTime() / SLOT_MS) % 2 === 1;
  const [first, second] = cancelledFirst ? [cancelled, created] : [created, cancelled];
  const used = await runSweep(first, bothFit ? budget - second.reserve : budget, first === created ? "建單通知補發失敗" : "取消通知補送失敗");
  await runSweep(second, budget - used, second === created ? "建單通知補發失敗" : "取消通知補送失敗");
}
