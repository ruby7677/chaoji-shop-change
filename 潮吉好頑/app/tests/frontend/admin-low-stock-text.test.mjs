// 低庫存清單文字：庫存歸零標「已售完」，其餘顯示庫存與安全庫存。
import test from "node:test";
import assert from "node:assert/strict";
import { stockStateText } from "../../public/admin-stock-state.js";

test("庫存為 0 或負數時顯示已售完", () => {
  assert.equal(stockStateText({ stock_on_hand: 0, safety_stock: 0 }), "已售完（安全庫存 0）");
  assert.equal(stockStateText({ stock_on_hand: -1, safety_stock: 2 }), "已售完（安全庫存 2）");
});

test("仍有庫存時顯示庫存與安全庫存", () => {
  assert.equal(stockStateText({ stock_on_hand: 1, safety_stock: 3 }), "庫存 1／安全庫存 3");
});
