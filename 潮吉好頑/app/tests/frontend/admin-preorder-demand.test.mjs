// 後台預購叫貨分頁的統計表畫面。
import { test } from "node:test";
import assert from "node:assert/strict";
import { preorderDemandHtml } from "../../public/admin-preorder-demand-view.js";

test("empty data shows a plain message", () => {
  assert.match(preorderDemandHtml([]), /目前沒有預購訂單/);
});

test("rows show the three stages, escape names and total the paid quantity", () => {
  const html = preorderDemandHtml([
    { product_name: "<b>盲盒</b>", variant_name: "整盒", arrival: "11 月下旬", paid: 4, unpaid: 2, arrived: 1 },
    { product_name: "卡包", variant_name: "單包", arrival: null, paid: 6, unpaid: 0, arrived: 0 }
  ]);
  assert.match(html, /&lt;b&gt;盲盒&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>盲盒/);
  assert.match(html, /11 月下旬/);
  assert.match(html, /已付款合計 <strong>10<\/strong> 件/);
});
