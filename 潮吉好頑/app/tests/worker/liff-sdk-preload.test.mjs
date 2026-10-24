// 從 LIFF 開啟首頁或商品頁時，Worker 在 HTML 預先載入 LINE SDK；一般瀏覽器與 LINE 內建瀏覽器開一般連結不載入。
// 插入位置由 share-meta.ts 的 HTMLRewriter 規則負責（Node 沒有 HTMLRewriter），以 worker-dev 實測。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSourceModule } from "./harness.mjs";

const { LIFF_SDK_URL, liffSdkPreloadMarkup } = await loadSourceModule("share-meta.ts");
const frontend = await import("../../public/liff-auth.js");

const IOS_LINE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.12.1";
const markupFor = (href, userAgent = "") => liffSdkPreloadMarkup(new Request(href, { headers: userAgent ? { "User-Agent": userAgent } : {} }), new URL(href));

test("the Worker preloads the same SDK URL the storefront loads, with the same crossorigin", () => {
  assert.equal(LIFF_SDK_URL, frontend.LIFF_SDK_URL);
  const markup = markupFor("https://shop.test/", `${IOS_LINE} LIFF`);
  assert.equal(markup, `<link rel="preload" href="${LIFF_SDK_URL}" as="script" crossorigin="anonymous" />`);
});

test("LIFF launches preload the SDK", () => {
  assert.ok(markupFor("https://shop.test/?liff.state=%2Fproducts%2Fx"), "primary redirect");
  assert.ok(markupFor("https://shop.test/?cj_liff_oauth=1700000000000", IOS_LINE), "LINE login callback");
  assert.ok(markupFor("https://shop.test/products/x", `${IOS_LINE} LIFF`), "LIFF browser");
});

test("ordinary browsers and LINE's in-app browser do not download the SDK", () => {
  assert.equal(markupFor("https://shop.test/", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36"), "");
  assert.equal(markupFor("https://shop.test/", IOS_LINE), "");
  assert.equal(markupFor("https://shop.test/?ref=liff"), "");
  assert.equal(markupFor("https://shop.test/", "Mozilla/5.0 Mobile Safari CLIFFORD/1.0"), "");
});
