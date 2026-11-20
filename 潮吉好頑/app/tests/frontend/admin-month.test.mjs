// 後台月份篩選：台灣時間月份、下拉選項、各訂單分類的預設月份與搜尋時不限月份。
import test from "node:test";
import assert from "node:assert/strict";
import { defaultOrderMonth, monthLabel, monthOptionsMarkup, orderMonthQuery, taipeiMonth } from "../../public/admin-month.js";

test("the month follows Taipei time, not UTC", () => {
  assert.equal(taipeiMonth(new Date("2026-10-31T16:00:00Z")), "2026-11", "00:00 on Nov 1 in Taipei");
  assert.equal(taipeiMonth(new Date("2026-10-31T15:59:59Z")), "2026-10");
});

test("month labels read as 年／月 and all months", () => {
  assert.equal(monthLabel("2026-09"), "2026 年 9 月");
  assert.equal(monthLabel("all"), "全部月份");
});

test("options list all months first, then months newest first, always including this month", () => {
  const html = monthOptionsMarkup(["2026-09", "2026-10"], "2026-10");
  const values = [...html.matchAll(/value="([^"]+)"/g)].map(([, value]) => value);
  assert.equal(values[0], "all");
  assert.deepEqual(values.slice(1), [...new Set([taipeiMonth(), "2026-10", "2026-09"])].sort().reverse());
  assert.match(html, /value="2026-10" selected/);
});

test("closed tabs default to this month; tabs still being worked on default to all months", () => {
  assert.equal(defaultOrderMonth("completed"), taipeiMonth());
  assert.equal(defaultOrderMonth("cancelled"), taipeiMonth());
  for (const status of ["all", "pending_payment", "pending_review", "awaiting_arrival", "awaiting_balance", "ready_to_ship"]) {
    assert.equal(defaultOrderMonth(status), "all", status);
  }
});

test("searching for an order ignores the month filter", () => {
  assert.equal(orderMonthQuery("CJ-261024"), "all");
});
