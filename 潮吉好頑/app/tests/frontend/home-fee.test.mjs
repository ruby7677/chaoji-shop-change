// 現貨宅配「待小幫手確認運費」：運費確認前不給匯款帳號、不能回報末五碼；確認後顯示含運應付與匯款按鈕。
import test from "node:test";
import assert from "node:assert/strict";
import { awaitingStockHomeFee, homeFeeConfirmed } from "../../public/home-fee-state.js";
import { orderCardMarkup, paymentOrderView } from "../../public/order-views.js";

const account = { bank_name: "台北富邦(012)", account_name: "曾**", account_number: "81680005517989" };
const unpaid = {
  id: "order-1", order_number: "CJ-261012-184352-DBED", created_at: "2026-10-12T10:43:00Z", status: "pending_payment",
  delivery_method: "home_delivery", bank_account_id: "bank-1", bank_accounts: account, subtotal: 6500, coupon_discount: 0, point_discount: 0,
  shipping_fee: 0, shipping_fee_notified_at: null, amount_due: 6500, deposit_due: 6500, payment_deadline: "2099-10-13T10:43:00Z",
  order_items: [{ product_name: "30周年(日版原膜盒)", variant_name: "單一規格", quantity: 1, kind: "in_stock" }]
};
const feeConfirmed = { ...unpaid, shipping_fee: 150, shipping_fee_notified_at: "2026-10-12T11:00:00Z", amount_due: 6650, deposit_due: 6650 };

test("運費確認狀態：0 元免運只要有確認時間也算已確認；預購不適用", () => {
  assert.equal(awaitingStockHomeFee(unpaid, false), true);
  assert.equal(awaitingStockHomeFee(feeConfirmed, false), false);
  assert.equal(homeFeeConfirmed({ shipping_fee: 0, shipping_fee_notified_at: "2026-10-12T11:00:00Z" }), true);
  assert.equal(awaitingStockHomeFee(unpaid, true), false);
  assert.equal(awaitingStockHomeFee({ ...unpaid, status: "pending_review" }, false), false);
});

test("建單後運費未確認：不顯示匯款帳號，改成等待提醒與查看訂單模式", () => {
  const { html, mode } = paymentOrderView(unpaid);
  assert.equal(mode, "awaiting_fee");
  assert.doesNotMatch(html, /81680005517989/);
  assert.match(html, /待小幫手確認運費後以 LINE 通知，商品＋運費再一併匯款/);
  assert.doesNotMatch(html, /私訊/);
});

test("運費確認後：付款明細顯示含運應付與匯款帳號", () => {
  const { html, mode } = paymentOrderView(feeConfirmed);
  assert.equal(mode, "transfer");
  assert.match(html, /81680005517989/);
  assert.match(html, /NT\$6,650/);
  assert.match(html, /運費 NT\$150 已確認/);
});

test("我的訂單：運費確認前沒有回報按鈕，確認後依序顯示總額、尾款／運費、本次應付", () => {
  const before = orderCardMarkup(unpaid);
  assert.doesNotMatch(before, /data-order-payment/);
  assert.match(before, /待小幫手確認運費/);
  assert.doesNotMatch(before, /私訊/);
  const after = orderCardMarkup(feeConfirmed);
  assert.match(after, /data-order-payment="order-1">查看匯款帳號並回報末五碼/);
  const total = after.indexOf("訂單總額");
  const fee = after.indexOf("尾款／運費");
  const due = after.indexOf("本次應付");
  assert.ok(total < fee && fee < due, "rows follow total → fee → amount due");
  assert.match(after, /尾款／運費<\/span><strong>NT\$150/);
});

test("預購宅配到貨、尾款與運費已確認：可查看尾款匯款帳號，末五碼回覆給小幫手", () => {
  const arrived = { ...unpaid, status: "ready_for_pickup", shipping_fee: 150, shipping_fee_notified_at: "2026-10-12T11:00:00Z", amount_due: 6650, deposit_due: 3250, order_items: [{ ...unpaid.order_items[0], kind: "preorder" }] };
  const { html, mode } = paymentOrderView(arrived);
  assert.equal(mode, "balance");
  assert.match(html, /待付尾款（含運費）<\/span><strong>NT\$3,400/);
  assert.match(html, /81680005517989/);
  assert.match(orderCardMarkup(arrived), /data-order-payment="order-1">查看尾款匯款帳號/);
  assert.doesNotMatch(orderCardMarkup({ ...arrived, final_payment_confirmed_at: "2026-10-13T00:00:00Z" }), /data-order-payment/);
});