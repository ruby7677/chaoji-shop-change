// 建單通知補發：資料庫已建單但 Worker 沒收到回應時，每 5 分鐘排程（沒有待重試通知時）輪流掃描一段時間，補送仍缺 created 通知紀錄的收件人。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { LINE_USER_ID, baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const sweep = await loadSourceModule("order-created-sweep.ts");
const NOW = new Date("2026-10-13T10:00:00Z");
const id = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
// 預設建立時間落在 NOW 這次要掃的時間段內（依序相差 1 毫秒）
const createdAt = (n) => new Date(Date.parse(sweep.sweepSlice(NOW).since) + 1000 + n).toISOString();
// baseEnv：LINE 啟用、Telegram 管理員 111 與 222
const ALL_RECIPIENTS = [["line", LINE_USER_ID], ["telegram", "111"], ["telegram", "222"]];

let restoreFetch = () => {};
afterEach(() => restoreFetch());

/**
 * orders：候選訂單編號（依建立時間排序）；recorded：{ 訂單編號: [[channel, recipient]] } 已有的通知紀錄；
 * current：補發時讀到的訂單欄位。claim 一律回「已送出」，只記錄哪些收件人被 claim。
 */
function fakeDb({ orders = [], recorded = {}, lineUserIds = {}, createdAts = {}, current = {}, ordersFail = false, deliveriesFail = false } = {}) {
  const seen = { pages: [], deliveryQueries: [], notificationLoads: [], claims: [] };
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/rest/v1/orders" && url.searchParams.get("select").startsWith("id,created_at")) {
      seen.pages.push(url.searchParams);
      if (ordersFail) return new Response("busy", { status: 503 });
      // 依 created_at 範圍篩選（ISO 字串可直接比較），再依游標往後取一頁
      const [gte, lte] = url.searchParams.getAll("created_at").map((filter) => filter.slice(4));
      const rows = orders
        .map((orderId) => ({ id: orderId, created_at: createdAts[orderId] ?? createdAt(orders.indexOf(orderId)), profiles: { line_user_id: orderId in lineUserIds ? lineUserIds[orderId] : LINE_USER_ID } }))
        .filter((row) => row.created_at >= gte && row.created_at <= lte)
        .sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? -1 : 1) : x.created_at < y.created_at ? -1 : 1));
      if (url.searchParams.get("order") === "created_at.desc,id.desc") rows.reverse();
      const or = url.searchParams.get("or");
      const after = or ? rows.findIndex((row) => or.includes(`id.gt.${row.id}`) || or.includes(`id.lt.${row.id}`)) + 1 : 0;
      return jsonResponse(rows.slice(after, after + Number(url.searchParams.get("limit"))));
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

test("only still unpaid orders in this run's time slice are scanned", async () => {
  const seen = fakeDb({ orders: [] });
  await sweep.notifyMissedCreatedOrders(baseEnv, NOW);
  const query = seen.pages[0];
  const slice = sweep.sweepSlice(NOW);
  assert.equal(query.get("status"), "eq.pending_payment");
  assert.equal(query.get("shipping_fee_notified_at"), "is.null");
  assert.deepEqual(query.getAll("created_at"), [`gte.${slice.since}`, `lte.${slice.until}`]);
});

test("rotating slices cover the whole window, from the grace period back to 24 hours, within an hour", () => {
  const runs = Array.from({ length: sweep.CREATED_SWEEP_SLICES }, (_, n) => sweep.sweepSlice(new Date(NOW.getTime() + n * 5 * 60 * 1000)));
  assert.deepEqual(new Set(runs.map((run) => run.index)).size, sweep.CREATED_SWEEP_SLICES, "every slice is visited once per cycle");
  // 同一時間點換算每一段，檢查段與段首尾相接、涵蓋整個視窗
  const at = NOW.getTime();
  const sliceMs = Math.ceil((sweep.CREATED_SWEEP_WINDOW_MS - sweep.CREATED_SWEEP_GRACE_MS) / sweep.CREATED_SWEEP_SLICES);
  let newest = at - sweep.CREATED_SWEEP_GRACE_MS;
  for (let index = 0; index < sweep.CREATED_SWEEP_SLICES; index += 1) newest = Math.max(at - sweep.CREATED_SWEEP_WINDOW_MS, newest - sliceMs);
  assert.equal(newest, at - sweep.CREATED_SWEEP_WINDOW_MS, "the oldest slice reaches the start of the window");
});

test("an order newer than more notified orders than one run can page through is reached when the direction flips", async () => {
  // 同一段內：已通知、仍待付款的訂單多於單次可翻的頁數，漏發的訂單比它們都新
  const cycle = sweep.CREATED_SWEEP_SLICES * 5 * 60 * 1000;
  const oldestFirstRun = new Date(Math.floor(NOW.getTime() / (2 * cycle)) * 2 * cycle);
  const newestFirstRun = new Date(oldestFirstRun.getTime() + cycle);
  assert.equal(sweep.sweepSlice(oldestFirstRun).newestFirst, false);
  assert.equal(sweep.sweepSlice(newestFirstRun).newestFirst, true);
  assert.equal(sweep.sweepSlice(newestFirstRun).index, sweep.sweepSlice(oldestFirstRun).index, "the same slice one cycle later");
  const busy = Array.from({ length: sweep.CREATED_SWEEP_PAGE_SIZE * sweep.CREATED_SWEEP_MAX_PAGES + 1 }, (_, n) => id(n + 1));
  const lost = id(9999);
  // 兩次執行的段落重疊處：訂單建立在第二次那段的開頭之後、第一次那段的結尾之前
  const start = Date.parse(sweep.sweepSlice(newestFirstRun).since) + 1000;
  const createdAts = Object.fromEntries(busy.map((orderId, n) => [orderId, new Date(start + n).toISOString()]));
  createdAts[lost] = new Date(start + busy.length + 1).toISOString();
  const recorded = Object.fromEntries(busy.map((orderId) => [orderId, ALL_RECIPIENTS]));
  const orders = [...busy, lost];
  let seen = fakeDb({ orders, createdAts, recorded });
  await sweep.notifyMissedCreatedOrders(baseEnv, newestFirstRun);
  assert.deepEqual(seen.notificationLoads, [lost], "newest first reaches it before the notified backlog");
  seen = fakeDb({ orders, createdAts: Object.fromEntries(Object.entries(createdAts).map(([key, value]) => [key, new Date(Date.parse(value) - cycle).toISOString()])), recorded });
  await sweep.notifyMissedCreatedOrders(baseEnv, oldestFirstRun);
  assert.deepEqual(seen.notificationLoads, [], "oldest first alone is stuck behind the backlog");
});

test("the resend stops before it would exceed the run's subrequest budget", async () => {
  // 20 位 Telegram 管理員＋1 位 LINE 會員：一筆補發約 64 次子請求，超過預算就不補，留給收件人較少的設定
  const admins = Array.from({ length: 20 }, (_, n) => String(1000 + n)).join(",");
  const seen = fakeDb({ orders: [id(1)] });
  await sweep.notifyMissedCreatedOrders({ ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: admins }, NOW);
  assert.deepEqual(seen.notificationLoads, []);
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

test("the 5-minute schedule sweeps only after a retry run with no backlog", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  const scheduled = source.slice(source.indexOf("scheduled("));
  const fiveMinute = scheduled.slice(scheduled.indexOf("\"*/5 * * * *\""), scheduled.indexOf(": Promise.all(["));
  assert.ok(fiveMinute.includes("retryDueNotificationDeliveries(env)"));
  assert.ok(fiveMinute.includes("retried === 0 ? notifyMissedCreatedOrders(env"), "the sweep does not share a busy retry run's subrequests");
});
