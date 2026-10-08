// 靜態檔不經過 Worker 時由 public/_headers 加上安全標頭；這裡鎖住兩件事：
// 1. _headers 的標頭與 src/http.ts 的 SECURITY_HEADERS 完全相同（改 CSP hash 時不會只改一邊）；
// 2. wrangler.jsonc 的 run_worker_first 涵蓋需要 Worker 的路徑（分享預覽與 API）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSourceModule } from "./harness.mjs";

const appFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const { SECURITY_HEADERS } = await loadSourceModule("http.ts");
const { isShareMetaRequest } = await loadSourceModule("share-meta.ts");

function parseHeaders(text) {
  const rules = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = new Map(); rules.set(line.trim(), current); continue; }
    const index = line.indexOf(":");
    current.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return rules;
}

// 與 Cloudflare 規則相同：* 可跨越多層路徑
const matches = (pattern, path) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(path);

const runWorkerFirst = async () => {
  const config = JSON.parse((await appFile("wrangler.jsonc")).replace(/^\s*\/\/.*$/gm, ""));
  return config.assets.run_worker_first;
};

test("public/_headers applies exactly the Worker's security headers to every static path", async () => {
  const rules = parseHeaders(await appFile("public/_headers"));
  assert.deepEqual([...rules.keys()], ["/*"]);
  assert.deepEqual(Object.fromEntries(rules.get("/*")), SECURITY_HEADERS);
});

test("run_worker_first sends share-preview pages and the API to the Worker", async () => {
  const patterns = await runWorkerFirst();
  assert.ok(Array.isArray(patterns), "static files must not all run through the Worker");
  const workerFirst = (path) => patterns.some((pattern) => matches(pattern, path));
  const product = "/products/aaaaaaaa-0000-4000-8000-000000000001";
  for (const path of ["/", "/index.html", product]) {
    assert.equal(isShareMetaRequest(new Request(`https://shop.test${path}`), new URL(`https://shop.test${path}`)), true, path);
    assert.ok(workerFirst(path), `${path} needs the Worker for share meta`);
  }
  for (const path of ["/api/catalog", "/api/admin/dashboard", "/api/product-images/x"]) assert.ok(workerFirst(path), path);
  for (const path of ["/app.js", "/styles.css", "/admin"]) assert.equal(workerFirst(path), false, `${path} is served as a static asset`);
});

test("robots.txt is a real robots file, not the single-page fallback", async () => {
  const { readFile } = await import("node:fs/promises");
  const robots = await readFile(new URL("../../public/robots.txt", import.meta.url), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.doesNotMatch(robots, /<html/i);
});
