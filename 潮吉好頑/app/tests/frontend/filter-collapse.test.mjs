// 手機版系列篩選收合：依按鈕所在列數算出前兩列的顆數，與「更多」按鈕文字。
import test from "node:test";
import assert from "node:assert/strict";
import { chipsInFirstRows, moreLabel, widthChanged } from "../../public/filter-collapse.js";

test("counts the chips that sit on the first two rows", () => {
  assert.equal(chipsInFirstRows([0, 0, 0, 50, 50, 100, 100]), 5);
});

test("treats small offsetTop differences as the same row", () => {
  assert.equal(chipsInFirstRows([0, 1, 0, 51, 50, 102]), 5);
});

test("keeps every chip when they fit on two rows", () => {
  assert.equal(chipsInFirstRows([0, 0, 50]), 3);
});

test("the more button names how many series are hidden", () => {
  assert.equal(moreLabel(4), "＋更多 4 個系列");
});

test("a height-only resize (iPhone toolbar collapsing) does not recalculate the rows", () => {
  assert.equal(widthChanged(390, 390), false);
});

test("a width change recalculates the rows", () => {
  assert.equal(widthChanged(390, 844), true);
});
