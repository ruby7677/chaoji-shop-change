// 商品可用取貨方式：後台建立／編輯商品時 Worker 驗證 allowed_delivery_methods 並以 p_delivery_methods 交給 RPC；
// 無效值在 Worker 就被擋下（不呼叫資料庫）；資料庫的 INVALID_DELIVERY_METHODS 轉成中文；公開型錄帶出欄位。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";
import { ALL_DELIVERY_METHODS, itemDeliveryMethods } from "../../public/cart-delivery-rules.js";

const worker = await loadWorker();
const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);
const HEADERS = { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" };

let restoreFetch = () => {};
afterEach(() => { restoreFetch(); delete globalThis.caches; });

function adminStub(rpcHandler) {
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => true } };
  restoreFetch = stubFetch(async (url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    const rpc = rpcHandler(url.pathname, body);
    if (rpc) return rpc;
    throw new Error(`unexpected request: ${url}`);
  });
}

function fakeAdmin() {
  const rpc = {};
  adminStub((path, body) => {
    if (path === "/rest/v1/rpc/admin_create_product") { rpc.create = body; return jsonResponse({ product_id: PRODUCT_ID, variant_id: "v1" }); }
    if (path === "/rest/v1/rpc/admin_update_product") { rpc.update = body; return jsonResponse({ id: PRODUCT_ID, image_updated_at: null }); }
    return null;
  });
  return rpc;
}

const create = (extra = {}) => worker.fetch(new Request("https://shop.test/api/admin/products", {
  method: "POST", headers: HEADERS,
  body: JSON.stringify({ category_name: "分類", product_name: "大型商品", kind: "in_stock", price: 100, stock: 1, ...extra })
}), baseEnv, ctx());
const update = (extra = {}) => worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}`, {
  method: "PATCH", headers: HEADERS, body: JSON.stringify({ name: "大型商品", ...extra })
}), baseEnv, ctx());

test("creating a product forwards the chosen delivery methods", async () => {
  const rpc = fakeAdmin();
  const response = await create({ allowed_delivery_methods: ["home_delivery", "store_pickup", "home_delivery"] });
  assert.equal(response.status, 201);
  assert.deepEqual(rpc.create.p_delivery_methods, ["home_delivery", "store_pickup"]);
});

test("creating without the field leaves the decision to the database default", async () => {
  const rpc = fakeAdmin();
  assert.equal((await create()).status, 201);
  assert.equal(rpc.create.p_delivery_methods, null);
});

test("editing forwards the methods, and omitting them keeps the current setting", async () => {
  const rpc = fakeAdmin();
  assert.equal((await update({ allowed_delivery_methods: ["store_pickup"] })).status, 200);
  assert.deepEqual(rpc.update.p_delivery_methods, ["store_pickup"]);
  assert.equal((await update()).status, 200);
  assert.equal(rpc.update.p_delivery_methods, null);
});

for (const bad of [[], ["seller_delivery"], ["store_pickup", "teleport"], "home_delivery", [null], [1]]) {
  test(`invalid methods ${JSON.stringify(bad)} are rejected before reaching the database`, async () => {
    const rpc = fakeAdmin();
    for (const call of [create, update]) {
      const response = await call({ allowed_delivery_methods: bad });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /至少選擇一種可用的取貨方式/);
    }
    assert.deepEqual(rpc, {});
  });
}

test("the database's refusal is shown as a readable message", async () => {
  adminStub((path) => (path === "/rest/v1/rpc/admin_update_product" ? jsonResponse({ message: "INVALID_DELIVERY_METHODS" }, 400) : null));
  const response = await update({ allowed_delivery_methods: ["store_pickup"] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /至少選擇一種可用的取貨方式/);
});

test("the public catalog request asks for the delivery methods", async () => {
  let selected = "";
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/storefront_variants") {
      selected = url.searchParams.get("select");
      return jsonResponse([
        { id: "v1", category: "分類", name: "大型商品", price: 100, stock: 1, type: "現貨", allowed_delivery_methods: ["home_delivery"], is_published: true },
        { id: "v2", category: "分類", name: "一般商品", price: 100, stock: 1, type: "現貨", allowed_delivery_methods: ["home_delivery", "store_pickup", "cvs_delivery"], is_published: true }
      ]);
    }
    if (url.pathname === "/rest/v1/categories") return jsonResponse([]);
    throw new Error(`unexpected request: ${url}`);
  });
  const response = await worker.fetch(new Request("https://shop.test/api/catalog"), { ...baseEnv }, ctx());
  assert.equal(response.status, 200);
  assert.match(selected, /allowed_delivery_methods/);
  assert.doesNotMatch(selected, /seller_link/, "賣貨便已停用，型錄不讀賣場連結");
  const { products } = await response.json();
  assert.deepEqual(products[0].allowed_delivery_methods, ["home_delivery"]);
  assert.ok(!("allowed_delivery_methods" in products[1]), "三種全開時不送，前台缺欄位即視為全開");
  assert.deepEqual(itemDeliveryMethods(products[1]), ALL_DELIVERY_METHODS);
});
