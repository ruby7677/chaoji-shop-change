// 規格圖片（src/admin-catalog.ts updateVariant）：PATCH 沒帶 image_id 時不更新；null 清除；UUID 照送；
// 其他格式回 400 且不呼叫資料庫。是否屬於同一商品由 admin_update_variant 檢查。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const VARIANT_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const IMAGE_ID = "eeeeeeee-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeAdminRpc() {
  const rpcBodies = [];
  restoreFetch = stubFetch(async (url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_update_variant") {
      rpcBodies.push(body);
      return jsonResponse({ id: VARIANT_ID, is_published: true });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return rpcBodies;
}

function updateVariant(extra = {}) {
  const body = { name: "黑色", kind: "in_stock", price: 100, is_published: true, ...extra };
  return worker.fetch(new Request(`https://shop.test/api/admin/variants/${VARIANT_ID}`, {
    method: "PATCH",
    headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }), baseEnv, ctx());
}

test("variant update without image_id leaves the image unchanged", async () => {
  const rpcBodies = fakeAdminRpc();
  assert.equal((await updateVariant()).status, 200);
  assert.equal(rpcBodies[0].p_update_image, false);
  assert.equal(rpcBodies[0].p_image_id, null);
});

test("variant update assigns or clears the image", async () => {
  const rpcBodies = fakeAdminRpc();
  assert.equal((await updateVariant({ image_id: IMAGE_ID })).status, 200);
  assert.equal((await updateVariant({ image_id: null })).status, 200);
  assert.deepEqual(rpcBodies.map((body) => [body.p_update_image, body.p_image_id]), [[true, IMAGE_ID], [true, null]]);
});

test("variant update rejects a malformed image_id without calling the database", async () => {
  const rpcBodies = fakeAdminRpc();
  assert.equal((await updateVariant({ image_id: "not-a-uuid" })).status, 400);
  assert.equal((await updateVariant({ image_id: 12 })).status, 400);
  assert.equal(rpcBodies.length, 0);
});

// 型錄：有指定規格圖片才送 image_id，沒指定時不送（型錄維持精簡）。
test("the public catalog sends image_id only for variants with an assigned image", async () => {
  let selected = "";
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/storefront_variants") {
      selected = url.searchParams.get("select");
      return jsonResponse([
        { id: "v1", category: "分類", name: "黑色", price: 100, stock: 1, type: "現貨", image_id: IMAGE_ID, is_published: true },
        { id: "v2", category: "分類", name: "白色", price: 100, stock: 1, type: "現貨", image_id: null, is_published: true }
      ]);
    }
    if (url.pathname === "/rest/v1/categories") return jsonResponse([]);
    throw new Error(`unexpected request: ${url}`);
  });
  const response = await worker.fetch(new Request("https://shop.test/api/catalog"), { ...baseEnv }, ctx());
  assert.equal(response.status, 200);
  assert.match(selected, /image_id/);
  const { products } = await response.json();
  assert.equal(products.find((item) => item.id === "v1").image_id, IMAGE_ID);
  assert.ok(!("image_id" in products.find((item) => item.id === "v2")));
});
