// 建單通知補發：資料庫已建單但 Worker 沒收到回應時，每 5 分鐘排程補送仍缺 created 通知紀錄的收件人。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const sweep = await loadSourceModule("order-created-sweep.ts");
const NOW = new Date("2026-10-13T10:00:00Z");
const id = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const createdAt = (n) => new Date(Date.UTC(2026, 9, 13, 8, 0, 0, n)).toISOString();
// baseEnv：LINE 啟用、Telegram 管理員 111 與 222
const ALL_RECIPIENTS = [["line", LINE_USER_ID], ["telegram", "111"], ["telegram", "222"]];

let restoreFetch = () => {};
afterEach(() => restoreFetch());

/**
 * orders：候選訂單編號（依建立時間排序）；recorded：{ 訂單編號: [[channel, recipient]] } 已有的通知紀錄；
 * current：補發時讀到的訂單欄位。claim 一律回「已送出」，只記錄哪些收件人被 claim。
 */
function fakeDb({ orders = [], recorded = {}, lineUserIds = {}, current = {}, ordersFail = false, deliveriesFail = false } = {}) {
  const seen = { pages: [], deliveryQueries: [], notificationLoads: [], claims: [] };
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/rest/v1/orders" && url.searchParams.get("select").startsWith("id,created_at")) {
      seen.pages.push(url.searchParams);
      if (ordersFail) return new Response("busy", { status: 503 });
      const or = url.searchParams.get("or");
      const after = or ? orders.findIndex((orderId) => or.includes(`id.gt.${orderId}`)) + 1 : 0;
      const limit = Number(url.searchParams.get("limit"));
      return jsonResponse(orders.slice(after, after + limit).map((orderId) => ({
        id: orderId,
        created_at: createdAt(orders.indexOf(orderId)),
        profiles: { line_user_id: orderId in lineUserIds ? lineUserIds[orderId] : LINE_USER_ID }
      })));
    }
    if (url.pathname === "/rest/v1/notification_deliveries") {
      seen.deliveryQueries.push(url.searchParams.get("event_key"));
      if (deliveriesFail) return new Response("busy", { status: 503 });
      return jsonResponse(Object.entries(recorded).flatMap(([orderId, recipients]) =>
        recipients.map(([channel, recipient]) => ({ event_key: `created:${orderId}`, channel, recipient_id: recipient }))));
    }
    if (url.pathname === "/rest/v1/orders") {
      const orderId = url.searchParams.get("id").slice(3);
      seen.notificationLoads.push(orderId);
      return jsonResponse([{
        id: orderId, order_number: "CJ1", status: "pending_payment", delivery_method: "store_pickup", shipping_fee_notified_at: null,
        subtotal: 100, coupon_discount: 0, point_discount: 0, amount_due: 100, deposit_due: 100, payment_deadline: NOW.toISOString(),
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

test("an order with no created notification record is resent to every recipient", async () => {
  const seen = fakeDb({ orders: [id(1)] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, [id(1)]);
  assert.deepEqual(seen.claims.sort(), ALL_RECIPIENTS.map(([channel, recipient]) => `${channel}:${recipient}:created:${id(1)}`).sort());
});

test("an order whose LINE claim never got a row is resent even though Telegram was recorded", async () => {
  const seen = fakeDb({ orders: [id(1)], recorded: { [id(1)]: [["telegram", "111"], ["telegram", "222"]] } });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, [id(1)], "one recipient's record does not hide another's gap");
});

test("an order recorded for every recipient is not resent", async () => {
  const seen = fakeDb({ orders: [id(1)], recorded: { [id(1)]: ALL_RECIPIENTS } });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, []);
  assert.deepEqual(seen.deliveryQueries, [`in.(created:${id(1)})`]);
});

for (const [label, current] of [
  ["cancelled", { status: "cancelled" }],
  ["paid", { status: "pending_review" }],
  ["told its home fee", { delivery_method: "home_delivery", shipping_fee_notified_at: NOW.toISOString() }]
]) {
  test(`an order that was ${label} after the scan is not sent a created notice`, async () => {
    const seen = fakeDb({ orders: [id(1)], current });
    await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
    assert.deepEqual(seen.notificationLoads, [id(1)]);
    assert.deepEqual(seen.claims, [], "the stale notice is never claimed");
  });
}

test("only recent, still unpaid orders past the grace period are scanned", async () => {
  const seen = fakeDb({ orders: [] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  const query = seen.pages[0];
  assert.equal(query.get("status"), "eq.pending_payment");
  assert.equal(query.get("shipping_fee_notified_at"), "is.null");
  assert.deepEqual(query.getAll("created_at"), [
    `gte.${new Date(NOW.getTime() - sweep.CREATED_SWEEP_WINDOW_MS).toISOString()}`,
    `lte.${new Date(NOW.getTime() - sweep.CREATED_SWEEP_GRACE_MS).toISOString()}`
  ]);
});

test("a full page of notified orders does not stall the scan: the next page is read", async () => {
  const orders = Array.from({ length: sweep.CREATED_SWEEP_PAGE_SIZE + 1 }, (_, n) => id(n + 1));
  const recorded = Object.fromEntries(orders.slice(0, -1).map((orderId) => [orderId, ALL_RECIPIENTS]));
  const seen = fakeDb({ orders, recorded });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.equal(seen.pages.length, 2);
  assert.ok(seen.pages[1].get("or").includes(`id.gt.${orders[sweep.CREATED_SWEEP_PAGE_SIZE - 1]}`));
  assert.deepEqual(seen.notificationLoads, [orders.at(-1)]);
});

test("orders without any recipient never take the per-run slots", async () => {
  const lineOnly = { ...baseEnv, TELEGRAM_NOTIFY_ENABLED: "false" };
  const seen = fakeDb({ orders: [id(1), id(2), id(3)], lineUserIds: { [id(1)]: null, [id(2)]: null } });
  await sweep.notifyMissedCreatedOrders(lineOnly, NOW);
  assert.deepEqual(seen.notificationLoads, [id(3)]);
});

test("one run resends at most the per-run limit, oldest first", async () => {
  const orders = Array.from({ length: sweep.CREATED_SWEEP_LIMIT + 3 }, (_, n) => id(n + 1));
  const seen = fakeDb({ orders });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, orders.slice(0, sweep.CREATED_SWEEP_LIMIT));
});

test("an unreadable notification log sends nothing and waits for the next run", async () => {
  const seen = fakeDb({ orders: [id(1)], deliveriesFail: true });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, []);
});

test("an unreadable order list sends nothing", async () => {
  const seen = fakeDb({ ordersFail: true });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.deliveryQueries, []);
});

test("nothing is queried when no notification channel is enabled", async () => {
  const seen = fakeDb({ orders: [id(1)] });
  await sweep.notifyMissedCreatedOrders({ ...baseEnv, LINE_NOTIFY_ENABLED: "false", TELEGRAM_NOTIFY_ENABLED: "false" }, NOW);
  assert.deepEqual(seen.pages, []);
});

test("the 5-minute schedule runs the created-order sweep", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  const scheduled = source.slice(source.indexOf("scheduled("));
  const fiveMinute = scheduled.slice(scheduled.indexOf("? Promise.all(["), scheduled.indexOf(": Promise.all(["));
  assert.ok(fiveMinute.includes("notifyMissedCreatedOrders(env)"));
});
