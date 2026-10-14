// 建單通知補發：資料庫已建單但 Worker 沒收到回應時，每 5 分鐘排程由資料庫找出仍缺 created 通知的訂單補送。
// 資料庫端的比對（每位收件人、狀態、付款期限）在 tests/db/missing_created_notifications.test.sql。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const sweep = await loadSourceModule("order-created-sweep.ts");
const NOW = new Date("2026-10-13T10:00:00Z");
const id = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
// baseEnv：LINE 啟用、Telegram 管理員 111 與 222 → 每筆補發最多 1＋3×3＝10 次子請求
const PER_ORDER = 10;

let restoreFetch = () => {};
afterEach(() => restoreFetch());

/** missing：資料庫回傳的缺通知訂單；current：補發時讀到的訂單欄位。claim 一律回「已送出」，只記錄被 claim 的收件人。 */
function fakeDb({ missing = [], current = {}, rpcFail = false } = {}) {
  const seen = { rpcBodies: [], notificationLoads: [], claims: [], fetches: 0 };
  restoreFetch = stubFetch((url, _init, body) => {
    seen.fetches += 1;
    if (url.pathname === "/rest/v1/rpc/missing_created_notifications") {
      seen.rpcBodies.push(body);
      return rpcFail ? new Response("busy", { status: 503 }) : jsonResponse(missing.slice(0, body.p_limit).map((orderId) => ({ order_id: orderId, line_user_id: LINE_USER_ID })));
    }
    if (url.pathname === "/rest/v1/orders") {
      const orderId = url.searchParams.get("id").slice(3);
      seen.notificationLoads.push(orderId);
      return jsonResponse([{
        id: orderId, order_number: "CJ1", status: "pending_payment", delivery_method: "store_pickup", shipping_fee_notified_at: null,
        subtotal: 100, coupon_discount: 0, point_discount: 0, amount_due: 100, deposit_due: 100, payment_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        profiles: { full_name: "會員", line_user_id: LINE_USER_ID }, order_items: [], ...current
      }]);
    }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      seen.claims.push(`${body.p_channel}:${body.p_recipient_id}:${body.p_event_key}`);
      return jsonResponse({ id: "d", claim_token: "t", status: "sent", attempt_count: 1, payload: {}, claimed: false });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return seen;
}

test("the database lookup gets the window, the enabled channels and a budget-sized limit", async () => {
  const seen = fakeDb();
  await sweep.notifyMissedCreatedOrders(baseEnv, 41, NOW);
  assert.deepEqual(seen.rpcBodies, [{
    p_since: new Date(NOW.getTime() - sweep.CREATED_SWEEP_WINDOW_MS).toISOString(),
    p_until: new Date(NOW.getTime() - sweep.CREATED_SWEEP_GRACE_MS).toISOString(),
    p_line_enabled: true,
    p_telegram_recipients: ["111", "222"],
    p_limit: 4
  }]);
});

test("every missing order is resent to all its recipients", async () => {
  const seen = fakeDb({ missing: [id(1)] });
  const resent = await sweep.notifyMissedCreatedOrders(baseEnv, 46, NOW);
  assert.equal(resent, 1);
  assert.deepEqual(seen.claims.sort(), [`line:${LINE_USER_ID}:created:${id(1)}`, `telegram:111:created:${id(1)}`, `telegram:222:created:${id(1)}`].sort());
});

for (const [label, current] of [
  ["cancelled", { status: "cancelled" }],
  ["paid", { status: "pending_review" }],
  ["told its home fee", { delivery_method: "home_delivery", shipping_fee_notified_at: NOW.toISOString() }],
  ["past its payment deadline", { payment_deadline: new Date(Date.now() - 1000).toISOString() }]
]) {
  test(`an order that was ${label} after the lookup is not sent a created notice`, async () => {
    const seen = fakeDb({ missing: [id(1)], current });
    await sweep.notifyMissedCreatedOrders(baseEnv, 46, NOW);
    assert.deepEqual(seen.notificationLoads, [id(1)]);
    assert.deepEqual(seen.claims, [], "the stale notice is never claimed");
  });
}

test("the run stays within its subrequest budget", async () => {
  const seen = fakeDb({ missing: [id(1), id(2), id(3), id(4), id(5)] });
  const budget = 1 + 2 * PER_ORDER;
  await sweep.notifyMissedCreatedOrders(baseEnv, budget, NOW);
  assert.equal(seen.notificationLoads.length, 2);
  assert.ok(seen.fetches <= budget, `${seen.fetches} fetches within a budget of ${budget}`);
});

test("too small a budget sends nothing and does not even query", async () => {
  const seen = fakeDb({ missing: [id(1)] });
  assert.equal(await sweep.notifyMissedCreatedOrders(baseEnv, PER_ORDER, NOW), 0);
  assert.equal(seen.fetches, 0);
});

test("with LINE disabled only the Telegram admins are expected", async () => {
  const seen = fakeDb();
  await sweep.notifyMissedCreatedOrders({ ...baseEnv, LINE_NOTIFY_ENABLED: "false" }, 46, NOW);
  assert.equal(seen.rpcBodies[0].p_line_enabled, false);
  assert.deepEqual(seen.rpcBodies[0].p_telegram_recipients, ["111", "222"]);
});

test("nothing is queried when no notification channel is enabled", async () => {
  const seen = fakeDb({ missing: [id(1)] });
  await sweep.notifyMissedCreatedOrders({ ...baseEnv, LINE_NOTIFY_ENABLED: "false", TELEGRAM_NOTIFY_ENABLED: "false" }, 46, NOW);
  assert.equal(seen.fetches, 0);
});

test("a failed lookup sends nothing", async () => {
  const seen = fakeDb({ rpcFail: true });
  assert.equal(await sweep.notifyMissedCreatedOrders(baseEnv, 46, NOW), 0);
  assert.deepEqual(seen.notificationLoads, []);
});

for (const admins of [1, 2, 4]) {
  test(`with ${admins} Telegram admin(s) a full retry batch still leaves room for one resend and one cancellation`, async () => {
    const { cancelledSweepReserve } = await loadSourceModule("order-cancelled-sweep.ts");
    const env = { ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: Array.from({ length: admins }, (_, n) => String(100 + n)).join(",") };
    const batch = sweep.scheduledRetryBatch(env);
    const retried = 2 * batch;
    const perOrder = 1 + 3 * (1 + admins);
    assert.equal(sweep.orderNoticeCost(env), perOrder);
    const budget = sweep.scheduledSweepBudget(retried);
    assert.ok(budget - cancelledSweepReserve(env) >= 1 + perOrder, "the created sweep can query and resend one order");
    assert.ok(cancelledSweepReserve(env) >= 1 + perOrder + 1, "the cancelled sweep can query, send and mark one order");
    assert.ok(2 + 3 * retried + budget <= 50, "retry plus both sweeps fit in Workers Free");
  });
}

test("the retry batch never exceeds the shared per-channel cap", async () => {
  const { RETRY_BATCH_PER_CHANNEL } = await loadSourceModule("notification-delivery.ts");
  assert.ok(sweep.scheduledRetryBatch({ ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: "1" }) <= RETRY_BATCH_PER_CHANNEL);
  assert.ok(sweep.scheduledRetryBatch({ ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: Array.from({ length: 30 }, (_, n) => String(n + 1)).join(",") }) >= 1);
});

test("the 5-minute schedule sweeps with what the retry run left over", async () => {
  const { readFile } = await import("node:fs/promises");
  const index = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  const scheduled = index.slice(index.indexOf("scheduled("));
  assert.ok(scheduled.slice(scheduled.indexOf("\"*/5 * * * *\""), scheduled.indexOf(": Promise.all([")).includes("runFiveMinuteNotifications(env"));
  const schedule = await readFile(new URL("../../src/notification-schedule.ts", import.meta.url), "utf8");
  assert.ok(schedule.includes("retryDueNotificationDeliveries(env, scheduledRetryBatch(env))"));
  assert.ok(schedule.includes("scheduledSweepBudget(retried)"));
  assert.ok(schedule.indexOf("notifyMissedCreatedOrders(") < schedule.indexOf("notifyMissedCancelledOrders("));
});

test("the hourly schedule no longer retries notifications alongside its other jobs", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  const scheduled = source.slice(source.indexOf("scheduled("));
  const hourly = scheduled.slice(scheduled.indexOf(": Promise.all(["), scheduled.indexOf("ctx.waitUntil(task)"));
  assert.ok(!hourly.includes("retryDueNotificationDeliveries"));
});
