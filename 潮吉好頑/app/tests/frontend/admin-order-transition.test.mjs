import test from "node:test";
import assert from "node:assert/strict";
import { isDangerousTarget, riskOnlyEntryLabel, transitionConfirmation, transitionSubmitLabel } from "../../public/admin-order-transition.js";

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
