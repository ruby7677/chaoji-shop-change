// 獨立訂單頁（/orders）內嵌執行設定：Worker 回傳 orders.html 時把與 /api/config 相同的設定寫在 body 最後，
// 不帶條件式標頭向 ASSETS 取檔（部署設定改了但 HTML 沒變時，304 會沿用舊設定），並拿掉 ETag。
// Node 沒有 HTMLRewriter：以只處理 body 結尾插入的假版本驗證接線；實際插入位置以 worker-dev 實測。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, loadSourceModule, loadWorker } from "./harness.mjs";

const worker = await loadWorker();
const { isOrdersPageRequest } = await loadSourceModule("orders-page.ts");
const { CONFIG_DATA_ID } = await loadSourceModule("share-meta.ts");
const { runtimeConfig } = await loadSourceModule("catalog.ts");

const ORDERS_HTML = '<!doctype html><html><head></head><body class="orders-page"><main></main></body></html>';

class FakeRewriter {
  constructor() { this.handlers = []; }
  on(selector, handler) { this.handlers.push([selector, handler]); return this; }
  transform(response) {
    const appended = [];
    for (const [selector, handler] of this.handlers) {
      if (selector === "body") handler.element({ append: (html) => appended.push(html) });
    }
    return new Response(response.body.pipeThrough(new TransformStream({
      transform: (chunk, controller) => controller.enqueue(chunk),
      flush: (controller) => controller.enqueue(new TextEncoder().encode(appended.join("")))
    })), response);
  }
}

afterEach(() => { delete globalThis.HTMLRewriter; });

function ordersEnv(assetFetch) {
  return { ...baseEnv, ORDERS_LIFF_ID: "2000000000-orders", ASSETS: { fetch: assetFetch } };
}

test("only a GET of /orders is rewritten", () => {
  assert.equal(isOrdersPageRequest(new Request("https://shop.test/orders"), new URL("https://shop.test/orders")), true);
  assert.equal(isOrdersPageRequest(new Request("https://shop.test/orders", { method: "HEAD" }), new URL("https://shop.test/orders")), false);
  assert.equal(isOrdersPageRequest(new Request("https://shop.test/api/orders"), new URL("https://shop.test/api/orders")), false);
});

test("the orders page carries the runtime config and is fetched without conditional headers", async () => {
  globalThis.HTMLRewriter = FakeRewriter;
  let assetRequest;
  const env = ordersEnv(async (request) => {
    assetRequest = request;
    return new Response(ORDERS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"static"' } });
  });
  const response = await worker.fetch(new Request("https://shop.test/orders", { headers: { "If-None-Match": '"static"', "If-Modified-Since": "Wed, 01 Oct 2026 00:00:00 GMT" } }), env, ctx());
  assert.equal(assetRequest.headers.get("If-None-Match"), null);
  assert.equal(assetRequest.headers.get("If-Modified-Since"), null);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), null, "the static ETag no longer describes the rewritten page");
  assert.ok(response.headers.get("Content-Security-Policy"), "security headers still apply");
  const html = await response.text();
  const open = `<script type="application/json" id="${CONFIG_DATA_ID}">`;
  const data = html.slice(html.indexOf(open) + open.length, html.lastIndexOf("</script>"));
  assert.ok(html.indexOf(open) > html.indexOf("<main>"), "the data block comes after the page content");
  const config = JSON.parse(data);
  assert.deepEqual(config, await runtimeConfig(env));
  assert.equal(config.ordersLiffId, "2000000000-orders");
});

test("a missing or non-HTML asset is passed through untouched", async () => {
  globalThis.HTMLRewriter = class { constructor() { throw new Error("must not rewrite"); } };
  const response = await worker.fetch(new Request("https://shop.test/orders"), ordersEnv(async () => new Response("missing", { status: 404 })), ctx());
  assert.equal(response.status, 404);
  assert.equal(await response.text(), "missing");
});
