// 首頁 CSS 合併檔：內容與原始檔一致（改了原始檔沒重新產生會失敗）、首頁不再同時載入已合併的原始檔、
// 後台樣式不被合併（它們在原位置延後載入，維持覆寫順序）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { CSS_BUNDLES, PUBLIC_DIR, bundleContent, normalizeNewlines } from "../../scripts/build-css.mjs";

const html = (name) => readFile(join(PUBLIC_DIR, name), "utf8");
const stylesheets = (source) => [...source.matchAll(/<link rel="stylesheet" (href|data-admin-href)="\/([^"]+)"/g)].map(([, kind, file]) => ({ kind, file }));

test("each bundle matches its source files (run node scripts/build-css.mjs after editing them)", async () => {
  for (const name of Object.keys(CSS_BUNDLES)) {
    assert.equal(normalizeNewlines(await html(name)), await bundleContent(name), `${name} is out of date`);
  }
});

test("the pages load each style once, through the bundle when it is bundled", async () => {
  const bundled = new Set(Object.values(CSS_BUNDLES).flat());
  for (const page of ["index.html", "orders.html"]) {
    const links = stylesheets(await html(page));
    const expanded = links.flatMap(({ file }) => CSS_BUNDLES[file] || [file]);
    assert.equal(new Set(expanded).size, expanded.length, `${page} loads a style twice`);
    for (const { kind, file } of links) {
      assert.ok(!bundled.has(file), `${page} links ${file} directly although it is inside a bundle`);
      if (kind === "href") await access(join(PUBLIC_DIR, file));
    }
  }
});

test("a Windows CRLF checkout of the same files still counts as up to date", async () => {
  const name = "bundle-base.css";
  assert.equal(normalizeNewlines((await html(name)).replace(/\n/g, "\r\n")), await bundleContent(name));
});

test("admin styles stay out of the bundles so their override order is unchanged", async () => {
  const admin = stylesheets(await html("index.html")).filter(({ kind }) => kind === "data-admin-href").map(({ file }) => file);
  assert.ok(admin.length > 0);
  for (const file of Object.values(CSS_BUNDLES).flat()) assert.ok(!admin.includes(file) && !file.startsWith("admin-"), file);
});
