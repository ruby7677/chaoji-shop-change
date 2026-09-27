// 一鍵確認款項相關純函式：確認金額、可否一鍵確認、確認框內容與金額摘要文字。
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmationAmount, isQuickConfirmable, moneySummary, paymentConfirmation } from "../../public/admin-order-payment.js";

test("confirmationAmount 認列訂金，尾款已確認後改認列全額", () => {
  assert.equal(confirmationAmount({ deposit_due: 500, amount_due: 1000, final_payment_confirmed_at: null }), 500);
  assert.equal(confirmationAmount({ deposit_due: 500, amount_due: 1000, final_payment_confirmed_at: "2026-09-01T00:00:00Z" }), 1000);
});

test("isQuickConfirmable：pending_review 訂單第一步就是確認款項", () => {
  const transitions = [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }];
  assert.equal(isQuickConfirmable({ status: "pending_review" }, transitions), true);
});

test("isQuickConfirmable：待付款的匯款訂單第一步是取消，不可一鍵確認", () => {
  const transitions = [{ value: "cancelled", label: "取消未付款訂單" }];
  assert.equal(isQuickConfirmable({ status: "pending_payment", bank_account_id: "acc-1" }, transitions), false);
});

test("isQuickConfirmable：賣貨便待付款（無指定帳戶）第一步是確認訂單", () => {
  const transitions = [{ value: "confirmed", label: "確認賣貨便訂單並扣除庫存" }, { value: "cancelled", label: "取消未付款訂單" }];
  assert.equal(isQuickConfirmable({ status: "pending_payment", delivery_method: "seller_delivery", bank_account_id: null }, transitions), true);
});

test("isQuickConfirmable：已確認訂單的下一步不是 confirmed，不可一鍵確認", () => {
  const transitions = [{ value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "refund_pending", label: "進入退款處理" }];
  assert.equal(isQuickConfirmable({ status: "confirmed" }, transitions), false);
});

test("paymentConfirmation：匯款訂單有末五碼時列出訂單、會員、應收、末五碼與帳戶", () => {
  const order = {
    order_number: "CJ20260101001",
    deposit_due: 500,
    amount_due: 1000,
    final_payment_confirmed_at: null,
    bank_account_id: "acc-1",
    payment_last_five: "12345",
    delivery_method: "store_pickup",
    shipping_fee: 0,
    profiles: { full_name: "王小明" },
    bank_accounts: { label: "國泰世華", bank_name: "國泰世華銀行" }
  };
  const result = paymentConfirmation(order);
  assert.equal(result.title, "確認收到 NT$500？");
  assert.equal(result.confirmLabel, "確認收到款項");
  assert.deepEqual(result.details, [
    ["訂單", "CJ20260101001"],
    ["會員", "王小明"],
    ["本次應收", "NT$500"],
    ["匯款末五碼", "12345"],
    ["收款帳戶", "國泰世華"]
  ]);
  assert.deepEqual(result.warnings, ["確認款項後會正式扣除商品庫存。"]);
});

test("paymentConfirmation：匯款訂單尚未回報末五碼時附加提醒警語", () => {
  const order = { order_number: "CJ1", deposit_due: 300, amount_due: 600, bank_account_id: "acc-1", payment_last_five: null, delivery_method: "store_pickup", profiles: null, bank_accounts: null };
  const result = paymentConfirmation(order);
  assert.equal(result.details.find(([label]) => label === "匯款末五碼")[1], "尚未回報");
  assert.equal(result.details.find(([label]) => label === "會員")[1], "未填姓名");
  assert.equal(result.details.find(([label]) => label === "收款帳戶")[1], "未指定帳戶");
  assert.ok(result.warnings.includes("會員尚未回報匯款末五碼，請先核對帳戶入帳紀錄。"));
});

test("paymentConfirmation：賣貨便外部訂單（無指定帳戶）顯示訂單、會員與訂單總額，不顯示匯款欄位", () => {
  const order = { order_number: "CJ2", deposit_due: 400, amount_due: 800, bank_account_id: null, delivery_method: "seller_delivery", payment_last_five: null, profiles: { full_name: "王小明" } };
  const result = paymentConfirmation(order);
  assert.equal(result.title, "確認賣貨便訂單？");
  assert.equal(result.confirmLabel, "確認賣貨便訂單");
  assert.deepEqual(result.details.map(([label]) => label), ["訂單", "會員", "訂單總額"]);
  assert.equal(result.details[1][1], "王小明");
  assert.deepEqual(result.warnings, ["確認款項後會正式扣除商品庫存。"]);
});

test("paymentConfirmation：宅配訂單尚未填寫實際運費時附加提醒警語", () => {
  const order = { order_number: "CJ3", deposit_due: 400, amount_due: 800, bank_account_id: "acc-1", payment_last_five: "99999", delivery_method: "home_delivery", shipping_fee: 0, profiles: { full_name: "陳小華" }, bank_accounts: { bank_name: "台灣銀行" } };
  const result = paymentConfirmation(order);
  assert.ok(result.warnings.includes("宅配尚未填寫實際運費。"));
});

test("paymentConfirmation：宅配已填寫實際運費時不附加運費提醒", () => {
  const order = { order_number: "CJ4", deposit_due: 400, amount_due: 800, bank_account_id: "acc-1", payment_last_five: "99999", delivery_method: "home_delivery", shipping_fee: 120, profiles: { full_name: "陳小華" }, bank_accounts: { bank_name: "台灣銀行" } };
  const result = paymentConfirmation(order);
  assert.equal(result.warnings.includes("宅配尚未填寫實際運費。"), false);
});

test("paymentConfirmation：profiles／bank_accounts 為單一元素陣列時等同物件", () => {
  const order = {
    order_number: "CJ5",
    deposit_due: 500,
    amount_due: 1000,
    bank_account_id: "acc-1",
    payment_last_five: "54321",
    delivery_method: "store_pickup",
    profiles: [{ full_name: "林小美" }],
    bank_accounts: [{ label: "郵局", bank_name: "中華郵政" }]
  };
  const result = paymentConfirmation(order);
  assert.equal(result.details.find(([label]) => label === "會員")[1], "林小美");
  assert.equal(result.details.find(([label]) => label === "收款帳戶")[1], "郵局");
});

test("moneySummary：組出總額／已收／待收文字，待收不為負數", () => {
  assert.equal(moneySummary({ amount_due: 1000, paid_amount: 300 }), "總額 NT$1,000 · 已收 NT$300 · 待收 NT$700");
  assert.equal(moneySummary({ amount_due: 1000, paid_amount: 1000 }), "總額 NT$1,000 · 已收 NT$1,000 · 待收 NT$0");
  assert.equal(moneySummary({ amount_due: 500, paid_amount: 800 }), "總額 NT$500 · 已收 NT$800 · 待收 NT$0");
});
