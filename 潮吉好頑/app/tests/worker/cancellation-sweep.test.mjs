// 每小時取消訂單補送（notifyRecentlyCancelledOrders）：只處理未標記訂單、claim 失敗不標記、已處理的不再寫入。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase(orders) {
  const state = { marked: new Set(), logs: new Map(), failClaimFor: null, events: [], listQueries: [] };
  restoreFetch = stubFetch((url, init, body) => {
    const method = init.method || "GET";
    if (url.host === "api.line.me") { state.events.push(`LINE ${body.to}`); return jsonResponse({}); }
    if (url.host === "api.telegram.org") { state.events.push(`TG ${body.chat_id}`); return jsonResponse({ ok: true }); }
    const path = url.pathname;
    if (path === "/rest/v1/orders" && method === "GET" && url.searchParams.get("select") === "id,cancelled_at") {
      state.listQueries.push(Object.fromEntries(url.searchParams));
      return jsonResponse(Object.entries(orders).filter(([id]) => !state.marked.has(id)).map(([id, order]) => ({ id, cancelled_at: order.cancelledAt })));
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
      const ids = url.searchParams.get("id").replace(/^in\.\(|\)$/g, "").split(",");
      assert.equal(url.searchParams.get("cancellation_notified_at"), "is.null", "marking never overwrites an existing marker");
      ids.forEach((id) => state.marked.add(id));
      state.events.push(`MARK ${ids.join(",")}`);
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
    return jsonResponse([]);
  });
  return state;
}

async function runHourly() {
  const context = ctx();
  worker.scheduled({ cron: "0 * * * *" }, baseEnv, context);
  await context.settle();
}

const ORDER_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const ORDER_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const orders = {
  [ORDER_1]: { cancelledAt: "2026-09-24T01:00:00+00:00", lineUserId: "U" + "a".repeat(32) },
  [ORDER_2]: { cancelledAt: "2026-09-24T02:00:00+00:00", lineUserId: "U" + "b".repeat(32) }
};

test("sweep only lists unmarked cancelled orders", async () => {
  const state = fakeSupabase(orders);
  await runHourly();
  assert.ok(state.listQueries.length > 0);
  for (const query of state.listQueries) {
    assert.equal(query.status, "eq.cancelled");
    assert.equal(query.cancellation_notified_at, "is.null");
  }
});

test("an order is marked only after every recipient has a claim row", async () => {
  const state = fakeSupabase(orders);
  state.failClaimFor = ORDER_2;
  await runHourly();
  assert.ok(state.marked.has(ORDER_1));
  assert.ok(!state.marked.has(ORDER_2), "an order whose claim failed stays unmarked");
  assert.deepEqual(state.events.filter((event) => event.startsWith("LINE")), [`LINE ${orders[ORDER_1].lineUserId}`]);

  state.failClaimFor = null;
  state.events.length = 0;
  await runHourly();
  assert.ok(state.marked.has(ORDER_2), "the failed order is offered again next hour");
  assert.deepEqual(state.events, ["TG 111", "TG 222", `LINE ${orders[ORDER_2].lineUserId}`, `MARK ${ORDER_2}`]);

  state.events.length = 0;
  await runHourly();
  assert.deepEqual(state.events, [], "handled orders cause no further claims, sends or writes");
});
