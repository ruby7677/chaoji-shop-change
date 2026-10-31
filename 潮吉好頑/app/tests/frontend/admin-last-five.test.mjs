// 後台訂單卡的末五碼：有值時醒目標示（會跳脫 HTML），未回報時只顯示灰字。
import test from "node:test";
import assert from "node:assert/strict";
import { lastFiveMarkup } from "../../public/admin-last-five.js";

test("有末五碼時以醒目樣式顯示數字", () => {
  assert.equal(lastFiveMarkup("93968"), '<b class="admin-last-five">93968</b>');
});

test("未回報時顯示灰字，不套用數字樣式", () => {
  assert.equal(lastFiveMarkup(""), '<span class="admin-last-five-missing">尚未回報</span>');
  assert.equal(lastFiveMarkup(null, "未填"), '<span class="admin-last-five-missing">未填</span>');
});

test("值會跳脫 HTML", () => {
  assert.equal(lastFiveMarkup("<i>1</i>"), '<b class="admin-last-five">&lt;i&gt;1&lt;/i&gt;</b>');
});
