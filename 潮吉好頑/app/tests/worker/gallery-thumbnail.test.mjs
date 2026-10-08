// 商品多圖上傳：附上縮圖時在建立資料列前存到 <圖片>.thumb.webp（這張成為主圖時商品卡才有縮圖可用）；
// 建立資料列失敗或刪除照片時，原圖與縮圖一起刪除。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, formDataRequestInit, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000003";
const IMAGE_ID = "bbbbbbbb-0000-4000-8000-000000000003";
const ADMIN_ID = "00000000-0000-4000-8000-000000000003";
const LINE_ID = "U" + "d".repeat(32);
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3, 4];
const webpFile = (name) => new File([new Uint8Array(WEBP)], name, { type: "image/webp" });

let restoreFetch = () => {};
let originalCaches;
beforeEach(() => {
  originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
});
afterEach(() => { restoreFetch(); globalThis.caches = originalCaches; });

function fakeSupabase({ rpcStatus = 200 } = {}) {
  const events = [];
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_add_product_image") {
      events.push("rpc");
      return rpcStatus === 200 ? jsonResponse({ id: body.p_image_id, updated_at: "2026-10-08T14:00:00Z", width: 1600, height: 1108, alt_text: "" }) : jsonResponse({ message: "PRODUCT_IMAGE_LIMIT" }, rpcStatus);
    }
    if (url.pathname === "/rest/v1/rpc/admin_delete_product_image") return jsonResponse({ storage_path: `${PRODUCT_ID}/${IMAGE_ID}.webp` });
    if (url.pathname === "/rest/v1/product_images") return jsonResponse([{ updated_at: "2026-10-08T14:00:00Z" }]);
    if (url.pathname === "/storage/v1/object/product-images" && init.method === "DELETE") { events.push(["delete", body.prefixes]); return jsonResponse({}); }
    if (url.pathname.startsWith("/storage/v1/object/product-images/")) {
      events.push(["upload", decodeURIComponent(url.pathname.replace("/storage/v1/object/product-images/", "")).replace(/^[^/]+\/[^.]+/, "<image>")]);
      return jsonResponse({});
    }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  return events;
}

async function upload(withThumbnail = true) {
  const formData = new FormData();
  formData.append("image", webpFile("photo.webp"));
  if (withThumbnail) formData.append("thumbnail", webpFile("photo.thumb.webp"));
  const { body, headers } = await formDataRequestInit(formData);
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/images`, {
    method: "POST", headers: { Authorization: "Bearer admin-access-token", ...headers }, body
  }), baseEnv, ctx());
}

test("a gallery photo with a thumbnail stores both before the photo row is created", async () => {
  const events = fakeSupabase();
  const response = await upload();
  assert.equal(response.status, 201);
  assert.deepEqual(events, [["upload", "<image>.webp"], ["upload", "<image>.thumb.webp"], "rpc"]);
});

test("a gallery photo without a thumbnail (640px or smaller) stores only the photo", async () => {
  const events = fakeSupabase();
  assert.equal((await upload(false)).status, 201);
  assert.deepEqual(events, [["upload", "<image>.webp"], "rpc"]);
});

test("when the photo row cannot be created, the photo and its thumbnail are both removed", async () => {
  const events = fakeSupabase({ rpcStatus: 400 });
  assert.equal((await upload()).status, 400);
  const [, prefixes] = events.find((event) => Array.isArray(event) && event[0] === "delete");
  assert.equal(prefixes.length, 2);
  assert.match(prefixes[0], new RegExp(`^${PRODUCT_ID}/[0-9a-f-]+\\.webp$`));
  assert.equal(prefixes[1], prefixes[0].replace(/\.webp$/, ".thumb.webp"));
});

test("deleting a gallery photo also deletes its thumbnail", async () => {
  const events = fakeSupabase();
  const response = await worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/images/${IMAGE_ID}`, {
    method: "DELETE", headers: { Authorization: "Bearer admin-access-token" }
  }), baseEnv, ctx());
  assert.equal(response.status, 200);
  assert.deepEqual(events.find((event) => Array.isArray(event) && event[0] === "delete"), ["delete", [`${PRODUCT_ID}/${IMAGE_ID}.webp`, `${PRODUCT_ID}/${IMAGE_ID}.thumb.webp`]]);
});
