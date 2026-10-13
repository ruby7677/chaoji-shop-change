// 觸控診斷（?cj_touch=）：模式解析、商品卡觸控目標分類、捲動狀態、第幾次觸控與面板文字。
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_WINDOW_MS, attemptNumber, classifyTarget, describeElement, formatRecord, scrollContext, touchMode } from "../../public/touch-diagnostics-core.js";

// 最小的假元素：closest 依 selectors 清單判斷是否在某個祖先內
const element = (tagName, className, ancestors = []) => ({ tagName, className, closest: (selector) => (ancestors.includes(selector) ? {} : null) });
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });

test("the mode comes from the param, falls back to the tab's choice, and 0 turns it off", () => {
  assert.equal(touchMode("1", null), "a");
  assert.equal(touchMode("b", "a"), "b");
  assert.equal(touchMode(null, "b"), "b");
  assert.equal(touchMode("0", "b"), null);
  assert.equal(touchMode(null, null), null);
  assert.equal(touchMode(null, "x"), null);
});

test("buttons are classified by their data attribute before the card area", () => {
  const card = [".product-card"];
  assert.equal(classifyTarget(element("BUTTON", "", ["[data-add]", ...card]), { x: 0, y: 0 }), "加入購物車");
  assert.equal(classifyTarget(element("BUTTON", "card-choose-variant", ["[data-choose-variant]", ...card]), { x: 0, y: 0 }), "選擇規格");
  assert.equal(classifyTarget(element("BUTTON", "", ["[data-buy-now]", ...card]), { x: 0, y: 0 }), "直接購買");
});

test("the stretched name link is split into image and name by where the finger landed", () => {
  const link = element("A", "product-card-link", [".product-card"]);
  const rects = { image: rect(0, 0, 100, 100), title: rect(0, 110, 100, 140) };
  assert.equal(classifyTarget(link, { x: 50, y: 50 }, rects), "圖片");
  assert.equal(classifyTarget(link, { x: 50, y: 120 }, rects), "名稱");
  assert.equal(classifyTarget(link, { x: 50, y: 200 }, rects), "卡片其他");
  assert.equal(classifyTarget(element("A", "", []), { x: 0, y: 0 }), "其他");
});

test("elements are described by tag and first class only", () => {
  assert.equal(describeElement({ tagName: "A", className: "product-card-link extra" }), "A.product-card-link");
  assert.equal(describeElement({ tagName: "IMG", className: "" }), "IMG");
  assert.equal(describeElement(null), "?");
});

test("scroll context reports raw timing and whether scrollend arrived, without a threshold", () => {
  assert.deepEqual(scrollContext(1000, { lastScrollAt: null, lastScrollEndAt: null, scrollendSupported: true }), { sinceScroll: null, ended: "—" });
  assert.deepEqual(scrollContext(1000, { lastScrollAt: 700, lastScrollEndAt: 800, scrollendSupported: true }), { sinceScroll: 300, ended: "有" });
  assert.deepEqual(scrollContext(1000, { lastScrollAt: 900, lastScrollEndAt: 800, scrollendSupported: true }), { sinceScroll: 100, ended: "未收到" });
  assert.deepEqual(scrollContext(1000, { lastScrollAt: 900, lastScrollEndAt: null, scrollendSupported: false }), { sinceScroll: 100, ended: "不支援" });
});

test("repeated touches on the same target count up until one produces a click", () => {
  const records = [{ key: "3:圖片", downAt: 1000, attempt: 1, clicked: false }];
  assert.equal(attemptNumber(records, "3:圖片", 2000), 2);
  assert.equal(attemptNumber(records, "4:圖片", 2000), 1);
  assert.equal(attemptNumber(records, "3:圖片", 1000 + RETRY_WINDOW_MS + 1), 1);
  assert.equal(attemptNumber([{ ...records[0], clicked: true }], "3:圖片", 2000), 1);
});

test("each record is two lines: result first, then scroll state and event timings", () => {
  const lines = formatRecord({
    id: 4, variant: "b", kind: "名稱", card: 3, attempt: 2, clicked: true, clickKind: "名稱",
    sinceScroll: 1840, ended: "有", target: "A.product-card-link",
    events: [["pointerup", 92], ["mouseover", 95], ["mousedown", 96], ["click", 98]]
  });
  assert.deepEqual(lines, [
    "#4 B 名稱(卡3) 第2次 ✓click",
    "  距捲動1840ms end:有｜A.product-card-link｜up92 mo95 md96 ck98"
  ]);
  const missed = formatRecord({ id: 1, variant: "a", kind: "圖片", card: 1, attempt: 1, clicked: false, clickKind: null, sinceScroll: null, ended: "—", target: "A.product-card-link", events: [["pointerup", 80], ["mouseover", 82]] });
  assert.equal(missed[0], "#1 A 圖片(卡1) 第1次 ✗無click");
  assert.equal(missed[1], "  未捲動 end:—｜A.product-card-link｜up80 mo82");
});
