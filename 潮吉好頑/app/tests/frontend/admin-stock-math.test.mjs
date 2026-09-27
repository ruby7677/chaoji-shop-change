// 庫存調整純計算：入庫／扣除的數量與錯誤訊息、異動歷史關鍵字篩選。
import { test } from "node:test";
import assert from "node:assert/strict";
import { movementMatches, stockAdjustment } from "../../public/admin-stock-math.js";

test("stockAdjustment：入庫回傳正的 delta 與加總後的庫存", () => {
  const result = stockAdjustment({ current: 20, direction: "in", quantity: 12 });
  assert.deepEqual(result, { delta: 12, next: 32, error: null });
});

test("stockAdjustment：扣除回傳負的 delta 與扣除後的庫存", () => {
  const result = stockAdjustment({ current: 20, direction: "out", quantity: 5 });
  assert.deepEqual(result, { delta: -5, next: 15, error: null });
});

test("stockAdjustment：扣除超過現有庫存時回傳不可小於 0 的錯誤，並附上目前庫存", () => {
  const result = stockAdjustment({ current: 8, direction: "out", quantity: 9 });
  assert.equal(result.error, "扣除後庫存不可小於 0（目前 8 件）");
  assert.equal(result.next, -1);
});

test("stockAdjustment：扣除剛好等於現有庫存時允許（結果為 0）", () => {
  const result = stockAdjustment({ current: 8, direction: "out", quantity: 8 });
  assert.deepEqual(result, { delta: -8, next: 0, error: null });
});

test("stockAdjustment：數量為 0 時回傳需為正整數的錯誤", () => {
  const result = stockAdjustment({ current: 20, direction: "in", quantity: 0 });
  assert.equal(result.error, "請輸入大於 0 的整數數量");
});

test("stockAdjustment：數量為負數時回傳需為正整數的錯誤", () => {
  const result = stockAdjustment({ current: 20, direction: "in", quantity: -10 });
  assert.equal(result.error, "請輸入大於 0 的整數數量");
});

test("stockAdjustment：數量非整數時回傳需為正整數的錯誤", () => {
  const result = stockAdjustment({ current: 20, direction: "in", quantity: 1.5 });
  assert.equal(result.error, "請輸入大於 0 的整數數量");
});

test("stockAdjustment：數量為空字串或非數字時回傳需為正整數的錯誤", () => {
  assert.equal(stockAdjustment({ current: 20, direction: "in", quantity: "" }).error, "請輸入大於 0 的整數數量");
  assert.equal(stockAdjustment({ current: 20, direction: "in", quantity: "abc" }).error, "請輸入大於 0 的整數數量");
});

test("stockAdjustment：方向不是 in／out 時回傳選擇方向的錯誤", () => {
  const result = stockAdjustment({ current: 20, direction: "sideways", quantity: 5 });
  assert.equal(result.error, "請選擇入庫或扣除");
});

test("movementMatches：關鍵字為空字串時全部符合", () => {
  assert.equal(movementMatches({ reason: "到貨入庫" }, "", "商品A", "規格A SKU-A"), true);
  assert.equal(movementMatches({ reason: "到貨入庫" }, "   ", "商品A", "規格A SKU-A"), true);
});

test("movementMatches：比對商品名稱，不分大小寫", () => {
  assert.equal(movementMatches({ reason: "盤點修正" }, "商品a", "商品A", "規格A"), true);
});

test("movementMatches：比對規格名稱與 SKU（同一參數傳入）", () => {
  assert.equal(movementMatches({ reason: "盤點修正" }, "sku-99", "商品A", "規格A SKU-99"), true);
  assert.equal(movementMatches({ reason: "盤點修正" }, "規格a", "商品A", "規格A SKU-99"), true);
});

test("movementMatches：比對異動原因", () => {
  assert.equal(movementMatches({ reason: "損壞報廢" }, "報廢", "商品A", "規格A SKU-1"), true);
});

test("movementMatches：關鍵字都不符合時回傳 false", () => {
  assert.equal(movementMatches({ reason: "到貨入庫" }, "找不到", "商品A", "規格A SKU-1"), false);
});
