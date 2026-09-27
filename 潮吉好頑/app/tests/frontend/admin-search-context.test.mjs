// 頂欄搜尋的分頁對應純邏輯（見 admin-search-context.js 開頭說明）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchContextFor } from "../../public/admin-search-context.js";

test("searchContextFor：orders 對應訂單搜尋欄位與文案", () => {
  assert.deepEqual(searchContextFor("orders"), {
    input: "#admin-order-search",
    label: "搜尋訂單",
    placeholder: "搜尋訂單編號、姓名、手機、末五碼"
  });
});

test("searchContextFor：products 對應商品搜尋欄位與文案", () => {
  assert.deepEqual(searchContextFor("products"), {
    input: "#admin-product-search",
    label: "搜尋商品",
    placeholder: "搜尋商品名稱、分類、規格或 SKU"
  });
});

test("searchContextFor：members 對應會員搜尋欄位與文案", () => {
  assert.deepEqual(searchContextFor("members"), {
    input: "#admin-member-search",
    label: "搜尋會員",
    placeholder: "搜尋會員姓名或手機"
  });
});

test("searchContextFor：沒有自己搜尋欄位的分頁 fallback 回訂單搜尋文案，且沒有來源欄位", () => {
  for (const tab of ["overview", "inventory", "discounts", "accounts", "audit", "notifications", "unknown-tab"]) {
    assert.deepEqual(searchContextFor(tab), {
      input: null,
      label: "搜尋訂單",
      placeholder: "搜尋訂單編號、姓名、手機、末五碼"
    });
  }
});
