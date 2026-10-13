// 建單 RPC 成功後，明細或收款帳戶讀取失敗仍回 201：訂單已存在，不能讓前端當成失敗而重新下單。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const MEMBER_ID = "00000000-0000-4000-8000-0000000000d1";
const LINE_ID = "U" + "f".repeat(32);
const ORDER_ID = "dddddddd-0000-4000-8000-0000000000d2";
const VARIANT_ID = "dddddddd-0000-4000-8000-0000000000d3";
const BANK_ID = "dddddddd-0000-4000-8000-0000000000d4";

let restoreFetch = () => {};
afterEach(() => restoreFetch());
globalThis.caches ??= { default: { delete: async () => true } };

const orderRow = { id: ORDER_ID, order_number: "CJ-1", status: "pending_payment", delivery_method: "store_pickup", bank_account_id: BANK_ID, subtotal: 500, coupon_discount: 0, point_discount: 0, shipping_fee: 0, amount_due: 500, deposit_due: 500, order_items: [] };

let rpcBodies = [];

function fakeSupabase({ ordersStatus = 200, bankStatus = 200 } = {}) {
  rpcBodies = [];
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/create_delivery_order") { rpcBodies.push(body); return jsonResponse(ORDER_ID); }
    if (url.pathname === "/rest/v1/orders") return ordersStatus === 200 ? jsonResponse([orderRow]) : jsonResponse({ message: "down" }, ordersStatus);
    if (url.pathname === "/rest/v1/bank_accounts") return bankStatus === 200 ? jsonResponse([{ id: BANK_ID, label: "主帳戶" }]) : jsonResponse({ message: "down" }, bankStatus);
    return jsonResponse([]);
  });
}

const createOrder = (extra = {}) => worker.fetch(new Request("https://shop.test/api/orders", {
  method: "POST",
  headers: { Authorization: "Bearer member-access-token", "Content-Type": "application/json" },
  body: JSON.stringify({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], delivery_method: "store_pickup", bank_account_id: BANK_ID, ...extra })
}), baseEnv, ctx());

test("an order whose detail cannot be read back is still reported as created", async () => {
  fakeSupabase({ ordersStatus: 503 });
  const response = await createOrder();
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { order: null, order_id: ORDER_ID, detail_unavailable: true });
});

test("a bank account lookup failure still returns the created order without account details", async () => {
  fakeSupabase({ bankStatus: 503 });
  const response = await createOrder();
  assert.equal(response.status, 201);
  const { order } = await response.json();
  assert.equal(order.id, ORDER_ID);
  assert.equal(order.bank_accounts, null);
});

test("the checkout request id is forwarded to the idempotent order entry", async () => {
  fakeSupabase();
  const key = "12345678-1234-4123-8123-123456789abc";
  assert.equal((await createOrder({ client_request_id: key })).status, 201);
  assert.equal(rpcBodies[0].p_client_request_id, key);
});

test("a request without an id calls the same entry with a null id", async () => {
  fakeSupabase();
  await createOrder();
  assert.equal(rpcBodies[0].p_client_request_id, null);
});

test("a malformed request id is rejected before the database is called", async () => {
  fakeSupabase();
  const response = await createOrder({ client_request_id: "not-a-uuid" });
  assert.equal(response.status, 400);
  assert.equal(rpcBodies.length, 0);
});

test("a network failure while reading the created order back still reports it as created", async () => {
  rpcBodies = [];
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/create_delivery_order") { rpcBodies.push(body); return jsonResponse(ORDER_ID); }
    if (url.pathname === "/rest/v1/orders") throw new Error("network timeout");
    return jsonResponse([]);
  });
  const response = await createOrder();
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { order: null, order_id: ORDER_ID, detail_unavailable: true });
});

test("an order created without readable details still triggers the created notification", async () => {
  const notificationReads = [];
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/create_delivery_order") return jsonResponse(ORDER_ID);
    if (url.pathname === "/rest/v1/orders") {
      const headers = new Headers(init.headers);
      // 會員權杖讀明細失敗；通知以 service key 讀同一筆訂單
      if (headers.get("Authorization") === "Bearer member-access-token") return jsonResponse({ message: "down" }, 503);
      notificationReads.push(url.searchParams.get("id"));
      return jsonResponse([orderRow]);
    }
    return jsonResponse(body?.p_event_key ? null : []);
  });
  const context = ctx();
  const response = await worker.fetch(new Request("https://shop.test/api/orders", {
    method: "POST",
    headers: { Authorization: "Bearer member-access-token", "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ variant_id: VARIANT_ID, quantity: 1 }], delivery_method: "store_pickup", bank_account_id: BANK_ID })
  }), baseEnv, context);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).order, null);
  await context.settle();
  assert.deepEqual(notificationReads, [`eq.${ORDER_ID}`], "the created notification loads the order by its id");
});
