// 商品多圖上傳：照片與縮圖在建立資料列前寫入 R2（<圖片>.thumb.webp；沒附縮圖時以原圖代替，縮圖一定存在）；
// 建立資料列失敗或刪除照片時，原圖與縮圖一起刪除（R2 與搬移前的 Supabase 舊檔）。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, fakeR2, formDataRequestInit, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

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

const anonymize = (key) => key.replace(/^[^/]+\/[^.]+/, "<image>");

function setup({ rpcStatus = 200, failPut } = {}) {
  const events = [];
  const bucket = fakeR2({ events, failPut });
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_add_product_image") {
      events.push("rpc");
      return rpcStatus === 200 ? jsonResponse({ id: body.p_image_id, updated_at: "2026-10-08T14:00:00Z", width: 1600, height: 1108, alt_text: "" }) : jsonResponse({ message: "PRODUCT_IMAGE_LIMIT" }, rpcStatus);
    }
    if (url.pathname === "/rest/v1/rpc/admin_delete_product_image") return jsonResponse({ storage_path: `${PRODUCT_ID}/${IMAGE_ID}.webp` });
    if (url.pathname === "/rest/v1/product_images") return jsonResponse([{ updated_at: "2026-10-08T14:00:00Z" }]);
    if (url.pathname === "/storage/v1/object/product-images" && init.method === "DELETE") { events.push(["supabase-delete", body.prefixes]); return jsonResponse({}); }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  return { events, env: { ...baseEnv, PRODUCT_IMAGES: bucket, IMAGE_BASE_URL: "https://img.test" } };
}

async function upload(env, withThumbnail = true) {
  const formData = new FormData();
  formData.append("image", webpFile("photo.webp"));
  if (withThumbnail) formData.append("thumbnail", webpFile("photo.thumb.webp"));
  const { body, headers } = await formDataRequestInit(formData);
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/images`, {
    method: "POST", headers: { Authorization: "Bearer admin-access-token", ...headers }, body
  }), env, ctx());
}

test("a gallery photo with a thumbnail stores both in R2 before the photo row is created", async () => {
  const { events, env } = setup();
  const response = await upload(env);
  assert.equal(response.status, 201);
  assert.deepEqual(events.map((event) => Array.isArray(event) ? [event[0], anonymize(event[1]), event[2]] : event), [
    ["put", "<image>.webp", "image/webp"],
    ["put", "<image>.thumb.webp", "image/webp"],
    "rpc"
  ]);
  const { image } = await response.json();
  assert.match(image.url, new RegExp(`^https://img\\.test/${PRODUCT_ID}/[0-9a-f-]+\\.webp\\?v=`));
});

test("a gallery photo without a thumbnail (640px or smaller) stores the photo again as its thumbnail", async () => {
  const { events, env } = setup();
  assert.equal((await upload(env, false)).status, 201);
  const puts = events.filter((event) => Array.isArray(event) && event[0] === "put").map((event) => anonymize(event[1]));
  assert.deepEqual(puts, ["<image>.webp", "<image>.thumb.webp"]);
  const [main, thumbnail] = [...env.PRODUCT_IMAGES.objects.values()];
  assert.deepEqual(thumbnail.bytes, main.bytes);
});

test("a failed thumbnail write falls back to the photo so the thumbnail still exists", async () => {
  let failed = false;
  const { env } = setup({ failPut: (key) => key.endsWith(".thumb.webp") && !failed && (failed = true) });
  assert.equal((await upload(env)).status, 201);
  assert.equal([...env.PRODUCT_IMAGES.objects.keys()].filter((key) => key.endsWith(".thumb.webp")).length, 1);
});

test("a failed photo write rejects the upload before the photo row is created", async () => {
  const { events, env } = setup({ failPut: (key) => !key.endsWith(".thumb.webp") });
  assert.equal((await upload(env)).status, 502);
  assert.ok(!events.includes("rpc"));
});

test("when the photo row cannot be created, the photo and its thumbnail are both removed", async () => {
  const { events, env } = setup({ rpcStatus: 400 });
  assert.equal((await upload(env)).status, 400);
  const [, keys] = events.find((event) => Array.isArray(event) && event[0] === "r2-delete");
  assert.equal(keys.length, 2);
  assert.match(keys[0], new RegExp(`^${PRODUCT_ID}/[0-9a-f-]+\\.webp$`));
  assert.equal(keys[1], keys[0].replace(/\.webp$/, ".thumb.webp"));
  assert.equal(env.PRODUCT_IMAGES.objects.size, 0);
});

test("deleting a gallery photo deletes it and its thumbnail from R2 and the old Supabase storage", async () => {
  const { events, env } = setup();
  const response = await worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/images/${IMAGE_ID}`, {
    method: "DELETE", headers: { Authorization: "Bearer admin-access-token" }
  }), env, ctx());
  assert.equal(response.status, 200);
  const expected = [`${PRODUCT_ID}/${IMAGE_ID}.webp`, `${PRODUCT_ID}/${IMAGE_ID}.thumb.webp`];
  assert.deepEqual(events.find((event) => event[0] === "r2-delete"), ["r2-delete", expected]);
  assert.deepEqual(events.find((event) => event[0] === "supabase-delete"), ["supabase-delete", expected]);
});
