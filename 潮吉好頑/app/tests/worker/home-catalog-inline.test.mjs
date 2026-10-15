// 首頁內嵌型錄：Worker 及時取得型錄時寫進 HTML（與 /api/catalog 相同的 JSON），逾時則不內嵌、前台改另外請求；
// 後台輸入的商品文字不能提早結束資料區塊。Node 沒有 HTMLRewriter：插入位置與移除 <head> 提早請求由 share-meta.ts 的規則負責，以 worker-dev 實測。
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { baseEnv, ctx, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const { CATALOG_DATA_ID, catalogDataScript, homeBootMarkup } = await loadSourceModule("share-meta.ts");

let restoreFetch = () => {};
let originalCaches;
beforeEach(() => {
  originalCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => false } };
});
afterEach(() => {
  restoreFetch();
  globalThis.caches = originalCaches;
});

const readBlock = (markup) => {
  const open = `<script type="application/json" id="${CATALOG_DATA_ID}">`;
  assert.ok(markup.startsWith(open) && markup.endsWith("</script>"), "one data block");
  const body = markup.slice(open.length, -"</script>".length);
  assert.ok(!body.includes("</script"), "nothing closes the block early");
  return body;
};

test("product text cannot close the data block or open a comment", () => {
  const name = "</script><script>alert(1)</script><!-- 好頑";
  const body = readBlock(catalogDataScript([{ id: "v1", name }]));
  assert.ok(!body.includes("<"), "every < is escaped");
  assert.deepEqual(JSON.parse(body), { products: [{ id: "v1", name }] });
});

// 慢的情境放前面：型錄在 isolate 內快取 30 秒，成功載入後同一模組不會再等
test("a slow catalog is not inlined so the storefront requests it instead", async () => {
  restoreFetch = stubFetch(() => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({}, 500)), 400)));
  const execution = ctx();
  const markup = await homeBootMarkup(baseEnv, new URL("https://slow-inline.test/"), execution);
  assert.equal(markup.catalogData, "");
  await execution.settle();
});

test("a catalog that arrives in time is inlined with the same products as /api/catalog", async () => {
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/rest/v1/storefront_variants") return jsonResponse([{ id: "v1", product_id: "p1", product_name: "陀螺", stock: 2, type: "現貨", price: 500, is_published: true, display_order: 1 }]);
    return jsonResponse([]);
  });
  const { catalogData } = await homeBootMarkup(baseEnv, new URL("https://inline.test/"));
  const { products } = JSON.parse(readBlock(catalogData));
  assert.equal(products.length, 1);
  assert.equal(products[0].id, "v1");
});

// 執行設定只來自部署設定，首頁與商品頁都內嵌；前台 liff-session.js 以同一個 id 讀取
test("the runtime config is inlined with the same fields as /api/config", async () => {
  const { CONFIG_DATA_ID, configDataScript } = await loadSourceModule("share-meta.ts");
  const { runtimeConfig } = await loadSourceModule("catalog.ts");
  const markup = await configDataScript(baseEnv);
  const open = `<script type="application/json" id="${CONFIG_DATA_ID}">`;
  assert.ok(markup.startsWith(open) && markup.endsWith("</script>"));
  assert.deepEqual(JSON.parse(markup.slice(open.length, -"</script>".length)), await runtimeConfig(baseEnv));
  const frontend = await readFile(new URL("../../public/liff-session.js", import.meta.url), "utf8");
  assert.ok(frontend.includes(`const CONFIG_DATA_ID = "${CONFIG_DATA_ID}";`), "the storefront reads the same id");
});
