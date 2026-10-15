// 首頁 modulepreload 清單：與 app.js 的靜態 import 樹一致（改了 import 沒重新產生會失敗），
// 後台以動態 import 延後載入的 module 不列入，每個檔案只列一次且確實存在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLIC_DIR, normalizeNewlines } from "../../scripts/build-css.mjs";
import { modulepreloadBlock, modulepreloadPaths, replaceBlock } from "../../scripts/build-modulepreload.mjs";

const indexHtml = async () => normalizeNewlines(await readFile(join(PUBLIC_DIR, "index.html"), "utf8"));
const preloaded = (html) => [...html.matchAll(/<link rel="modulepreload" href="\/([^"]+)"/g)].map(([, file]) => file);

test("the modulepreload list matches the app.js import tree (run node scripts/build-modulepreload.mjs after changing imports)", async () => {
  const html = await indexHtml();
  assert.equal(replaceBlock(html, modulepreloadBlock(await modulepreloadPaths())), html, "index.html modulepreload list is out of date");
});

test("each preloaded module exists, appears once and is not a lazily loaded admin panel", async () => {
  const files = preloaded(await indexHtml());
  assert.ok(files.length > 0);
  assert.equal(new Set(files).size, files.length);
  assert.ok(!files.includes("app.js"), "app.js is loaded by its own script tag");
  assert.ok(!files.includes("admin-app.js"), "the admin app stays behind its dynamic import");
  for (const file of files) await access(join(PUBLIC_DIR, file));
});

test("a missing marker fails loudly instead of skipping the list", () => {
  assert.throws(() => replaceBlock("<head></head>", modulepreloadBlock(["a.js"])), /modulepreload/);
});
