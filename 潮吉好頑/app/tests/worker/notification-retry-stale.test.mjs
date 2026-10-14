// 通知重試：運費等出貨資訊通知只在訂單沒有再更新時補送，避免客人收到過期的匯款金額；
// 「訂單已成立」只在仍待付款、運費未通知、付款期限未到時補送（與建單補發共用 createdNoticeStillDue）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const delivery = await loadSourceModule("notification-delivery.ts");
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000e1";
const SAVED_AT = "2026-10-12T11:00:00.123456+00:00";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeRetry(eventKey, { orderUpdatedAt = SAVED_AT, orderLookupFails = false, order = {} } = {}) {
  const seen = { pushes: 0, completions: [], orderSelects: [] };
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/rest/v1/rpc/claim_due_notification_deliveries") {
      if (body.p_channel !== "line") return jsonResponse([]);
      return jsonResponse([{ id: "delivery-1", claim_token: "token", event_key: eventKey, recipient_id: "Uabc", event_type: "order_fulfillment_updated", status: "processing", attempt_count: 2, payload: { messages: [{ type: "text", text: "pay NT$1,150" }] } }]);
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") { seen.completions.push(body); return jsonResponse(true); }
    if (url.pathname === "/rest/v1/orders") {
      seen.orderSelects.push(url.searchParams.get("select"));
      return orderLookupFails ? new Response("busy", { status: 503 }) : jsonResponse(orderUpdatedAt ? [{ updated_at: orderUpdatedAt, status: "pending_payment", delivery_method: "home_delivery", shipping_fee_notified_at: null, payment_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(), ...order }] : []);
    }
    if (url.hostname === "api.line.me") { seen.pushes += 1; return new Response("{}", { status: 200 }); }
    return jsonResponse([]);
  });
  return seen;
}

test("a fulfillment notice retry is sent while the order is unchanged", async () => {
  const seen = fakeRetry(`fulfillment_updated:${ORDER_ID}:${SAVED_AT}`);
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 1);
  assert.equal(seen.completions[0].p_sent, true);
});

test("a fulfillment notice retry is dropped for good once the fee was saved again", async () => {
  const seen = fakeRetry(`fulfillment_updated:${ORDER_ID}:${SAVED_AT}`, { orderUpdatedAt: "2026-10-12T11:05:00+00:00" });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 0, "the stale amount is never pushed");
  assert.equal(seen.completions[0].p_sent, false);
  assert.equal(seen.completions[0].p_retryable, false);
});

test("a fulfillment notice retry waits when the order cannot be read", async () => {
  const seen = fakeRetry(`fulfillment_updated:${ORDER_ID}:${SAVED_AT}`, { orderLookupFails: true });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 0);
  assert.equal(seen.completions[0].p_retryable, true);
});

test("an order-created notice retry is sent while the order still waits for its fee", async () => {
  const seen = fakeRetry(`created:${ORDER_ID}`);
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 1);
});

test("an order-created notice retry is dropped once the home fee was confirmed", async () => {
  const seen = fakeRetry(`created:${ORDER_ID}`, { order: { shipping_fee_notified_at: SAVED_AT } });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 0, "no late 'do not transfer yet' after the fee notice");
  assert.equal(seen.completions[0].p_retryable, false);
});

test("an order-created notice retry is dropped once the order was cancelled", async () => {
  const seen = fakeRetry(`created:${ORDER_ID}`, { order: { status: "cancelled", delivery_method: "store_pickup" } });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 0);
});

for (const [label, order] of [
  ["reported its payment", { status: "pending_review" }],
  ["been confirmed", { status: "confirmed" }],
  ["been completed", { status: "completed" }],
  ["passed its payment deadline", { payment_deadline: new Date(Date.now() - 1000).toISOString() }]
]) {
  test(`an order-created notice retry is dropped once the order has ${label}`, async () => {
    const seen = fakeRetry(`created:${ORDER_ID}`, { order });
    await delivery.retryDueNotificationDeliveries(baseEnv);
    assert.equal(seen.pushes, 0, "no late payment reminder");
    assert.equal(seen.completions[0].p_sent, false);
    assert.equal(seen.completions[0].p_retryable, false, "the stale notice is closed, not retried");
    assert.match(seen.orderSelects[0], /payment_deadline/);
  });
}

test("the retry check and the created sweep share one rule", () => {
  const due = { status: "pending_payment", shipping_fee_notified_at: null, payment_deadline: "2026-10-13T10:00:00Z" };
  const now = Date.parse("2026-10-13T09:00:00Z");
  assert.equal(delivery.createdNoticeStillDue(due, now), true);
  assert.equal(delivery.createdNoticeStillDue({ ...due, payment_deadline: null }, now), false);
  assert.equal(delivery.createdNoticeStillDue({ ...due, shipping_fee_notified_at: "2026-10-13T08:00:00Z" }, now), false);
  assert.equal(delivery.createdNoticeStillDue({ ...due, status: "pending_review" }, now), false);
});

test("non-order notice retries are sent without an order check", async () => {
  const seen = fakeRetry("birthday:2026:Uabc", { orderUpdatedAt: null });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 1);
});
