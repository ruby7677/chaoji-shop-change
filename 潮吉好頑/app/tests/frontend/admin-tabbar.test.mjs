import test from "node:test";
import assert from "node:assert/strict";
import { tabbarActiveKey } from "../../public/admin-tabbar.js";

test("主要分頁在底部分頁列直接顯示為使用中", () => {
  assert.deepEqual(["overview", "orders", "products"].map(tabbarActiveKey), ["overview", "orders", "products"]);
});

test("抽屜內的次要分頁由「更多」顯示為使用中", () => {
  assert.deepEqual(["inventory", "members", "discounts", "accounts", "audit", "notifications"].map(tabbarActiveKey), Array(6).fill("more"));
});
