// 三個先前沒有測試覆蓋的速率限制點（建立訂單、回報匯款、一個後台路由），以及
// 到店取貨／宅配選擇外部付款時的 STORE_PAYMENT_BANK_TRANSFER_ONLY 訊息。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, deniedRateLimit, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const MEMBER_ID = "00000000-0000-4000-8000-0000000000b1";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000b2";
const LINE_ID = "U" + "d".repeat(32);
const ORDER_ID = "cccccccc-0000-4000-8000-000000000001";
const VARIANT_ID = "dddddddd-0000-4000-8000-000000000001";
const BANK_ID = "eeeeeeee-0000-4000-8000-000000000001";
const MEMBER_TOKEN = "Bearer member-access-token";
const ADMIN_TOKEN = "Bearer admin-access-token";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeMember() {
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    throw new Error(`unexpected request beyond member verification: ${url}`);
  });
}

function fakeAdmin() {
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    throw new Error(`unexpected request beyond admin verification: ${url}`);
  });
}

test("POST /api/orders is rate limited (API_ORDER_RATE_LIMITER) before the create RPC runs", async () => {
  fakeMember();
  const env = { ...baseEnv, API_ORDER_RATE_LIMITER: deniedRateLimit };
  const response = await worker.fetch(new Request("https://shop.test/api/orders", {
    method: "POST",
    headers: { Authorization: MEMBER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], bank_account_id: BANK_ID })
  }), env, ctx());
  assert.equal(response.status, 429);
});

test("POST /api/orders/:id/payment is rate limited (API_MEMBER_RATE_LIMITER) before the payment RPC runs", async () => {
  fakeMember();
  const env = { ...baseEnv, API_MEMBER_RATE_LIMITER: deniedRateLimit };
  const response = await worker.fetch(new Request(`https://shop.test/api/orders/${ORDER_ID}/payment`, {
    method: "POST",
    headers: { Authorization: MEMBER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ bank_account_id: BANK_ID, payment_last_five: "12345" })
  }), env, ctx());
  assert.equal(response.status, 429);
});

test("GET /api/admin/dashboard is rate limited (API_ADMIN_RATE_LIMITER) after admin verification, before any dashboard query", async () => {
  fakeAdmin();
  const env = { ...baseEnv, API_ADMIN_RATE_LIMITER: deniedRateLimit };
  const response = await worker.fetch(new Request("https://shop.test/api/admin/dashboard?section=overview", {
    headers: { Authorization: ADMIN_TOKEN }
  }), env, ctx());
  assert.equal(response.status, 429);
});

// STORE_PAYMENT_BANK_TRANSFER_ONLY: create_delivery_order（自 migration 202609140006 起）
// 目前唯一會拋出的到店/宅配限制代碼；下面直接用 member-api.ts 自己回的訊息驗證（不打 RPC）。
test("store_payment for store_pickup/home_delivery is rejected with the bank-transfer-only message", async () => {
  fakeMember();
  const response = await worker.fetch(new Request("https://shop.test/api/orders", {
    method: "POST",
    headers: { Authorization: MEMBER_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ variant_id: VARIANT_ID, quantity: 1 }],
      delivery_method: "store_pickup",
      payment_method: "store_payment"
    })
  }), baseEnv, ctx());
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "本站到店取貨與宅配訂單僅接受匯款／轉帳，請改選匯款付款");
});
