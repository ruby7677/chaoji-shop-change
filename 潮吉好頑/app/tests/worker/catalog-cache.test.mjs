// 前台型錄 publicCatalog() 的 Worker 內記憶體快取：TTL 內共用、併發請求合併成一個 in-flight
// promise、讀取失敗不快取，以及 invalidateCatalogCache() 強制下一次重新讀取。
// 這層只存在 Worker isolate 記憶體內，回應給瀏覽器的 Cache-Control 維持 no-store
// （見 routes.test.mjs／index.ts），此處只驗證模組內快取本身。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const env = Object.freeze({ SUPABASE_URL: "https://db.test", SUPABASE_ANON_KEY: "anon-key" });
const { publicCatalog, invalidateCatalogCache } = await loadSourceModule("catalog.ts");

let restoreFetch = () => {};
beforeEach(() => invalidateCatalogCache());
afterEach(() => { restoreFetch(); invalidateCatalogCache(); });

function fakeSupabase(rows = []) {
  let calls = 0;
  restoreFetch = stubFetch((url) => {
    assert.equal(url.pathname, "/rest/v1/storefront_variants");
    calls += 1;
    return jsonResponse(rows);
  });
  return () => calls;
}

test("two catalog reads within the TTL only hit Supabase once", async () => {
  const callCount = fakeSupabase([{ id: "v1", category: "A", name: "商品", price: 100, stock: 5, type: "現貨" }]);
  const first = await publicCatalog(env);
  const second = await publicCatalog(env);
  assert.equal(callCount(), 1, "the second read is served from the in-isolate cache");
  assert.deepEqual(first, second);
});

test("concurrent reads before the first response lands share one in-flight request", async () => {
  const callCount = fakeSupabase([{ id: "v1", category: "A", name: "商品", price: 100, stock: 5, type: "現貨" }]);
  const [first, second] = await Promise.all([publicCatalog(env), publicCatalog(env)]);
  assert.equal(callCount(), 1, "concurrent callers coalesce onto the same upstream request");
  assert.deepEqual(first, second);
});

test("invalidateCatalogCache() forces the next read to refetch", async () => {
  const callCount = fakeSupabase([{ id: "v1", category: "A", name: "商品", price: 100, stock: 5, type: "現貨" }]);
  await publicCatalog(env);
  invalidateCatalogCache();
  await publicCatalog(env);
  assert.equal(callCount(), 2, "invalidation makes the following read hit Supabase again");
});

test("a read started before invalidation does not write stale data back into the cache", async () => {
  let calls = 0;
  let releaseFirst;
  restoreFetch = stubFetch(() => {
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { releaseFirst = () => resolve(jsonResponse([{ id: "old", category: "A", name: "舊", price: 100, stock: 5, type: "現貨" }])); });
    return jsonResponse([{ id: "new", category: "A", name: "新", price: 200, stock: 5, type: "現貨" }]);
  });
  const stale = publicCatalog(env);
  invalidateCatalogCache();
  releaseFirst();
  assert.equal((await stale)[0].id, "old", "the caller that started before invalidation still gets its own response");
  const fresh = await publicCatalog(env);
  assert.equal(fresh[0].id, "new", "the next read refetches instead of reusing the pre-invalidation data");
  assert.equal(calls, 2);
});

// 邊緣快取（Cache API）替身：同機房所有 isolate 共用；另外打包一份 catalog-edge-cache 模組代表「另一個 isolate」
function fakeEdgeCache() {
  const store = new Map();
  globalThis.caches = { default: {
    match: async (key) => (store.has(key) ? new Response(store.get(key).body, { headers: store.get(key).headers }) : undefined),
    put: async (key, response) => { store.set(key, { body: await response.text(), headers: [...response.headers] }); },
    delete: async (key) => store.delete(key)
  } };
  return store;
}
const ORIGIN = "https://shop.test";
const EDGE_KEY = `${ORIGIN}/__edge-cache/catalog/v1`;
const otherIsolate = await loadSourceModule("catalog-edge-cache.ts");
const storedCatalog = (products, loadedAt) => ({ body: JSON.stringify(products), headers: [["x-catalog-loaded-at", String(loadedAt)]] });

test("a catalog another isolate stored in the edge cache is served without calling Supabase", async () => {
  const store = fakeEdgeCache();
  store.set(EDGE_KEY, storedCatalog([{ id: "edge", category: "A", name: "邊緣", price: 1, stock: 1, type: "現貨" }], Date.now()));
  let calls = 0;
  restoreFetch = stubFetch(() => { calls += 1; return jsonResponse([]); });
  try {
    const result = await publicCatalog(env, ORIGIN);
    assert.equal(result[0].id, "edge");
    assert.equal(calls, 0);
  } finally { delete globalThis.caches; }
});

test("a fresh load is written to the edge cache and invalidation makes every isolate ignore it", async () => {
  const store = fakeEdgeCache();
  fakeSupabase([{ id: "v1", category: "A", name: "商品", price: 100, stock: 5, type: "現貨" }]);
  try {
    await publicCatalog(env, ORIGIN);
    assert.equal(JSON.parse(store.get(EDGE_KEY).body)[0].id, "v1");
    await new Promise((resolve) => setTimeout(resolve, 2));
    await invalidateCatalogCache(new Request(`${ORIGIN}/api/admin/products/x`, { method: "PATCH" }));
    assert.equal(await otherIsolate.readEdgeCatalog(ORIGIN), null);
  } finally { delete globalThis.caches; }
});

test("invalidation clears the edge copy for the writing request's origin even if this isolate never read it", async () => {
  const store = fakeEdgeCache();
  const otherOrigin = "https://admin.example";
  store.set(`${otherOrigin}/__edge-cache/catalog/v1`, storedCatalog([], 1));
  try {
    await invalidateCatalogCache(new Request(`${otherOrigin}/api/admin/products/x`, { method: "PATCH" }));
    assert.equal(await otherIsolate.readEdgeCatalog(otherOrigin), null);
  } finally { delete globalThis.caches; }
});

test("another isolate's stale load that finishes after invalidation is never served", async () => {
  fakeEdgeCache();
  try {
    const startedBefore = Date.now() - 50;
    // 本 isolate 失效後，另一個 isolate 才把「失效前就開始讀取」的舊型錄寫回共享快取
    await invalidateCatalogCache(new Request(`${ORIGIN}/api/orders`, { method: "POST" }));
    await otherIsolate.writeEdgeCatalog(ORIGIN, [{ id: "stale" }], startedBefore);
    assert.equal(await otherIsolate.readEdgeCatalog(ORIGIN), null);
  } finally { delete globalThis.caches; }
});

test("an older invalidation marker finishing late does not move the marker backwards", async () => {
  const store = fakeEdgeCache();
  const markerKey = `${ORIGIN}/__edge-cache/catalog/v1-invalidated-at`;
  store.set(markerKey, { body: String(Date.now() + 60_000), headers: [] });
  try {
    await otherIsolate.deleteEdgeCatalog(ORIGIN);
    assert.ok(Number(store.get(markerKey).body) > Date.now() + 30_000, "a newer marker is kept");
  } finally { delete globalThis.caches; }
});

test("a read waits for an invalidation in progress instead of picking up the copy being removed", async () => {
  const store = fakeEdgeCache();
  store.set(EDGE_KEY, storedCatalog([{ id: "old" }], Date.now() - 50));
  const pendingDeletes = [];
  const remove = globalThis.caches.default.delete;
  globalThis.caches.default.delete = (key) => new Promise((resolve) => { pendingDeletes.push(() => resolve(remove(key))); });
  try {
    const invalidating = otherIsolate.deleteEdgeCatalog(ORIGIN);
    while (!pendingDeletes.length) await new Promise((resolve) => setTimeout(resolve, 0));
    const reading = otherIsolate.readEdgeCatalog(ORIGIN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pendingDeletes.forEach((release) => release());
    await invalidating;
    assert.equal(await reading, null);
  } finally { delete globalThis.caches; }
});

const serviceEnv = Object.freeze({ ...env, SUPABASE_SERVICE_ROLE_KEY: "service-key" });

test("each product carries its category's admin sort order (read with the service role)", async () => {
  let categoryAuth = null;
  restoreFetch = stubFetch((url, init) => {
    if (url.pathname === "/rest/v1/categories") {
      categoryAuth = new Headers(init.headers).get("Authorization");
      assert.equal(url.searchParams.get("select"), "name,display_order");
      return jsonResponse([{ name: "A", display_order: 20 }, { name: "B", display_order: 10 }]);
    }
    return jsonResponse([{ id: "v1", category: "A", name: "甲", price: 1, stock: 1, type: "現貨" }, { id: "v2", category: "C", name: "丙", price: 1, stock: 1, type: "現貨" }]);
  });
  const result = await publicCatalog(serviceEnv);
  assert.equal(categoryAuth, "Bearer service-key");
  assert.equal(result[0].category_order, 20);
  assert.equal("category_order" in result[1], false, "a category without a row gets no order");
});

test("a failed category lookup still returns the catalog without sort orders", async () => {
  restoreFetch = stubFetch((url) => url.pathname === "/rest/v1/categories"
    ? jsonResponse({ message: "down" }, 503)
    : jsonResponse([{ id: "v1", category: "A", name: "甲", price: 1, stock: 1, type: "現貨" }]));
  const result = await publicCatalog(serviceEnv);
  assert.equal(result.length, 1);
  assert.equal(result[0].category_order, undefined);
});

test("a failed upstream load is not cached and the next read retries", async () => {
  let calls = 0;
  restoreFetch = stubFetch(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({ message: "down" }, 503) : jsonResponse([{ id: "v1", category: "A", name: "商品", price: 100, stock: 5, type: "現貨" }]);
  });
  await assert.rejects(() => publicCatalog(env));
  const result = await publicCatalog(env);
  assert.equal(calls, 2, "the failed load was not cached, so the second call reaches Supabase again");
  assert.equal(result.length, 1);
});
