// 結帳摘要的本次累積點數：與完成訂單時入點 trigger 相同（可積點商品 − 優惠券 − 點數折抵，每滿門檻 1 點，不含運費）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateEarnedPoints } from "../../public/checkout-earned-points.js";

const items = [{ price: 6500, quantity: 1 }];

test("points are earned on the discounted item total", () => {
  assert.equal(estimateEarnedPoints({ items, couponDiscount: 0, pointDiscount: 65, earnAmountPerPoint: 100 }), 64);
});

test("coupon and point discounts are both subtracted", () => {
  assert.equal(estimateEarnedPoints({ items, couponDiscount: 500, pointDiscount: 0, earnAmountPerPoint: 100 }), 60);
});

test("items excluded from points do not count", () => {
  const mixed = [{ price: 1000, quantity: 2 }, { price: 3000, quantity: 1, points_eligible: false }];
  assert.equal(estimateEarnedPoints({ items: mixed, earnAmountPerPoint: 100 }), 20);
});

test("no points when the earning rule is missing or discounts exceed the total", () => {
  assert.equal(estimateEarnedPoints({ items, earnAmountPerPoint: 0 }), 0);
  assert.equal(estimateEarnedPoints({ items, earnAmountPerPoint: undefined }), 0);
  assert.equal(estimateEarnedPoints({ items, couponDiscount: 7000, earnAmountPerPoint: 100 }), 0);
});
