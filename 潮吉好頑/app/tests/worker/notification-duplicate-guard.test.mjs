// 防重複通知：LINE 推播帶 X-Line-Retry-Key（通知紀錄 id），前次已被接受時 LINE 回 409，視為已送出、不再重試。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const delivery = await loadSourceModule("notification-delivery.ts");
const DELIVERY_ID = "dddddddd-0000-4000-8000-0000000000a1";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeLine(lineResponse) {
  const seen = { pushes: [], completions: [] };
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      return jsonResponse({ id: DELIVERY_ID, claim_token: "token", status: "processing", attempt_count: 2, payload: body.p_payload, claimed: true });
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") { seen.completions.push(body); return jsonResponse(true); }
    if (url.hostname === "api.line.me") { seen.pushes.push(new Headers(init.headers)); return lineResponse(); }
    return jsonResponse([]);
  });
  return seen;
}

const send = () => delivery.deliverLineNotification(baseEnv, "payment_reported:x", "Uabc", "order_payment_reported", { type: "text", text: "hi" });

test("a LINE push carries the delivery id as its retry key", async () => {
  const seen = fakeLine(() => new Response("{}", { status: 200 }));
  await send();
  assert.equal(seen.pushes[0].get("X-Line-Retry-Key"), DELIVERY_ID);
});

test("a retry LINE already accepted is recorded as sent, not resent", async () => {
  const seen = fakeLine(() => new Response('{"message":"The retry key is already accepted"}', { status: 409, headers: { "x-line-accepted-request-id": "req-1" } }));
  const result = await send();
  assert.equal(result.sent, true);
  assert.equal(seen.completions[0].p_sent, true);
  assert.equal(seen.completions[0].p_status_code, 409);
});

test("a 409 without an accepted request id stays a permanent failure", async () => {
  const seen = fakeLine(() => new Response('{"message":"conflict"}', { status: 409 }));
  await send();
  assert.equal(seen.completions[0].p_sent, false);
  assert.equal(seen.completions[0].p_retryable, false);
});
