// 現貨宅配「小幫手確認運費後才匯款」：待付款可儲存運費但不可確認入帳、運費確認通知與建單通知文案、
// 預購宅配到貨文案。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const messages = await loadSourceModule("line-notification-messages.ts");
const ADMIN_ID = "00000000-0000-4000-8000-0000000000d1";
const LINE_ID = "U" + "f".repeat(32);
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000d3";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeAdmin(order) {
  const calls = [];
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname.startsWith("/rest/v1/rpc/")) { calls.push([url.pathname.slice(13), body]); return jsonResponse({ id: ORDER_ID }); }
    if (url.pathname === "/rest/v1/orders") return jsonResponse([order]);
    return jsonResponse([]);
  });
  return calls;
}
const saveFee = (body) => worker.fetch(new Request(`https://shop.test/api/admin/orders/${ORDER_ID}/fulfillment`, {
  method: "PATCH", headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, ctx());

// 儲存後的運費通知在 waitUntil 讀同一筆訂單，所以假資料要有金額欄位
const unpaidStockHome = {
  id: ORDER_ID, order_number: "CJ-1", status: "pending_payment", delivery_method: "home_delivery", bank_account_id: null,
  subtotal: 1000, coupon_discount: 0, point_discount: 0, shipping_fee: 0, amount_due: 1000, deposit_due: 1000, paid_amount: 0,
  payment_deadline: "2026-10-13T10:43:00Z", order_items: [{ kind: "in_stock" }]
};

test("an unpaid in-stock home order accepts a shipping fee", async () => {
  const calls = fakeAdmin(unpaidStockHome);
  const response = await saveFee({ shipping_fee: 150 });
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], "admin_update_order_fulfillment");
  assert.equal(calls[0][1].p_shipping_fee, 150);
  assert.equal(calls[0][1].p_final_payment_confirmed, false);
});

test("an unpaid in-stock home order cannot be marked as fully paid", async () => {
  const calls = fakeAdmin(unpaidStockHome);
  const response = await saveFee({ shipping_fee: 150, final_payment_confirmed: true, final_payment_last_five: "54321" });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("an unpaid preorder home order still waits for arrival", async () => {
  const calls = fakeAdmin({ ...unpaidStockHome, order_items: [{ kind: "preorder" }] });
  const response = await saveFee({ shipping_fee: 150 });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

const homeBase = {
  storeName: "潮吉好頑", orderNumber: "CJ-261012-184352-DBED", items: "30周年(日版原膜盒) ×1",
  deliveryLine: "宅配", paymentLine: "匯款／轉帳", hasPreorder: false, amountDue: 6650, depositDue: 6650, paidAmount: 0,
  shippingFee: 150, productAmount: 6500, finalPaymentConfirmed: false, statusLabel: "", paymentDeadline: "2026年10月13日 下午6:43"
};

test("saving the fee on an unpaid in-stock home order notifies the amounts and deadline", () => {
  const text = messages.buildOrderNotificationMessage({ ...homeBase, eventType: "fulfillment_updated", orderStatus: "pending_payment" });
  assert.equal(text, [
    "【潮吉好頑選物】", "訂單編號：CJ-261012-184352-DBED", "訂單狀態：待確認付款", "",
    "商品：30周年(日版原膜盒) ×1", "商品金額：NT$6,500", "運費：NT$150", "總金額：NT$6,650", "付款方式：匯款／轉帳",
    "付款期限：2026年10月13日 下午6:43"
  ].join("\n"));
  const card = JSON.stringify(messages.buildLineOrderFlexMessage({ ...homeBase, eventType: "fulfillment_updated", orderStatus: "pending_payment" }, text, "https://liff.line.me/orders"));
  assert.match(card, /運費已確認，請完成匯款/);
  assert.match(card, /查看訂單/);
});

test("a zero fee is shown as free shipping", () => {
  const text = messages.buildOrderNotificationMessage({ ...homeBase, shippingFee: 0, amountDue: 6500, depositDue: 6500, eventType: "fulfillment_updated", orderStatus: "pending_payment" });
  assert.match(text, /運費：免運/);
  assert.match(text, /總金額：NT\$6,500/);
});

test("fee updates after payment do not notify again", () => {
  assert.equal(messages.buildOrderNotificationMessage({ ...homeBase, eventType: "fulfillment_updated", orderStatus: "pending_review" }), null);
  assert.equal(messages.buildOrderNotificationMessage({ ...homeBase, eventType: "fulfillment_updated", orderStatus: "confirmed" }), null);
});

test("the creation notice for in-stock home delivery tells the member to wait for the fee", () => {
  const data = { ...homeBase, shippingFee: 0, amountDue: 6500, depositDue: 6500, eventType: "created", orderStatus: "pending_payment" };
  const text = messages.buildOrderNotificationMessage(data);
  assert.match(text, /運費：待小幫手確認運費/);
  assert.doesNotMatch(text, /私訊/);
  const card = JSON.stringify(messages.buildLineOrderFlexMessage(data, text, null));
  assert.match(card, /請先不要匯款/);
});

test("preorder home arrival waits for the helper instead of asking the member to message", () => {
  const text = messages.buildOrderNotificationMessage({ ...homeBase, hasPreorder: true, eventType: "status_changed", orderStatus: "ready_for_pickup" });
  assert.match(text, /商品已到貨，待小幫手確認尾款及運費後通知/);
});
