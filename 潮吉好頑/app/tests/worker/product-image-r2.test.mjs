// 商品圖片改放 R2：網址組法（R2 公開網域／Worker 路由）、型錄與商品頁輸出縮圖網址、一次性搬檔端點、
// 後台網址與 Worker 的縮圖路徑規則一致。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, fakeR2, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";
import { thumbnailKeyFor, adminPrimaryImageSrc, adminGalleryImageSrc } from "../../public/product-image-src.js";

const worker = await loadWorker();
const urls = await loadSourceModule("product-image-urls.ts");
const storage = await loadSourceModule("product-image-storage.ts");
const PRODUCT_ID = "aaaaaaaa-0000-4000-8000-000000000009";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("with IMAGE_BASE_URL the main image and thumbnail point at the R2 domain", () => {
  assert.deepEqual(urls.primaryImageUrls({ IMAGE_BASE_URL: "https://img.test/" }, PRODUCT_ID, `${PRODUCT_ID}/a b.jpg`, "2026-10-09T00:00:00Z"), {
    image_url: `https://img.test/${PRODUCT_ID}/a%20b.jpg?v=2026-10-09T00%3A00%3A00Z`,
    thumb_url: `https://img.test/${PRODUCT_ID}/a%20b.thumb.webp?v=2026-10-09T00%3A00%3A00Z`
  });
});

test("without IMAGE_BASE_URL images keep using the Worker route", () => {
  assert.deepEqual(urls.primaryImageUrls({}, PRODUCT_ID, `${PRODUCT_ID}/a.jpg`, null), {
    image_url: `/api/product-images/${PRODUCT_ID}?v=1`,
    thumb_url: `/api/product-images/${PRODUCT_ID}?v=1&size=thumb`
  });
  assert.equal(urls.primaryImageUrls({ IMAGE_BASE_URL: "https://img.test" }, PRODUCT_ID, null, "v"), null, "no photo, no address");
  assert.equal(urls.galleryImageUrl({}, PRODUCT_ID, { id: "g1", storage_path: `${PRODUCT_ID}/g1.webp`, updated_at: "u" }), `/api/product-images/${PRODUCT_ID}/g1?v=u`);
  assert.equal(urls.galleryImageUrl({ IMAGE_BASE_URL: "https://img.test" }, PRODUCT_ID, { id: "g1", storage_path: `${PRODUCT_ID}/g1.webp`, updated_at: "u" }), `https://img.test/${PRODUCT_ID}/g1.webp?v=u`);
});

test("the admin pages derive the same thumbnail path as the Worker", () => {
  for (const key of [`${PRODUCT_ID}/primary.jpg`, `${PRODUCT_ID}/x.y.png`, `${PRODUCT_ID}/noext`]) {
    assert.equal(thumbnailKeyFor(key), storage.thumbnailPathFor(key), key);
  }
  const product = { id: PRODUCT_ID, image_path: `${PRODUCT_ID}/a.jpg`, image_updated_at: "v1" };
  assert.equal(adminPrimaryImageSrc(product, { thumb: true }, "https://img.test"), `https://img.test/${PRODUCT_ID}/a.thumb.webp?v=v1`);
  assert.equal(adminPrimaryImageSrc(product, { thumb: true }, null), `/api/product-images/${PRODUCT_ID}?v=v1&size=thumb`);
  assert.equal(adminPrimaryImageSrc({ id: PRODUCT_ID }, {}, "https://img.test"), "");
  assert.equal(adminGalleryImageSrc(PRODUCT_ID, { id: "g1", storage_path: `${PRODUCT_ID}/g1.webp`, updated_at: "u" }, "https://img.test"), `https://img.test/${PRODUCT_ID}/g1.thumb.webp?v=u`);
});

test("the catalog gives every photo a thumbnail address and leaves products without photos empty", async () => {
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/storefront_variants") {
      assert.match(url.search, /image_path/);
      return jsonResponse([
        { id: "v1", category: "A", name: "有圖", price: 1, stock: 1, type: "現貨", product_id: PRODUCT_ID, has_image: true, image_path: `${PRODUCT_ID}/a.webp`, image_updated_at: "v1" },
        { id: "v2", category: "A", name: "沒圖", price: 1, stock: 1, type: "現貨", product_id: "p2", has_image: false, image_path: null, image_updated_at: null }
      ]);
    }
    return jsonResponse([]);
  });
  const response = await worker.fetch(new Request("https://catalog-r2.test/api/catalog"), { ...baseEnv, IMAGE_BASE_URL: "https://img.test" }, ctx());
  const { products } = await response.json();
  assert.equal(products[0].image_url, `https://img.test/${PRODUCT_ID}/a.webp?v=v1`);
  assert.equal(products[0].thumb_url, `https://img.test/${PRODUCT_ID}/a.thumb.webp?v=v1`);
  assert.equal(products[1].image_url, undefined);
  assert.equal(products[1].thumb_url, undefined);
});

function migrationSetup(legacy) {
  const fetched = [];
  const pages = [];
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/products") { pages.push(url.search); return jsonResponse([{ image_path: "p1/a.jpg" }]); }
    if (url.pathname === "/rest/v1/product_images") { pages.push(url.search); return jsonResponse([{ storage_path: "p1/a.jpg" }, { storage_path: "p1/b.png" }]); }
    if (url.pathname.startsWith("/storage/v1/object/product-images/")) {
      const key = decodeURIComponent(url.pathname.replace("/storage/v1/object/product-images/", ""));
      fetched.push(key);
      if (!legacy[key]) return new Response("{}", { status: 400 });
      return new Response(new Uint8Array(legacy[key].bytes), { headers: { "Content-Type": legacy[key].type } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const bucket = fakeR2();
  return { bucket, fetched, pages, env: { ...baseEnv, PRODUCT_IMAGES: bucket } };
}

function migrate(env, { token = baseEnv.SUPABASE_SERVICE_ROLE_KEY, query = "" } = {}) {
  return worker.fetch(new Request(`https://shop.test/api/internal/r2-migrate${query}`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {} }), env, ctx());
}

test("the copy endpoint only accepts the service role key", async () => {
  const { env, bucket } = migrationSetup({});
  assert.equal((await migrate(env, { token: "" })).status, 401);
  assert.equal((await migrate(env, { token: "anon-key" })).status, 401);
  assert.equal(bucket.objects.size, 0);
});

test("the copy endpoint copies each photo once, keeps real thumbnails and uses the photo when a thumbnail is missing", async () => {
  const { env, bucket, pages } = migrationSetup({
    "p1/a.jpg": { bytes: [1], type: "image/jpeg" },
    "p1/a.thumb.webp": { bytes: [2], type: "image/webp" },
    "p1/b.png": { bytes: [3], type: "image/png" }
  });
  const first = await (await migrate(env)).json();
  assert.deepEqual({ total: first.total, copied: first.copied, failed: first.failed, next: first.next_cursor }, { total: 2, copied: 2, failed: [], next: null });
  assert.ok(pages.every((search) => /order=\w+&limit=1000&offset=0/.test(search)), "path lists are read in sorted pages");
  assert.deepEqual([...bucket.objects.get("p1/a.thumb.webp").bytes], [2]);
  assert.deepEqual([...bucket.objects.get("p1/b.thumb.webp").bytes], [3], "a small photo without a thumbnail becomes its own thumbnail");
  assert.equal(bucket.objects.get("p1/b.thumb.webp").httpMetadata.contentType, "image/png");
  assert.equal(bucket.objects.get("p1/a.jpg").httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  const second = await (await migrate(env)).json();
  assert.deepEqual({ pending: second.pending_in_batch, copied: second.copied }, { pending: 0, copied: 0 }, "running again copies nothing");
});

test("the copy endpoint reports photos missing from Supabase and respects the batch limit", async () => {
  const { env } = migrationSetup({ "p1/a.jpg": { bytes: [1], type: "image/jpeg" } });
  const limited = await (await migrate(env, { query: "?limit=1" })).json();
  assert.equal(limited.copied, 1);
  assert.equal(limited.next_cursor, "p1/a.jpg", "the next call continues after the last checked path");
  const rest = await (await migrate(env, { query: `?after=${encodeURIComponent(limited.next_cursor)}` })).json();
  assert.deepEqual(rest.failed.map((item) => item.key), ["p1/b.png"]);
  assert.equal(rest.next_cursor, null);
});

test("the copy batch shrinks so listing pages and downloads stay within the free plan's 50 fetches", async () => {
  const pageOfPaths = (offset) => Array.from({ length: 1000 }, (_, index) => ({ image_path: `p${offset + index}/a.jpg`, storage_path: `p${offset + index}/a.jpg` }));
  restoreFetch = stubFetch(async (url) => {
    const offset = Number(url.searchParams.get("offset"));
    // 每張表 24 頁滿的清單：清單就用掉 50 次以上，沒有剩餘額度可以搬檔
    if (url.pathname === "/rest/v1/products" || url.pathname === "/rest/v1/product_images") return jsonResponse(offset < 23000 ? pageOfPaths(offset) : []);
    throw new Error(`unexpected request ${url}`);
  });
  const response = await migrate({ ...baseEnv, PRODUCT_IMAGES: fakeR2() });
  assert.equal(response.status, 507);
});
