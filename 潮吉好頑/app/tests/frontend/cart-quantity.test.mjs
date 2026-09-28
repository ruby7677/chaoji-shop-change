import test from "node:test";
import assert from "node:assert/strict";
import { planBuyNowQuantity, variantMaxQuantity } from "../../public/cart-quantity.js";

test("可購買上限取庫存與限購的較小值", () => {
  assert.equal(variantMaxQuantity({ stock: 8, purchase_limit: 2 }), 2);
  assert.equal(variantMaxQuantity({ stock: 3, purchase_limit: 5 }), 3);
  assert.equal(variantMaxQuantity({ stock: 4, purchase_limit: null }), 4);
  assert.equal(variantMaxQuantity({ stock: -1 }), 0);
});

test("直接購買：購物車沒有這個規格時加入所選數量", () => {
  assert.deepEqual(planBuyNowQuantity({ existingQuantity: 0, requested: 2, max: 5 }), { ok: true, quantity: 2, changed: true, message: "" });
});

test("直接購買：已在購物車時改成所選數量，不累加", () => {
  assert.deepEqual(planBuyNowQuantity({ existingQuantity: 3, requested: 1, max: 5 }), { ok: true, quantity: 1, changed: true, message: "購物車數量已改為 1 件" });
});

test("直接購買：數量相同時不變動購物車", () => {
  assert.equal(planBuyNowQuantity({ existingQuantity: 2, requested: 2, max: 5 }).changed, false);
});

test("直接購買：超過上限、非整數或無庫存時拒絕", () => {
  assert.equal(planBuyNowQuantity({ requested: 6, max: 5 }).ok, false);
  assert.equal(planBuyNowQuantity({ requested: 1.5, max: 5 }).ok, false);
  assert.equal(planBuyNowQuantity({ requested: 1, max: 0 }).message, "數量需介於 1 至 1 件");
});
