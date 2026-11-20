// 後台預購叫貨：依訂單明細統計各預購規格的已付款／待付款／已到貨件數；取消的訂單不計入，需要管理員身分。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);
const HEADERS = { Authorization: "Bearer admin-access-token" };

let restoreFetch = () => {};
afterEach(() => { restoreFetch(); delete globalThis.caches; });

const row = (variant, quantity, status, extra = {}) => ({
  variant_id: variant, product_name: `商品${variant}`, variant_name: "單一規格", quantity, arrival_snapshot: null, orders: { status }, ...extra
});

function adminStub(itemPages) {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => true } };
  const seen = [];
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/order_items") {
      seen.push(url);
      return jsonResponse(itemPages[seen.length - 1] || []);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return seen;
}

const get = () => worker.fetch(new Request("https://shop.test/api/admin/preorder-demand", { headers: HEADERS }), baseEnv, ctx());

test("quantities are split by payment stage, cancelled orders are skipped, biggest paid first", async () => {
  adminStub([[
    row("a", 2, "confirmed"), row("a", 1, "partially_ready"), row("a", 3, "pending_payment"), row("a", 4, "pending_review"),
    row("a", 5, "ready_for_pickup"), row("a", 1, "completed"), row("a", 9, "cancelled"),
    row("b", 7, "confirmed", { orders: [{ status: "confirmed" }] })
  ]]);
  const body = await (await get()).json();
  assert.deepEqual(body.preorderDemand.map(({ variant_id, paid, unpaid, arrived }) => ({ variant_id, paid, unpaid, arrived })), [
    { variant_id: "b", paid: 7, unpaid: 0, arrived: 0 },
    { variant_id: "a", paid: 3, unpaid: 7, arrived: 6 }
  ]);
});

test("empty quantities and rows without an order are ignored", async () => {
  adminStub([[row("a", 0, "confirmed"), { ...row("b", 2, "confirmed"), orders: null }]]);
  assert.deepEqual((await (await get()).json()).preorderDemand, []);
});

test("the query asks for preorder items of counted statuses only", async () => {
  const seen = adminStub([[row("a", 2, "confirmed")]]);
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(seen[0].searchParams.get("kind"), "eq.preorder");
  assert.doesNotMatch(seen[0].searchParams.get("orders.status"), /cancelled/);
  assert.match(seen[0].searchParams.get("select"), /orders!inner\(status\)/);
});

test("more than one batch of rows is paged through", async () => {
  const full = Array.from({ length: 1000 }, () => row("a", 1, "confirmed"));
  const seen = adminStub([full, [row("a", 5, "confirmed")]]);
  const body = await (await get()).json();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].searchParams.get("offset"), "1000");
  assert.equal(body.preorderDemand[0].paid, 1005);
});

test("a request without a token is rejected before any query", async () => {
  restoreFetch = stubFetch(async () => { throw new Error("must not call upstream"); });
  const response = await worker.fetch(new Request("https://shop.test/api/admin/preorder-demand"), baseEnv, ctx());
  assert.equal(response.status, 401);
});
