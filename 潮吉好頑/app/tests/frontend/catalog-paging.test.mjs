// 首頁商品分批顯示：第一批 40 件、載入更多每次 +40、切換條件回到第一批、
// 開機時沿用 sessionStorage 記住的展開數量（從商品頁回來或重新整理後才能捲回原位）。
import { test } from "node:test";
import assert from "node:assert/strict";

const data = new Map([["cj-catalog-limit", JSON.stringify({ key: "all|", limit: 120 })]]);
globalThis.sessionStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
const { PAGE_SIZE, loadMoreMarkup, showMore, visibleLimit } = await import("../../public/catalog-paging.js");

test("the first render restores the remembered expansion for the same list", () => {
  assert.equal(PAGE_SIZE, 40);
  assert.equal(visibleLimit("all|"), 120);
});

test("changing the series or search starts from the first batch, and re-rendering the same list keeps it", () => {
  assert.equal(visibleLimit("BX系列|"), 40);
  assert.equal(visibleLimit("BX系列|"), 40);
  assert.equal(showMore(), 40, "returns how many were shown before");
  assert.equal(visibleLimit("BX系列|"), 80, "a stock refresh of the same list keeps the expansion");
  assert.deepEqual(JSON.parse(data.get("cj-catalog-limit")), { key: "BX系列|", limit: 80 });
  assert.equal(visibleLimit("all|"), 40);
});

test("the button shows progress and the next batch size; the end says everything is shown", () => {
  const markup = loadMoreMarkup(40, 112);
  assert.match(markup, /已顯示 40 \/ 112 件/);
  assert.match(markup, /載入更多商品/);
  assert.match(markup, /\+40/);
  assert.match(loadMoreMarkup(80, 112), /\+32/);
  assert.match(loadMoreMarkup(112, 112), /已顯示全部 112 件商品/);
  assert.equal(loadMoreMarkup(12, 12), "", "a short list needs no footer");
});
