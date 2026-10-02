import test from "node:test";
import assert from "node:assert/strict";
import { isDangerousTarget, parseRefundAmount, refundFieldFor, riskOnlyEntryLabel, transitionConfirmation, transitionSubmitLabel } from "../../public/admin-order-transition.js";

const order = { order_number: "CJ-1", status: "completed", amount_due: 3299, paid_amount: 3299 };

test("取消與退款相關狀態視為高風險", () => {
  assert.deepEqual(["cancelled", "refund_pending", "refunded", "completed", "confirmed"].map(isDangerousTarget), [true, true, true, false, false]);
});

test("未選擇下一步時按鈕不給動作；選擇後直接寫出動作名稱", () => {
  assert.equal(transitionSubmitLabel("", "進入退款處理"), "請先選擇下一步");
  assert.equal(transitionSubmitLabel("refund_pending", "進入退款處理"), "進入退款處理");
});

test("只剩退款時收成「申請退款…」次要入口", () => {
  assert.equal(riskOnlyEntryLabel([{ value: "refund_pending" }]), "申請退款…");
});

test("只剩取消時收成「取消訂單…」；退款與取消並存時合併文字", () => {
  assert.equal(riskOnlyEntryLabel([{ value: "cancelled" }]), "取消訂單…");
  assert.equal(riskOnlyEntryLabel([{ value: "refund_pending" }, { value: "cancelled" }]), "退款或取消訂單…");
});

test("有一般動作時不收合", () => {
  assert.equal(riskOnlyEntryLabel([{ value: "completed" }, { value: "refund_pending" }]), null);
  assert.equal(riskOnlyEntryLabel([]), null);
});

test("退款確認視窗寫出動作、已收金額與原因，並標示為危險", () => {
  const result = transitionConfirmation(order, { targetStatus: "refund_pending", optionLabel: "進入退款處理", memberName: "建育", note: "商品瑕疵" });
  assert.equal(result.title, "進入退款處理？");
  assert.equal(result.confirmLabel, "進入退款處理");
  assert.equal(result.danger, true);
  assert.deepEqual(result.details, [["訂單", "CJ-1"], ["會員", "建育"], ["已收金額", "NT$3,299"], ["原因", "商品瑕疵"]]);
  assert.match(result.message, /不會自動回補庫存/);
});

test("一般狀態更新顯示訂單總額，不列原因也不標示危險", () => {
  const result = transitionConfirmation({ ...order, status: "ready_for_pickup" }, { targetStatus: "completed", optionLabel: "完成取貨並確認尾款", note: "備註" });
  assert.equal(result.danger, false);
  assert.deepEqual(result.details, [["訂單", "CJ-1"], ["會員", "未填姓名"], ["訂單總額", "NT$3,299"]]);
});

test("退款金額欄位：取消已付款訂單與確認已退款才顯示，預填已收金額、上限為總額加運費", () => {
  assert.deepEqual(refundFieldFor({ status: "confirmed", amount_due: 1200, shipping_fee: 100, paid_amount: 600 }, "cancelled"), { defaultAmount: 600, max: 1300 });
  assert.deepEqual(refundFieldFor({ status: "refund_pending", amount_due: 3299, shipping_fee: 0, paid_amount: 3299 }, "refunded"), { defaultAmount: 3299, max: 3299 });
  assert.equal(refundFieldFor({ status: "pending_payment", amount_due: 1200, paid_amount: 0 }, "cancelled"), null);
  assert.equal(refundFieldFor({ status: "confirmed", amount_due: 1200, paid_amount: 1200 }, "refund_pending"), null);
  assert.equal(refundFieldFor({ status: "confirmed", amount_due: 1200, paid_amount: 1200 }, "ready_for_pickup"), null);
});

test("退款金額檢查：必填 0 或正整數且不超過上限，錯誤會指到退款欄位", () => {
  assert.equal(parseRefundAmount("0", 1000), 0);
  assert.equal(parseRefundAmount(" 1000 ", 1000), 1000);
  for (const bad of ["", "-1", "10.5", "abc"]) assert.throws(() => parseRefundAmount(bad, 1000), (error) => error.field === "refund_amount", bad);
  assert.throws(() => parseRefundAmount("1001", 1000), /不可超過 NT\$1,000/);
});

test("確認視窗列出退款金額", () => {
  const { details } = transitionConfirmation({ order_number: "CJ-2", status: "confirmed", amount_due: 1200 }, { targetStatus: "cancelled", optionLabel: "取消訂單", note: "客人取消", refundAmount: 1200 });
  assert.deepEqual(details.find(([label]) => label === "退款金額"), ["退款金額", "NT$1,200"]);
});
