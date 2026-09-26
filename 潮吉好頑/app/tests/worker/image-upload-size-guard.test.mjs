// 商品主圖（src/catalog.ts uploadProductImage）與商品多圖（src/product-showcase.ts
// addProductImage）在 formData() 解析前先看 Content-Length：缺少或非整數擋 411，
// 超過 2×PRODUCT_IMAGE_MAX_BYTES+256KB 擋 413，兩者都不呼叫 formData() 或任何 storage／
// products 端點；正常大小的請求不受影響，繼續往下處理。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, formDataRequestInit, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const storage = await loadSourceModule("product-image-storage");
const OVER_LIMIT = storage.PRODUCT_IMAGE_UPLOAD_MAX_REQUEST_BYTES + 1;

const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);

let restoreFetch = () => {};
afterEach(() => restoreFetch());

/** Only admin verification is stubbed; any further call (products, storage, RPC) throws, proving the size guard returned before formData()/any downstream fetch. */
function fakeAdminOnly() {
  const calls = [];
  restoreFetch = stubFetch(async (url) => {
    calls.push(url.pathname);
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    throw new Error(`unexpected request beyond admin verification: ${url}`);
  });
  return calls;
}

const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
function webpFile(name = "photo.webp") {
  return new File([new Uint8Array([...WEBP_HEADER, 1, 2, 3, 4])], name, { type: "image/webp" });
}

function primaryImageRequest(headers, body) {
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/image`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-access-token", ...headers },
    body
  }), baseEnv, ctx());
}

function galleryImageRequest(headers, body) {
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/images`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-access-token", ...headers },
    body
  }), baseEnv, ctx());
}

const routes = [
  { name: "primary image (catalog.ts)", request: primaryImageRequest },
  { name: "gallery image (product-showcase.ts)", request: galleryImageRequest }
];

for (const { name, request } of routes) {
  test(`${name}: missing Content-Length returns 411 without touching formData or storage`, async () => {
    const calls = fakeAdminOnly();
    const formData = new FormData();
    formData.append("image", webpFile());
    // A Request built directly from a FormData body in Node never carries a
    // Content-Length header, which is exactly the "missing" case to guard.
    const response = await request({}, formData);
    assert.equal(response.status, 411);
    assert.deepEqual((await response.json()), { error: "上傳請求缺少檔案大小" });
    assert.deepEqual(calls, ["/auth/v1/user", "/rest/v1/profiles"], "no products/storage/RPC call happens before the size guard");
  });

  test(`${name}: a non-integer Content-Length returns 411`, async () => {
    fakeAdminOnly();
    const response = await request({ "Content-Length": "not-a-number" }, new FormData());
    assert.equal(response.status, 411);
  });

  test(`${name}: an oversized Content-Length returns 413 without touching formData or storage`, async () => {
    const calls = fakeAdminOnly();
    const response = await request({ "Content-Length": String(OVER_LIMIT) }, new FormData());
    assert.equal(response.status, 413);
    assert.deepEqual((await response.json()), { error: "請求內容過大，請縮減購物車或欄位內容" });
    assert.deepEqual(calls, ["/auth/v1/user", "/rest/v1/profiles"], "no products/storage/RPC call happens before the size guard");
  });

  test(`${name}: a Content-Length within the cap is accepted and formData() is reached`, async () => {
    fakeAdminOnly();
    const formData = new FormData();
    formData.append("image", webpFile());
    const { body, headers } = await formDataRequestInit(formData);
    const response = await request(headers, body);
    // The fake has no products/storage stub, so passing the size guard means
    // the handler reaches formData() and the first downstream fetch, which
    // this fake does not answer; the unhandled rejection surfaces as the
    // generic 503 from index.ts's top-level catch, not a 411/413 from the guard.
    assert.equal(response.status, 503);
  });
}
