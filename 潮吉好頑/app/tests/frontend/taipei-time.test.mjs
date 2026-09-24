// 前後台日期一律以台灣時間顯示與輸入：結果不隨執行環境（瀏覽器）的時區改變。
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, taipeiDateTimeInputToIso, taipeiDateTimeInputValue } from "../../public/app-core.js";

test("datetime-local values are Taiwan wall-clock time", () => {
  assert.equal(taipeiDateTimeInputValue("2026-09-24T16:30:00Z"), "2026-09-25T00:30");
  assert.equal(taipeiDateTimeInputToIso("2026-09-25T00:30"), "2026-09-24T16:30:00.000Z");
});

test("the coupon form round-trips a stored time unchanged", () => {
  const stored = "2026-10-31T15:59:00.000Z";
  assert.equal(taipeiDateTimeInputToIso(taipeiDateTimeInputValue(stored)), stored);
});

test("dates are shown on the Taiwan calendar day", () => {
  assert.equal(formatDate("2026-09-24T16:30:00Z"), formatDate("2026-09-25T03:00:00Z"), "both are 2026-09-25 in Taiwan");
  assert.notEqual(formatDate("2026-09-24T15:30:00Z"), formatDate("2026-09-24T16:30:00Z"), "Taiwan midnight separates the days");
});
