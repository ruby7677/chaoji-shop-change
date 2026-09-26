// 商品主圖縮圖：上傳（驗證、儲存、失敗容忍）、供圖（size=thumb 與 404 回退）、
// 邊緣快取 key 區分縮圖與完整圖，以及更換主圖時一併清除舊縮圖。
// Storage 全部以假的 globalThis.fetch 取代；邊緣快取以記憶體 Map 假冒 Cache API（Node 沒有全域 caches）。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

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
  globalThis.__testCacheStore = store;
});

afterEach(() => {
  restoreFetch();
  globalThis.caches = originalCaches;
  delete globalThis.__testCacheStore;
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

/** 假的 Supabase：驗管理員、商品資料表、RPC 更新主圖、Storage 物件上傳／讀取／刪除，全部記錄呼叫方便驗證。 */
function fakeSupabase({ productRow = { id: PRODUCT_ID, image_path: null, image_updated_at: null }, thumbnailUploadStatus = 200, mainUploadStatus = 200 } = {}) {
  const state = { productRow, storageObjects: new Map() };
  const calls = { uploads: [], gets: [], deletes: [], rpc: null };
  restoreFetch = stubFetch(async (url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/products") return jsonResponse([state.productRow]);
    if (url.pathname === "/rest/v1/rpc/admin_update_product_image") {
      calls.rpc = body;
      state.productRow = { ...state.productRow, image_path: body.p_image_path, image_updated_at: body.p_image_updated_at };
      return jsonResponse({});
    }
    if (url.pathname.startsWith("/storage/v1/object/product-images/")) {
      const path = decodeURIComponent(url.pathname.replace("/storage/v1/object/product-images/", ""));
      if (init.method === "POST") {
        calls.uploads.push(path);
        const status = path.endsWith(".thumb.webp") ? thumbnailUploadStatus : mainUploadStatus;
        if (status >= 200 && status < 300) state.storageObjects.set(path, true);
        return new Response(status < 300 ? "{}" : "upload failed", { status });
      }
      calls.gets.push(path);
      // 與正式 Supabase Storage 相同：物件不存在時回 400（body 內才是 404），不是 HTTP 404
      if (!state.storageObjects.has(path)) return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": path.endsWith(".webp") ? "image/webp" : "image/jpeg" } });
    }
    if (url.pathname === "/storage/v1/object/product-images" && init.method === "DELETE") {
      calls.deletes.push(body.prefixes);
      body.prefixes.forEach((prefix) => state.storageObjects.delete(prefix));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  return { state, calls };
}

function uploadRequest(formData) {
  return worker.fetch(new Request(`https://shop.test/api/admin/products/${PRODUCT_ID}/image`, {
    method: "POST",
    headers: { Authorization: "Bearer admin-access-token" },
    body: formData
  }), baseEnv, ctx());
}

function serveRequest(query = "") {
  return worker.fetch(new Request(`https://shop.test/api/product-images/${PRODUCT_ID}${query}`), baseEnv, ctx());
}

test("thumbnailPathFor keeps the folder and swaps the extension for .thumb.webp", () => {
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.webp`), `${PRODUCT_ID}/primary.thumb.webp`);
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.jpg`), `${PRODUCT_ID}/primary.thumb.webp`);
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.png`), `${PRODUCT_ID}/primary.thumb.webp`);
  // 主圖副檔名改變時，縮圖路徑（只看 basename）維持不變，換圖不會留下孤兒縮圖路徑。
  assert.equal(storage.thumbnailPathFor(`${PRODUCT_ID}/primary.jpg`), storage.thumbnailPathFor(`${PRODUCT_ID}/primary.webp`));
});

test("productImageCacheKey differs between the full image and size=thumb", () => {
  const request = new Request(`https://shop.test/api/product-images/${PRODUCT_ID}?v=abc`);
  const fullKey = storage.productImageCacheKey(request, PRODUCT_ID, undefined, "abc");
  const thumbKey = storage.productImageCacheKey(request, PRODUCT_ID, undefined, "abc", "thumb");
  assert.notEqual(fullKey.url, thumbKey.url);
  assert.ok(thumbKey.url.includes("size=thumb"));
  assert.ok(!fullKey.url.includes("size=thumb"));
});

test("uploading main image with a thumbnail stores both storage objects", async () => {
  const { calls } = fakeSupabase();
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", webpFile("thumb.webp"));
  const response = await uploadRequest(formData);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.image_url, new RegExp(`^/api/product-images/${PRODUCT_ID}\\?v=`));
  assert.deepEqual(calls.uploads, [`${PRODUCT_ID}/primary.webp`, `${PRODUCT_ID}/primary.thumb.webp`], "main image is uploaded before the thumbnail");
});

test("an invalid thumbnail (wrong MIME type) rejects the whole request before anything is stored", async () => {
  const { calls } = fakeSupabase();
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", jpegFile("thumb.jpg"));
  const response = await uploadRequest(formData);
  assert.equal(response.status, 400);
  assert.deepEqual(calls.uploads, [], "no storage write happens once the thumbnail fails validation");
  assert.equal(calls.rpc, null, "the database is never updated");
});

test("an invalid thumbnail (bad file signature) rejects the whole request before anything is stored", async () => {
  const { calls } = fakeSupabase();
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", badSignatureWebpFile());
  const response = await uploadRequest(formData);
  assert.equal(response.status, 400);
  assert.deepEqual(calls.uploads, []);
  assert.equal(calls.rpc, null);
});

test("a thumbnail upload failure still returns success for the main image", async () => {
  const { calls } = fakeSupabase({ thumbnailUploadStatus: 500 });
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  formData.append("thumbnail", webpFile("thumb.webp"));
  const response = await uploadRequest(formData);
  assert.equal(response.status, 200, "the main image succeeded, so the request is still a success");
  const body = await response.json();
  assert.match(body.image_url, new RegExp(`^/api/product-images/${PRODUCT_ID}\\?v=`));
  assert.deepEqual(calls.uploads, [`${PRODUCT_ID}/primary.webp`, `${PRODUCT_ID}/primary.thumb.webp`], "the thumbnail upload was still attempted");
  assert.ok(calls.deletes.flat().includes(`${PRODUCT_ID}/primary.thumb.webp`), "a failed thumbnail upload removes the old thumbnail so cards fall back to the new main image");
});

test("serving size=thumb returns the thumbnail bytes when the thumbnail object exists", async () => {
  const { state } = fakeSupabase({ productRow: { id: PRODUCT_ID, image_path: `${PRODUCT_ID}/primary.webp`, image_updated_at: "v1" } });
  state.storageObjects.set(`${PRODUCT_ID}/primary.thumb.webp`, true);
  state.storageObjects.set(`${PRODUCT_ID}/primary.webp`, true);
  const response = await serveRequest("?v=v1&size=thumb");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/webp");
});

test("serving size=thumb falls back to the full image when the thumbnail object is missing", async () => {
  const { calls, state } = fakeSupabase({ productRow: { id: PRODUCT_ID, image_path: `${PRODUCT_ID}/primary.webp`, image_updated_at: "v1" } });
  // 只有主圖存在，沒有縮圖物件。
  state.storageObjects.set(`${PRODUCT_ID}/primary.webp`, true);
  const response = await serveRequest("?v=v1&size=thumb");
  assert.equal(response.status, 200);
  assert.deepEqual(calls.gets, [`${PRODUCT_ID}/primary.thumb.webp`, `${PRODUCT_ID}/primary.webp`], "thumbnail is tried first, then the full image on 404");
});

test("an unknown size value is ignored and the full image is served", async () => {
  const { calls, state } = fakeSupabase({ productRow: { id: PRODUCT_ID, image_path: `${PRODUCT_ID}/primary.webp`, image_updated_at: "v1" } });
  state.storageObjects.set(`${PRODUCT_ID}/primary.webp`, true);
  const response = await serveRequest("?v=v1&size=huge");
  assert.equal(response.status, 200);
  assert.deepEqual(calls.gets, [`${PRODUCT_ID}/primary.webp`], "no thumbnail lookup happens for an unrecognized size");
});

test("replacing the main image deletes the old thumbnail so stale thumbnails are not served", async () => {
  const { calls, state } = fakeSupabase({ productRow: { id: PRODUCT_ID, image_path: `${PRODUCT_ID}/primary.jpg`, image_updated_at: "v1" } });
  state.storageObjects.set(`${PRODUCT_ID}/primary.jpg`, true);
  state.storageObjects.set(`${PRODUCT_ID}/primary.thumb.webp`, true);
  const formData = new FormData();
  formData.append("image", webpFile("main.webp"));
  // 這次沒有附上新縮圖：舊縮圖必須被清除，避免 size=thumb 之後還服務到舊內容。
  const response = await uploadRequest(formData);
  assert.equal(response.status, 200);
  assert.ok(!state.storageObjects.has(`${PRODUCT_ID}/primary.jpg`), "old main object is gone");
  assert.ok(!state.storageObjects.has(`${PRODUCT_ID}/primary.thumb.webp`), "old thumbnail object is gone");
  assert.ok(calls.deletes.flat().includes(`${PRODUCT_ID}/primary.jpg`));
});
