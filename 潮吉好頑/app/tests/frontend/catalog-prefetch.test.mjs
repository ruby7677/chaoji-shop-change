// 開機型錄提早請求：載入模組即發出唯一一次 /api/catalog，開機取用一次後交回 null，之後由 loadProducts 另外請求。
import { test } from "node:test";
import assert from "node:assert/strict";

test("the catalog is fetched once on load and handed over only once", async () => {
  const calls = [];
  const response = new Response("{}");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url) => { calls.push(url); return Promise.resolve(response); };
  try {
    const { prefetchedCatalogSource, takePrefetchedCatalog } = await import("../../public/catalog-prefetch.js");
    assert.equal(prefetchedCatalogSource, "request");
    assert.deepEqual(calls, ["/api/catalog"]);
    assert.equal(await takePrefetchedCatalog(), response);
    assert.equal(takePrefetchedCatalog(), null);
    assert.deepEqual(calls, ["/api/catalog"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
