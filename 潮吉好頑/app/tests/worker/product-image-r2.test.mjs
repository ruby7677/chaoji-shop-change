// 商品圖片改放 R2：網址組法（R2 公開網域／Worker 路由）、型錄與商品頁輸出縮圖網址、
// 後台網址與 Worker 的縮圖路徑規則一致。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";
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
