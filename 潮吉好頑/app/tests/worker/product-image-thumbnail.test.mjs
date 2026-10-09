// 商品主圖與縮圖：上傳到 R2（每次新檔名、縮圖一定存在、驗證失敗不寫入）、Worker 供圖（R2 優先、
// 搬移前的舊檔改讀 Supabase、size=thumb 讀不到時回退原圖）、邊緣快取 key 區分縮圖與完整圖，以及更換主圖時刪除舊檔。
// Supabase 以假的 globalThis.fetch 取代、R2 以記憶體 bucket 取代；邊緣快取以記憶體 Map 假冒 Cache API。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, fakeR2, formDataRequestInit, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const storage = await loadSourceModule("product-image-storage");

const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const LINE_ID = "U" + "a".repeat(32);

let restoreFetch = () => {};
let originalCaches;

beforeEach(() => {
  originalCaches = globalThis.caches;
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (request) => store.get(request.url),
      put: async (request, response) => { store.set(request.url, response); },
      delete: async (request) => store.delete(request.url)
    }
  };
});

afterEach(() => {
  restoreFetch();
  globalThis.caches = originalCaches;
});

const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const JPEG_HEADER = [0xff, 0xd8, 0xff];

function webpFile(name = "thumb.webp") {
  return new File([new Uint8Array([...WEBP_HEADER, 1, 2, 3, 4])], name, { type: "image/webp" });
}

function jpegFile(name = "photo.jpg") {
  return new File([new Uint8Array([...JPEG_HEADER, 1, 2, 3, 4])], name, { type: "image/jpeg" });
}

function badSignatureWebpFile(name = "fake.webp") {
  // 副檔名／MIME 宣稱是 webp，但檔案內容完全不是 RIFF/WEBP，hasImageSignature() 應判為不一致。
  return new File([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], name, { type: "image/webp" });
}

/** 假的 Supabase：驗管理員、商品資料表、RPC 更新主圖、搬移前的舊 Storage 物件（只讀與刪除），全部記錄呼叫方便驗證。 */
function setup({ productRow = { id: PRODUCT_ID, image_path: null, image_updated_at: null }, rpcStatus = 200, failPut, imageBaseUrl = "" } = {}) {
  const state = { productRow, legacyObjects: new Map() };
  const calls = { legacyGets: [], supabaseDeletes: [], rpc: null };
  const bucket = fakeR2({ failPut });
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/products") return jsonResponse([state.productRow]);
    if (url.pathname === "/rest/v1/rpc/admin_update_product_image") {
      calls.rpc = body;
      if (rpcStatus !== 200) return jsonResponse({ message: "PRODUCT_NOT_FOUND" }, rpcStatus);
      state.productRow = { ...state.productRow, image_path: body.p_image_path, image_updated_at: body.p_image_updated_at };
      return jsonResponse({});
    }
    if (url.pathname.startsWith("/storage/v1/object/product-images/")) {
      const path = decodeURIComponent(url.pathname.replace("/storage/v1/object/product-images/", ""));
      calls.legacyGets.push(path);
      // 與正式 Supabase Storage 相同：物件不存在時回 400（body 內才是 404），不是 HTTP 404
      if (!state.legacyObjects.has(path)) return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
      return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "Content-Type": path.endsWith(".webp") ? "image/webp" : "image/jpeg" } });
    }
    if (url.pathname === "/storage/v1/object/product-images" && init.method === "DELETE") {
      calls.supabaseDeletes.push(body.prefixes);
      body.prefixes.forEach((prefix) => state.legacyObjects.delete(prefix));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  const env = { ...baseEnv, PRODUCT_IMAGES: bucket, IMAGE_BASE_URL: imageBaseUrl };
  return { state, calls, bucket, env };
}

async function uploadRequest(env, formData) {
  // A real browser upload sends a Content-Length header; a Request built
  // directly from a FormData body in Node does not, so it has to be computed.
  const { body, headers } = await formDataRequestInit(formData);
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/image`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-access-token", ...headers },
    body
  }), env, ctx());
}

function serveRequest(env, query = "") {
  return worker.fetch(new Request(`https://shop.test/api/product-images/${PRODUCT_ID}${query}`), env, ctx());
}

function mainAndThumbnail(withThumbnail = true) {
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  if (withThumbnail) formData.append("thumbnail", webpFile("thumb.webp"));
  return formData;
}

const failFirstThumbnailWrite = () => {
  let failed = false;
  return (key) => key.endsWith(".thumb.webp") && !failed && (failed = true);
};

const NEW_KEY = new RegExp(`^${PRODUCT_ID}/[0-9a-f-]{36}\\.webp$`);

test("thumbnailPathFor keeps the folder and swaps the extension for .thumb.webp", () => {
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.webp`), `${PRODUCT_ID}/primary.thumb.webp`);
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.jpg`), `${PRODUCT_ID}/primary.thumb.webp`);
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/abc.png`), `${PRODUCT_ID}/abc.thumb.webp`);
});

test("productImageCacheKey differs between the full image and size=thumb", () => {
  const request = new Request(`https://shop.test/api/product-images/${PRODUCT_ID}?v=abc`);
  const fullKey = storage.productImageCacheKey(request, PRODUCT_ID, undefined, "abc");
  const thumbKey = storage.productImageCacheKey(request, PRODUCT_ID, undefined, "abc", "thumb");
  assert.notEqual(fullKey.url, thumbKey.url);
  assert.ok(thumbKey.url.includes("size=thumb"));
  assert.ok(!fullKey.url.includes("size=thumb"));
});

test("uploading a main image stores it and its thumbnail in R2 under a new file name with long cache headers", async () => {
  const { bucket, calls, env } = setup();
  const response = await uploadRequest(env, mainAndThumbnail());
  assert.equal(response.status, 200);
  const keys = [...bucket.objects.keys()];
  assert.equal(keys.length, 2);
  assert.match(keys[0], NEW_KEY, "main image is written first, under a random name");
  assert.equal(keys[1], keys[0].replace(/\.webp$/, ".thumb.webp"));
  assert.equal(calls.rpc.p_image_path, keys[0]);
  for (const object of bucket.objects.values()) {
    assert.equal(object.httpMetadata.contentType, "image/webp");
    assert.equal(object.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  }
  assert.match((await response.json()).image_url, new RegExp(`^/api/product-images/${PRODUCT_ID}\\?v=`), "without IMAGE_BASE_URL the Worker route is returned");
});

test("with IMAGE_BASE_URL the upload returns the public R2 address", async () => {
  const { env, bucket } = setup({ imageBaseUrl: "https://img.test/" });
  const response = await uploadRequest(env, mainAndThumbnail());
  const [key] = bucket.objects.keys();
  assert.ok((await response.json()).image_url.startsWith(`https://img.test/${key}?v=`));
});

test("an invalid thumbnail (wrong MIME type) rejects the whole request before anything is stored", async () => {
  const { bucket, calls, env } = setup();
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", jpegFile("thumb.jpg"));
  assert.equal((await uploadRequest(env, formData)).status, 400);
  assert.equal(bucket.objects.size, 0, "no storage write happens once the thumbnail fails validation");
  assert.equal(calls.rpc, null, "the database is never updated");
});

test("an invalid thumbnail (bad file signature) rejects the whole request before anything is stored", async () => {
  const { bucket, calls, env } = setup();
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", badSignatureWebpFile());
  assert.equal((await uploadRequest(env, formData)).status, 400);
  assert.equal(bucket.objects.size, 0);
  assert.equal(calls.rpc, null);
});

test("without a thumbnail (640px or smaller) the main image is stored as the thumbnail too", async () => {
  const { bucket, env } = setup();
  assert.equal((await uploadRequest(env, mainAndThumbnail(false))).status, 200);
  const [main, thumbnail] = [...bucket.objects.values()];
  assert.deepEqual(thumbnail.bytes, main.bytes);
});

test("a failed thumbnail write still succeeds and stores the main image as the thumbnail", async () => {
  const { bucket, env } = setup({ failPut: failFirstThumbnailWrite() });
  assert.equal((await uploadRequest(env, mainAndThumbnail())).status, 200);
  const [main, thumbnail] = [...bucket.objects.values()];
  assert.deepEqual(thumbnail.bytes, main.bytes);
});

test("a failed main image write returns 502 and never updates the database", async () => {
  const { calls, env } = setup({ failPut: (key) => !key.endsWith(".thumb.webp") });
  assert.equal((await uploadRequest(env, mainAndThumbnail())).status, 502);
  assert.equal(calls.rpc, null);
});

test("when the database update fails the new objects are removed", async () => {
  const { bucket, env } = setup({ rpcStatus: 400 });
  assert.equal((await uploadRequest(env, mainAndThumbnail())).status, 400);
  assert.equal(bucket.objects.size, 0);
});

test("replacing the main image keeps the old files so pages still showing the old address do not break", async () => {
  const oldPath = `${PRODUCT_ID}/primary.jpg`;
  const oldThumbnail = `${PRODUCT_ID}/primary.thumb.webp`;
  const { bucket, calls, env } = setup({ productRow: { id: PRODUCT_ID, image_path: oldPath, image_updated_at: "v1" } });
  await bucket.put(oldPath, new Uint8Array([1]));
  await bucket.put(oldThumbnail, new Uint8Array([1]));
  assert.equal((await uploadRequest(env, mainAndThumbnail())).status, 200);
  assert.ok(bucket.objects.has(oldPath));
  assert.ok(bucket.objects.has(oldThumbnail));
  assert.deepEqual(calls.supabaseDeletes, []);
  assert.equal(bucket.objects.size, 4, "the new image and thumbnail are added next to the old ones");
});

test("serving size=thumb returns the R2 thumbnail with its stored content type", async () => {
  const path = `${PRODUCT_ID}/abc.jpg`;
  const { bucket, calls, env } = setup({ productRow: { id: PRODUCT_ID, image_path: path, image_updated_at: "v1" } });
  await bucket.put(path, new Uint8Array([1]), { httpMetadata: { contentType: "image/jpeg" } });
  await bucket.put(`${PRODUCT_ID}/abc.thumb.webp`, new Uint8Array([2]), { httpMetadata: { contentType: "image/webp" } });
  const response = await serveRequest(env, "?v=v1&size=thumb");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/webp");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2]);
  assert.deepEqual(calls.legacyGets, [], "Supabase is not read when R2 has the object");
});

test("images not yet copied to R2 are read from the old Supabase storage", async () => {
  const path = `${PRODUCT_ID}/primary.webp`;
  const { state, env } = setup({ productRow: { id: PRODUCT_ID, image_path: path, image_updated_at: "v1" } });
  state.legacyObjects.set(path, true);
  const response = await serveRequest(env, "?v=v1");
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [9, 9, 9]);
});

test("serving size=thumb falls back to the full image when no thumbnail exists anywhere", async () => {
  const path = `${PRODUCT_ID}/primary.webp`;
  const { calls, state, env } = setup({ productRow: { id: PRODUCT_ID, image_path: path, image_updated_at: "v1" } });
  state.legacyObjects.set(path, true);
  assert.equal((await serveRequest(env, "?v=v1&size=thumb")).status, 200);
  assert.deepEqual(calls.legacyGets, [`${PRODUCT_ID}/primary.thumb.webp`, path], "thumbnail is tried first, then the full image");
});

test("an unknown size value is ignored and the full image is served", async () => {
  const path = `${PRODUCT_ID}/primary.webp`;
  const { calls, state, env } = setup({ productRow: { id: PRODUCT_ID, image_path: path, image_updated_at: "v1" } });
  state.legacyObjects.set(path, true);
  assert.equal((await serveRequest(env, "?v=v1&size=huge")).status, 200);
  assert.deepEqual(calls.legacyGets, [path], "no thumbnail lookup happens for an unrecognized size");
});
