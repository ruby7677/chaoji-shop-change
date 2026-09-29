// 新增規格（src/admin-catalog.ts createVariant）：請求沒帶 display_order 時送 null 給 admin_create_variant，
// 由資料庫接在同商品最後一個規格之後；有帶整數時照送。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeAdminRpc() {
  const rpcBodies = [];
  restoreFetch = stubFetch(async (url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_create_variant") {
      rpcBodies.push(body);
      return jsonResponse({ id: "v-new" });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return rpcBodies;
}

function createVariant(extra = {}) {
  const body = { product_id: PRODUCT_ID, name: "第二款", sku: "abc-2", kind: "in_stock", price: 100, ...extra };
  return worker.fetch(new Request("https://shop.test/api/admin/variants", {
    method: "POST",
    headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), baseEnv, ctx());
}

test("new variant without an order lets the database place it", async () => {
  const rpcBodies = fakeAdminRpc();
  const response = await createVariant();
  assert.equal(response.status, 201);
  assert.equal(rpcBodies.length, 1);
  assert.equal(rpcBodies[0].p_display_order, null);
});

test("new variant with an explicit order keeps it", async () => {
  const rpcBodies = fakeAdminRpc();
  const response = await createVariant({ display_order: -30 });
  assert.equal(response.status, 201);
  assert.equal(rpcBodies[0].p_display_order, -30);
});
