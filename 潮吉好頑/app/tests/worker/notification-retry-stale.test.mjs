// 通知重試：運費等出貨資訊通知只在訂單沒有再更新時補送，避免客人收到過期的匯款金額。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const delivery = await loadSourceModule("notification-delivery.ts");
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000e1";
const SAVED_AT = "2026-10-12T11:00:00.123456+00:00";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeRetry(eventKey, { orderUpdatedAt = SAVED_AT, orderLookupFails = false } = {}) {
  const seen = { pushes: 0, completions: [] };
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/rest/v1/rpc/claim_due_notification_deliveries") {
      if (body.p_channel !== "line") return jsonResponse([]);
      return jsonResponse([{ id: "delivery-1", claim_token: "token", event_key: eventKey, recipient_id: "Uabc", event_type: "order_fulfillment_updated", status: "processing", attempt_count: 2, payload: { messages: [{ type: "text", text: "pay NT$1,150" }] } }]);
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") { seen.completions.push(body); return jsonResponse(true); }
    if (url.pathname === "/rest/v1/orders") return orderLookupFails ? new Response("busy", { status: 503 }) : jsonResponse(orderUpdatedAt ? [{ updated_at: orderUpdatedAt }] : []);
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

test("other notice retries are sent without an order check", async () => {
  const seen = fakeRetry(`created:${ORDER_ID}`, { orderUpdatedAt: null });
  await delivery.retryDueNotificationDeliveries(baseEnv);
  assert.equal(seen.pushes, 1);
});
