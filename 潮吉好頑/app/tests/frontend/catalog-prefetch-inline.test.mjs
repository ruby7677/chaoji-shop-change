// 首頁已內嵌型錄時：catalog-prefetch.js 讀內嵌資料、不發 /api/catalog，讀完移除資料區塊，來源標成 inline。
import { test } from "node:test";
import assert from "node:assert/strict";

test("an inlined catalog is used without requesting /api/catalog", async () => {
  const calls = [];
  let removed = false;
  const node = { textContent: JSON.stringify({ products: [{ id: "v1" }] }), remove: () => { removed = true; } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => { calls.push(url); return Promise.resolve(new Response("{}")); };
  globalThis.document = { getElementById: (id) => (id === "cj-catalog-data" ? node : null) };
  try {
    const { prefetchedCatalogSource, takePrefetchedCatalog } = await import("../../public/catalog-prefetch.js?inline");
    assert.equal(prefetchedCatalogSource, "inline");
    assert.ok(removed);
    const response = await takePrefetchedCatalog();
    assert.deepEqual(await response.json(), { products: [{ id: "v1" }] });
    assert.equal(takePrefetchedCatalog(), null);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.document;
  }
});
