// 後台刪除商品（src/admin-catalog.ts archiveProduct）：DELETE /api/admin/products/:id 以管理員身分呼叫 admin_archive_product；
// 資料庫拒絕（還有未完成訂單）時回傳中文訊息；未登入不會呼叫資料庫。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);

let restoreFetch = () => {};
const purged = [];
afterEach(() => { restoreFetch(); purged.length = 0; delete globalThis.caches; });

function fakeArchive(rpcResponse) {
  const rpcBodies = [];
  // 刪除後清掉型錄與商品圖片的邊緣快取
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async (key) => { purged.push(String(key.url || key)); return true; } } };
  restoreFetch = stubFetch(async (url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_archive_product") {
      rpcBodies.push(body);
      return rpcResponse();
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return rpcBodies;
}

function deleteProduct(headers = { Authorization: "Bearer admin-access-token" }) {
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}`, { method: "DELETE", headers }), baseEnv, ctx());
}

test("an admin deletes a product through the archive RPC", async () => {
  const rpcBodies = fakeArchive(() => jsonResponse({ product_id: PRODUCT_ID, image_updated_at: null }));
  const response = await deleteProduct();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { archived: true });
  assert.deepEqual(rpcBodies, [{ p_actor_id: ADMIN_ID, p_product_id: PRODUCT_ID }]);
  assert.ok(purged.some((key) => key.includes(PRODUCT_ID)), 'the product image cache is purged');
});

test("a product with unfinished orders is refused with a readable message", async () => {
  fakeArchive(() => jsonResponse({ message: "PRODUCT_HAS_OPEN_ORDERS" }, 400));
  const response = await deleteProduct();
  assert.equal(response.status >= 400 && response.status < 500, true);
  assert.match((await response.json()).error, /未完成的訂單/);
});

test("deleting without signing in never reaches the database", async () => {
  const rpcBodies = fakeArchive(() => jsonResponse({}));
  const response = await deleteProduct({});
  assert.equal(response.status, 401);
  assert.equal(rpcBodies.length, 0);
});
