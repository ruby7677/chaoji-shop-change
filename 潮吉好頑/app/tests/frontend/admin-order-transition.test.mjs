import test from "node:test";
import assert from "node:assert/strict";
import { availableTransitions, isDangerousTarget, parseRefundAmount, refundFieldFor, riskOnlyEntryLabel, transitionConfirmation, transitionSubmitLabel } from "../../public/admin-order-transition.js";

const order = { order_number: "CJ-1", status: "completed", amount_due: 3299, paid_amount: 3299 };

test("只有取消視為高風險（退款流程已移除）", () => {
  assert.deepEqual(["cancelled", "refund_pending", "refunded", "completed", "confirmed"].map(isDangerousTarget), [true, false, false, false, false]);
});

test("任何狀態都不再提供退款處理或確認已退款", () => {
  for (const status of ["pending_payment", "pending_review", "confirmed", "partially_ready", "ready_for_pickup", "completed"]) {
    const values = availableTransitions({ status, delivery_method: "store_pickup", pickup_plan: "split", bank_account_id: "bank", order_items: [{ kind: "preorder" }], final_payment_confirmed_at: "x" }).map((item) => item.value);
    assert.ok(!values.includes("refund_pending") && !values.includes("refunded"), status);
  }
  assert.deepEqual(availableTransitions({ status: "completed" }), []);
});

test("未選擇下一步時按鈕不給動作；選擇後直接寫出動作名稱", () => {
  assert.equal(transitionSubmitLabel("", "取消訂單"), "請先選擇下一步");
  assert.equal(transitionSubmitLabel("cancelled", "取消訂單"), "取消訂單");
});

test("只剩取消時收成「取消訂單…」次要入口", () => {
  assert.equal(riskOnlyEntryLabel([{ value: "cancelled" }]), "取消訂單…");
});

test("有一般動作時不收合", () => {
  assert.equal(riskOnlyEntryLabel([{ value: "completed" }, { value: "cancelled" }]), null);
  assert.equal(riskOnlyEntryLabel([]), null);
});

test("取消確認視窗寫出動作、總額、退款金額與原因，並標示為危險", () => {
  const result = transitionConfirmation({ ...order, status: "confirmed" }, { targetStatus: "cancelled", optionLabel: "取消訂單", memberName: "建育", note: "商品瑕疵", refundAmount: 3299 });
  assert.equal(result.title, "取消訂單？");
  assert.equal(result.danger, true);
  assert.deepEqual(result.details, [["訂單", "CJ-1"], ["會員", "建育"], ["訂單總額", "NT$3,299"], ["退款金額", "NT$3,299"], ["原因", "商品瑕疵"]]);
  assert.match(result.message, /反轉原銷售異動/);
});

test("一般狀態更新顯示訂單總額，不列原因也不標示危險", () => {
  const result = transitionConfirmation({ ...order, status: "ready_for_pickup" }, { targetStatus: "completed", optionLabel: "完成取貨並確認尾款", note: "備註" });
  assert.equal(result.danger, false);
  assert.deepEqual(result.details, [["訂單", "CJ-1"], ["會員", "未填姓名"], ["訂單總額", "NT$3,299"]]);
});

test("退款金額欄位：只有取消已付款／已回報訂單才顯示，預填已收金額、上限為總額加運費", () => {
  assert.deepEqual(refundFieldFor({ status: "confirmed", amount_due: 1200, shipping_fee: 100, paid_amount: 600 }, "cancelled"), { defaultAmount: 600, max: 1300 });
  assert.equal(refundFieldFor({ status: "refund_pending", amount_due: 3299, shipping_fee: 0, paid_amount: 3299 }, "refunded"), null);
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
