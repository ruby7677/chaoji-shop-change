// workers.dev 舊網址的網頁 GET／HEAD 301 轉到正式網域；API、其他方法與未設定時不轉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, loadWorker } from "./harness.mjs";

const worker = await loadWorker();
const LEGACY = "chaoji-haowan-shop.ruby7677.workers.dev";
const env = { ...baseEnv, CANONICAL_HOST: "super-fun.767780.xyz", LEGACY_HOST: LEGACY };
const call = (host, path, init = {}, useEnv = env) => worker.fetch(new Request(`https://${host}${path}`, init), useEnv, ctx());

test("legacy host pages redirect with 301 to the same path and query", async () => {
  for (const path of ["/", "/orders", "/admin", "/products/aaaaaaaa-0000-4000-8000-000000000001?v=2"]) {
    const response = await call(LEGACY, path);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("Location"), `https://super-fun.767780.xyz${path}`);
    assert.match(response.headers.get("Cache-Control"), /max-age=\d+/);
    assert.ok(response.headers.get("Content-Security-Policy"));
  }
});

test("HEAD redirects too, other methods do not", async () => {
  assert.equal((await call(LEGACY, "/", { method: "HEAD" })).status, 301);
  const post = await call(LEGACY, "/orders", { method: "POST" });
  assert.notEqual(post.status, 301);
});

test("legacy host API requests are not redirected", async () => {
  const response = await call(LEGACY, "/api/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

// 首頁會用 HTMLRewriter（Node 沒有），改用直接交給 ASSETS 的路徑
test("canonical host, other hosts and an unset variable are served normally", async () => {
  assert.equal((await call("super-fun.767780.xyz", "/app.js")).status, 200);
  assert.equal((await call("shop.test", "/app.js")).status, 200);
  assert.equal((await call(LEGACY, "/app.js", {}, baseEnv)).status, 200);
  assert.equal((await call(`preview-${LEGACY}`, "/app.js")).status, 200, "version preview hosts are not the legacy host");
});
