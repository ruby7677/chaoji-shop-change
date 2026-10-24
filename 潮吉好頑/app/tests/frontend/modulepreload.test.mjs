// 前台 modulepreload 清單（首頁 index.html、訂單頁 orders.html）：與入口的靜態 import 樹一致（改了 import 沒重新產生會失敗），
// 後台以動態 import 延後載入的 module 不列入，每個檔案只列一次且確實存在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_DIR, normalizeNewlines } from "../../scripts/build-css.mjs";
import { PAGES, modulepreloadBlock, modulepreloadPaths, replaceBlock } from "../../scripts/build-modulepreload.mjs";

const pageHtml = async (file) => normalizeNewlines(await readFile(join(PUBLIC_DIR, file), "utf8"));
const preloaded = (html) => [...html.matchAll(/<link rel="modulepreload" href="\/([^"]+)"/g)].map(([, file]) => file);

for (const { html: file, entry } of PAGES) {
  test(`${file}: the modulepreload list matches the ${entry} import tree (run node scripts/build-modulepreload.mjs after changing imports)`, async () => {
    const html = await pageHtml(file);
    assert.equal(replaceBlock(html, modulepreloadBlock(await modulepreloadPaths(entry))), html, `${file} modulepreload list is out of date`);
  });

  test(`${file}: each preloaded module exists, appears once and is not a lazily loaded admin panel`, async () => {
    const files = preloaded(await pageHtml(file));
    assert.ok(files.length > 0);
    assert.equal(new Set(files).size, files.length);
    assert.ok(!files.includes(entry), `${entry} is loaded by its own script tag`);
    assert.ok(!files.includes("admin-app.js"), "the admin app stays behind its dynamic import");
    for (const name of files) await access(join(PUBLIC_DIR, name));
  });
}

test("the orders page does not preload the storefront", async () => {
  const files = preloaded(await pageHtml("orders.html"));
  for (const name of ["app.js", "storefront-catalog.js", "catalog-prefetch.js", "cart.js"]) assert.ok(!files.includes(name), name);
});

test("a missing marker fails loudly instead of skipping the list", () => {
  assert.throws(() => replaceBlock("<head></head>", modulepreloadBlock(["a.js"])), /modulepreload/);
});
