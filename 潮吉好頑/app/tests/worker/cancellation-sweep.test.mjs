// 取消通知補送（order-cancelled-sweep.ts，每 5 分鐘排程）：只處理近期未標記訂單、依子請求額度逐筆送出並標記、
// claim 失敗不標記、已處理的不再寫入；積壓再多每次執行也不超過 Workers Free 的 50 個子請求。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const sweep = await loadSourceModule("order-cancelled-sweep.ts");
const NOW = Date.UTC(2026, 9, 13, 5);
let restoreFetch = () => {};
afterEach(() => restoreFetch());

/** orders：{ id: { cancelledAt, lineUserId } }。列表依 cancelled_at 由新到舊、套用時間窗與 limit。 */
function fakeSupabase(orders) {
  const state = { marked: new Set(), logs: new Map(), failClaimFor: null, events: [], listQueries: [], fetches: 0 };
  restoreFetch = stubFetch((url, init, body) => {
    state.fetches += 1;
    const method = init.method || "GET";
    if (url.host === "api.line.me") { state.events.push(`LINE ${body.to}`); return jsonResponse({}); }
    if (url.host === "api.telegram.org") { state.events.push(`TG ${body.chat_id}`); return jsonResponse({ ok: true }); }
    const path = url.pathname;
    if (path === "/rest/v1/orders" && method === "GET" && url.searchParams.get("select") === "id") {
      state.listQueries.push(Object.fromEntries(url.searchParams));
      const since = Date.parse(url.searchParams.get("cancelled_at").slice(4));
      const rows = Object.entries(orders)
        .filter(([id, order]) => !state.marked.has(id) && Date.parse(order.cancelledAt) >= since)
        .sort(([, a], [, b]) => Date.parse(b.cancelledAt) - Date.parse(a.cancelledAt))
        .slice(0, Number(url.searchParams.get("limit")));
      return jsonResponse(rows.map(([id]) => ({ id })));
    }
    if (path === "/rest/v1/orders" && method === "GET") {
      const order = orders[url.searchParams.get("id").slice(3)];
      return jsonResponse([{
        order_number: "CJ-TEST", status: "cancelled", delivery_method: "store_pickup", bank_account_id: "bank", updated_at: order.cancelledAt,
        subtotal: 1000, coupon_discount: 0, point_discount: 0, amount_due: 1000, deposit_due: 1000, payment_deadline: order.cancelledAt,
        profiles: { full_name: "測試會員", line_user_id: order.lineUserId, is_admin: false },
        order_items: [{ product_name: "測試商品", variant_name: "單一規格", quantity: 1, kind: "in_stock" }]
      }]);
    }
    if (path === "/rest/v1/orders" && method === "PATCH") {
      const id = url.searchParams.get("id").slice(3);
      assert.equal(url.searchParams.get("cancellation_notified_at"), "is.null", "marking never overwrites an existing marker");
      assert.equal(url.searchParams.get("status"), "eq.cancelled");
      state.marked.add(id);
      state.events.push(`MARK ${id}`);
      return new Response(null, { status: 204 });
    }
    if (path === "/rest/v1/rpc/claim_notification_delivery") {
      if (state.failClaimFor && body.p_event_key.includes(state.failClaimFor)) return jsonResponse({ message: "unavailable" }, 503);
      const key = `${body.p_channel}|${body.p_event_key}|${body.p_recipient_id}`;
      if (state.logs.get(key) === "sent") return jsonResponse({ id: key, claim_token: "t", status: "sent", attempt_count: 1, payload: body.p_payload, claimed: false });
      state.logs.set(key, "processing");
      return jsonResponse({ id: key, claim_token: "t", status: "processing", attempt_count: 1, payload: body.p_payload, claimed: true });
    }
    if (path === "/rest/v1/rpc/complete_notification_delivery") {
      if (body.p_sent) state.logs.set(body.p_id, "sent");
      return jsonResponse(true);
    }
    // 通知重試（claim_due_notification_deliveries）與建單補發（missing_created_notifications）在這裡都沒有積壓
    return jsonResponse([]);
  });
  return state;
}

async function runCron(cron, env = baseEnv) {
  const context = ctx();
  worker.scheduled({ cron, scheduledTime: NOW }, env, context);
  await context.settle();
}
const runFiveMinute = (env) => runCron("*/5 * * * *", env);

const orderId = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORDER_1 = orderId(1);
const ORDER_2 = orderId(2);
const orders = {
  [ORDER_1]: { cancelledAt: "2026-10-13T01:00:00+00:00", lineUserId: "U" + "a".repeat(32) },
  [ORDER_2]: { cancelledAt: "2026-10-13T02:00:00+00:00", lineUserId: "U" + "b".repeat(32) }
};
function backlog(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, n) => [orderId(n + 1), { cancelledAt: new Date(NOW - (n + 1) * 60_000).toISOString(), lineUserId: "U" + String(n).padStart(32, "0") }]));
}

test("the sweep lists recent unmarked cancelled orders, newest first, sized to the budget", async () => {
  const state = fakeSupabase(orders);
  await runFiveMinute();
  assert.equal(state.listQueries.length, 1);
  const [query] = state.listQueries;
  assert.equal(query.status, "eq.cancelled");
  assert.equal(query.cancellation_notified_at, "is.null");
  assert.equal(query.cancelled_at, `gte.${new Date(NOW - sweep.CANCELLED_SWEEP_WINDOW_MS).toISOString()}`);
  assert.equal(query.order, "cancelled_at.desc,id.desc");
  // baseEnv：LINE＋Telegram 111、222 → 每筆 1＋3×3＋1＝11；48－2 重試查詢－1 建單補發查詢－1 列表 → 4 筆
  assert.equal(query.limit, "4");
});

test("an order is marked only after every recipient has a claim row", async () => {
  const state = fakeSupabase(orders);
  state.failClaimFor = ORDER_2;
  await runFiveMinute();
  assert.ok(state.marked.has(ORDER_1));
  assert.ok(!state.marked.has(ORDER_2), "an order whose claim failed stays unmarked");
  assert.deepEqual(state.events.filter((event) => event.startsWith("LINE")), [`LINE ${orders[ORDER_1].lineUserId}`]);

  state.failClaimFor = null;
  state.events.length = 0;
  await runFiveMinute();
  assert.ok(state.marked.has(ORDER_2), "the failed order is offered again on the next run");
  assert.deepEqual(state.events, ["TG 111", "TG 222", `LINE ${orders[ORDER_2].lineUserId}`, `MARK ${ORDER_2}`]);

  state.events.length = 0;
  await runFiveMinute();
  assert.deepEqual(state.events, [], "handled orders cause no further claims, sends or writes");
});

test("orders cancelled before the window are no longer offered", async () => {
  const state = fakeSupabase({ [ORDER_1]: { cancelledAt: new Date(NOW - sweep.CANCELLED_SWEEP_WINDOW_MS - 1000).toISOString(), lineUserId: orders[ORDER_1].lineUserId } });
  await runFiveMinute();
  assert.deepEqual(state.events, []);
});

for (const [label, env, perRun] of [
  ["one LINE member and one Telegram group", { ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: "-100123" }, 5],
  ["one LINE member and two Telegram chats", baseEnv, 4],
  ["one LINE member and four Telegram chats", { ...baseEnv, TELEGRAM_ADMIN_CHAT_IDS: "1,2,3,4" }, 2]
]) {
  for (const size of [10, 50, 200]) {
    test(`a backlog of ${size} with ${label} drains ${perRun} per run within 50 subrequests`, async () => {
      const state = fakeSupabase(backlog(size));
      for (let run = 1; run <= 3; run += 1) {
        state.fetches = 0;
        await runFiveMinute(env);
        assert.ok(state.fetches <= 50, `run ${run} used ${state.fetches} subrequests`);
        assert.equal(state.marked.size, Math.min(size, perRun * run), `run ${run} makes progress`);
      }
    });
  }
}

test("the newest cancellations are sent first", async () => {
  const state = fakeSupabase(backlog(10));
  await runFiveMinute();
  assert.deepEqual([...state.marked], [orderId(1), orderId(2), orderId(3), orderId(4)]);
});

test("too small a budget sends nothing and does not even query", async () => {
  const state = fakeSupabase(orders);
  assert.equal(await sweep.notifyMissedCancelledOrders(baseEnv, sweep.cancelledSweepReserve(baseEnv) - 1, new Date(NOW)), 0);
  assert.equal(state.fetches, 0);
});

test("the hourly schedule no longer walks cancelled orders", async () => {
  const state = fakeSupabase(orders);
  await runCron("0 * * * *");
  assert.deepEqual(state.listQueries, []);
  assert.deepEqual(state.marked, new Set());
});
