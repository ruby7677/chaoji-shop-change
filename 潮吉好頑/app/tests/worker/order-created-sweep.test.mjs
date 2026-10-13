// 建單通知補發：資料庫已建單但 Worker 沒收到回應時，每小時排程補送缺少 created 通知紀錄的訂單。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const sweep = await loadSourceModule("order-created-sweep.ts");
const NOW = new Date("2026-10-13T10:00:00Z");
const id = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeDb({ orders = [], notified = [], ordersFail = false, deliveriesFail = false } = {}) {
  const seen = { orderQuery: null, deliveryQuery: null, notificationLoads: [] };
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/rest/v1/orders" && url.searchParams.get("select") === "id") {
      seen.orderQuery = url.searchParams;
      return ordersFail ? new Response("busy", { status: 503 }) : jsonResponse(orders.map((orderId) => ({ id: orderId })));
    }
    if (url.pathname === "/rest/v1/notification_deliveries") {
      seen.deliveryQuery = url.searchParams;
      return deliveriesFail ? new Response("busy", { status: 503 }) : jsonResponse(notified.map((orderId) => ({ event_key: `created:${orderId}` })));
    }
    // notifyOrderEvent 讀訂單明細：只記錄是哪一筆，回空列表示這次不寄送
    if (url.pathname === "/rest/v1/orders") { seen.notificationLoads.push(url.searchParams.get("id")); return jsonResponse([]); }
    throw new Error(`unexpected request: ${url}`);
  });
  return seen;
}

test("an order with no created notification record is notified", async () => {
  const seen = fakeDb({ orders: [id(1), id(2)], notified: [id(1)] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, [`eq.${id(2)}`]);
});

test("only recent, still unpaid orders past the grace period are swept", async () => {
  const seen = fakeDb({ orders: [] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.equal(seen.orderQuery.get("status"), "eq.pending_payment");
  assert.equal(seen.orderQuery.get("shipping_fee_notified_at"), "is.null", "a home order whose fee was already sent is not told to wait again");
  assert.deepEqual(seen.orderQuery.getAll("created_at"), [
    `gte.${new Date(NOW.getTime() - sweep.CREATED_SWEEP_WINDOW_MS).toISOString()}`,
    `lte.${new Date(NOW.getTime() - sweep.CREATED_SWEEP_GRACE_MS).toISOString()}`
  ]);
});

test("the delivery lookup asks for exactly the created keys of the swept orders", async () => {
  const seen = fakeDb({ orders: [id(1), id(2)], notified: [id(1), id(2)] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.equal(seen.deliveryQuery.get("event_key"), `in.(created:${id(1)},created:${id(2)})`);
  assert.deepEqual(seen.notificationLoads, [], "already notified orders are not sent again");
});

test("an unreadable notification log sends nothing and waits for the next run", async () => {
  const seen = fakeDb({ orders: [id(1)], deliveriesFail: true });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.deepEqual(seen.notificationLoads, []);
});

test("an unreadable order list sends nothing", async () => {
  const seen = fakeDb({ ordersFail: true });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.equal(seen.deliveryQuery, null);
});

test("one run notifies at most the per-run limit", async () => {
  const orders = Array.from({ length: sweep.CREATED_SWEEP_LIMIT + 5 }, (_, n) => id(n + 1));
  const seen = fakeDb({ orders });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  assert.equal(seen.notificationLoads.length, sweep.CREATED_SWEEP_LIMIT);
  assert.equal(seen.notificationLoads[0], `eq.${id(1)}`, "the oldest orders go first");
});

test("nothing is queried when no notification channel is configured", async () => {
  const seen = fakeDb({ orders: [id(1)] });
  await sweep.notifyMissedCreatedOrders({ ...baseEnv, LINE_NOTIFY_ENABLED: "false", TELEGRAM_NOTIFY_ENABLED: "false" }, NOW);
  assert.equal(seen.orderQuery, null);
});

test("the hourly schedule runs the created-order sweep", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  const scheduled = source.slice(source.indexOf("scheduled("));
  assert.ok(scheduled.indexOf("notifyMissedCreatedOrders(env)") > scheduled.indexOf(": Promise.all(["), "runs in the hourly branch, not the 5-minute one");
});
