import test from "node:test";
import assert from "node:assert/strict";
import { BATCH_LIMIT, batchSelectionError, canBatchComplete, completionBatchConfirmation, outstandingBalance, publishBatchConfirmation, summarizeBatchResults } from "../../public/admin-batch.js";

const order = (overrides = {}) => ({ order_number: "CJ-1", status: "confirmed", delivery_method: "store_pickup", amount_due: 3000, paid_amount: 1500, order_items: [{ kind: "preorder" }], ...overrides });

test("選取數量：0 筆與超過上限都被拒絕", () => {
  assert.equal(BATCH_LIMIT, 10);
  assert.match(batchSelectionError(0), /請先勾選/);
  assert.match(batchSelectionError(11), /最多處理 10 筆/);
  assert.equal(batchSelectionError(10), "");
});

test("可批次完成：到店取貨的已確認／配送處理中訂單", () => {
  assert.equal(canBatchComplete(order()), true);
  assert.equal(canBatchComplete(order({ status: "ready_for_pickup" })), true);
});

test("不可批次完成：待確認款項、退款中、已完成", () => {
  assert.equal(canBatchComplete(order({ status: "pending_review" })), false);
  assert.equal(canBatchComplete(order({ status: "refund_pending" })), false);
  assert.equal(canBatchComplete(order({ status: "completed" })), false);
});

test("宅配訂單沒有尾款確認時不可批次完成，確認後可以", () => {
  const home = order({ delivery_method: "home_delivery", status: "ready_for_pickup" });
  assert.equal(canBatchComplete(home), false);
  assert.equal(canBatchComplete({ ...home, final_payment_confirmed_at: "2026-09-28T00:00:00Z" }), true);
});

test("待收尾款不會是負數", () => {
  assert.equal(outstandingBalance(order()), 1500);
  assert.equal(outstandingBalance(order({ paid_amount: 5000 })), 0);
});

test("批次完成確認：逐筆列出尾款並加總，提示視為已收", () => {
  const result = completionBatchConfirmation([order(), order({ order_number: "CJ-2", paid_amount: 3000 })], (item) => (item.order_number === "CJ-1" ? "建育" : ""));
  assert.equal(result.title, "完成 2 筆訂單？");
  assert.deepEqual(result.details, [["CJ-1・建育", "待收尾款 NT$1,500"], ["CJ-2・未填姓名", "已收齊"], ["待收尾款合計", "NT$1,500"]]);
  assert.equal(result.totalBalance, 1500);
  assert.match(result.message.join(""), /1 筆仍有待收尾款，合計 NT\$1,500/);
});

test("批次完成確認：含不可完成的訂單時拒絕並列出編號", () => {
  assert.throws(() => completionBatchConfirmation([order(), order({ order_number: "CJ-9", status: "pending_review" })]), /CJ-9 目前不能直接完成/);
  assert.throws(() => completionBatchConfirmation([]), /請先勾選/);
});

test("批次上架：提示商品本身未上架的規格；下架標示為危險", () => {
  const items = [{ productName: "A", variantName: "紅", productPublished: true }, { productName: "B", variantName: "藍", productPublished: false }];
  const up = publishBatchConfirmation(items, true);
  assert.equal(up.title, "上架 2 個規格？");
  assert.match(up.message.join(""), /1 個規格所屬商品尚未上架/);
  assert.equal(up.danger, false);
  const down = publishBatchConfirmation(items, false);
  assert.equal(down.danger, true);
  assert.equal(down.message.length, 1);
});

test("結果彙整：部分失敗列出原因", () => {
  const summary = summarizeBatchResults([{ label: "CJ-1", ok: true }, { label: "CJ-2", ok: false, error: "尾款尚未確認" }]);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.allOk, false);
  assert.equal(summary.message, "完成 1 筆，1 筆失敗：CJ-2（尾款尚未確認）");
  assert.equal(summarizeBatchResults([{ label: "CJ-1", ok: true }]).message, "已完成 1 筆");
});
