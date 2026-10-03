// 取消／退款／確認付款通知帶出金額：狀態文字（LINE 與 Telegram 共用）、取消與退款改紅色、預購確認訂金時列出待付尾款；
// 後台取消 API 的退款金額格式檢查與轉送（admin-orders.ts）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const notifications = await loadSourceModule("notifications.ts");
const messages = await loadSourceModule("line-notification-messages.ts");
const worker = await loadWorker();

let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("status labels carry the refunded or confirmed amount", () => {
  assert.equal(notifications.orderStatusLabel("cancelled", 1180), "已取消訂單，並已退款 NT$1,180");
  assert.equal(notifications.orderStatusLabel("cancelled", 0), "已取消訂單");
  assert.equal(notifications.orderStatusLabel("cancelled", null), "已取消訂單");
  assert.equal(notifications.orderStatusLabel("confirmed", null, 600), "已確認付款 NT$600");
  assert.equal(notifications.orderStatusLabel("confirmed", null, 0), "已確認付款");
  assert.equal(notifications.orderStatusLabel("completed", 500, 1000), "已完成訂單");
});

const base = {
  storeName: "潮吉好頑", eventType: "status_changed", orderNumber: "CJ-261001-184719-F475", items: "BX35-抽抽包 ×1",
  deliveryLine: "到店取貨", paymentLine: "匯款／轉帳", hasPreorder: false, amountDue: 1200, depositDue: 1200, paidAmount: 1200,
  shippingFee: 0, finalPaymentConfirmed: false
};
const flexTexts = (data) => JSON.stringify(messages.buildLineOrderFlexMessage(data, "alt"));
const statusNode = (data) => {
  const body = messages.buildLineOrderFlexMessage(data, "alt").contents.body.contents;
  return body.find((node) => node.text === data.statusLabel);
};

test("cancelled cards use red status text, others stay LINE green", () => {
  assert.equal(statusNode({ ...base, orderStatus: "cancelled", statusLabel: "已取消訂單，並已退款 NT$1,200" }).color, "#D92D20");
  assert.equal(statusNode({ ...base, orderStatus: "confirmed", statusLabel: "已確認付款 NT$1,200" }).color, "#06C755");
  assert.match(flexTexts({ ...base, orderStatus: "cancelled", statusLabel: "已取消訂單" }), /您的訂單已取消/);
});

test("a deposit-only confirmation lists the remaining balance; a full payment does not", () => {
  const deposit = flexTexts({ ...base, orderStatus: "confirmed", statusLabel: "已確認付款 NT$600", hasPreorder: true, depositDue: 600, paidAmount: 600 });
  assert.match(deposit, /待付尾款/);
  assert.match(deposit, /NT\$600/);
  assert.doesNotMatch(flexTexts({ ...base, orderStatus: "confirmed", statusLabel: "已確認付款 NT$1,200" }), /待付尾款/);
});

// 後台取消 API
const ORDER_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const LINE_ID = "U" + "c".repeat(32);
function fakeAdmin() {
  const rpcBodies = [];
  restoreFetch = stubFetch(async (url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_transition_order") { rpcBodies.push(body); return jsonResponse({ id: ORDER_ID, status: body.p_target_status, refunded_amount: body.p_refund_amount }); }
    return jsonResponse([]);
  });
  return rpcBodies;
}
const transition = (body) => worker.fetch(new Request(`https://shop.test/api/admin/orders/${ORDER_ID}/transition`, {
  method: "POST", headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, ctx());

test("the refund amount is forwarded to admin_transition_order", async () => {
  const rpcBodies = fakeAdmin();
  const response = await transition({ target_status: "cancelled", note: "客人取消", refund_amount: 1180 });
  assert.equal(response.status, 200);
  assert.equal(rpcBodies[0].p_refund_amount, 1180);
});

test("without a refund amount the RPC receives null (SQL decides whether it is required)", async () => {
  const rpcBodies = fakeAdmin();
  await transition({ target_status: "cancelled", note: "未付款" });
  assert.equal(rpcBodies[0].p_refund_amount, null);
});

test("negative or fractional refund amounts are rejected before the RPC", async () => {
  for (const refund of [-1, 10.5, "100"]) {
    const rpcBodies = fakeAdmin();
    const response = await transition({ target_status: "cancelled", note: "客人取消", refund_amount: refund });
    assert.equal(response.status, 400, `refund ${refund}`);
    assert.equal(rpcBodies.length, 0);
    restoreFetch();
  }
});
