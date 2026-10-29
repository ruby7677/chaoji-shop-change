// 7-11 店到店（交貨便）：建單 API 驗證與轉送門市欄位、賣貨便停止新建、後台出貨寄件編號、
// 交貨便運費固定，以及業主指定的三則通知文案（建立、確認、出貨）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const messages = await loadSourceModule("line-notification-messages.ts");
const MEMBER_ID = "00000000-0000-4000-8000-0000000000c1";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000c2";
const LINE_ID = "U" + "e".repeat(32);
const ORDER_ID = "cccccccc-0000-4000-8000-0000000000c3";
const VARIANT_ID = "dddddddd-0000-4000-8000-0000000000c4";
const BANK_ID = "eeeeeeee-0000-4000-8000-0000000000c5";

let restoreFetch = () => {};
afterEach(() => restoreFetch());
globalThis.caches ??= { default: { delete: async () => true } };

const validCvs = {
  items: [{ variant_id: VARIANT_ID, quantity: 1 }], delivery_method: "cvs_delivery", bank_account_id: BANK_ID,
  shipping_recipient_name: " 王小明 ", shipping_phone: "0912-345-678",
  pickup_store_city: "臺南市", pickup_store_district: "中西區", pickup_store_name: "民生門市", pickup_store_code: " 123456 "
};

function fakeMember() {
  const rpcBodies = [];
  restoreFetch = stubFetch((url, _init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/rpc/create_delivery_order") { rpcBodies.push(body); return jsonResponse(ORDER_ID); }
    if (url.pathname === "/rest/v1/orders") return jsonResponse([{ id: ORDER_ID, order_number: "CJ-1", status: "pending_payment", delivery_method: "cvs_delivery", bank_account_id: BANK_ID, subtotal: 260, coupon_discount: 0, point_discount: 0, shipping_fee: 60, amount_due: 320, deposit_due: 320, order_items: [] }]);
    return jsonResponse([]);
  });
  return rpcBodies;
}

const createOrder = (body) => worker.fetch(new Request("https://shop.test/api/orders", {
  method: "POST", headers: { Authorization: "Bearer member-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, ctx());

test("a cvs order forwards the normalized recipient and pickup store to the RPC", async () => {
  const rpcBodies = fakeMember();
  const response = await createOrder(validCvs);
  assert.equal(response.status, 201);
  assert.deepEqual(
    [rpcBodies[0].p_delivery_method, rpcBodies[0].p_shipping_recipient_name, rpcBodies[0].p_shipping_phone, rpcBodies[0].p_pickup_store_city,
      rpcBodies[0].p_pickup_store_district, rpcBodies[0].p_pickup_store_name, rpcBodies[0].p_pickup_store_code, rpcBodies[0].p_shipping_address],
    ["cvs_delivery", "王小明", "0912345678", "臺南市", "中西區", "民生門市", "123456", null]
  );
});

test("store pickup sends no recipient or pickup store fields", async () => {
  const rpcBodies = fakeMember();
  await createOrder({ ...validCvs, delivery_method: "store_pickup" });
  assert.deepEqual([rpcBodies[0].p_shipping_recipient_name, rpcBodies[0].p_pickup_store_code], [null, null]);
});

test("cvs orders without a complete store or a 6-digit code are rejected before the RPC", async () => {
  for (const [patch, message] of [
    [{ pickup_store_name: " " }, "7-11 店到店請選擇縣市、鄉鎮區並填寫取件門市名稱"],
    [{ pickup_store_district: "" }, "7-11 店到店請選擇縣市、鄉鎮區並填寫取件門市名稱"],
    [{ pickup_store_code: "12345" }, "7-11 門市店號必須是 6 位數字"],
    [{ shipping_phone: "12345" }, "請填寫有效的收件人（取件人）手機號碼"]
  ]) {
    const rpcBodies = fakeMember();
    const response = await createOrder({ ...validCvs, ...patch });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, message);
    assert.equal(rpcBodies.length, 0);
  }
});

test("new seller-delivery orders are rejected", async () => {
  const rpcBodies = fakeMember();
  const response = await createOrder({ ...validCvs, delivery_method: "seller_delivery", payment_method: "store_payment", bank_account_id: undefined });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "賣貨便已停用，請改選 7-11 店到店（交貨便）");
  assert.equal(rpcBodies.length, 0);
});

// 後台
function fakeAdmin(order = { status: "ready_for_pickup", delivery_method: "cvs_delivery", shipping_fee: 60, order_items: [{ kind: "preorder" }] }) {
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
const adminPost = (path, body) => worker.fetch(new Request(`https://shop.test/api/admin/orders/${ORDER_ID}/${path}`, {
  method: path === "fulfillment" ? "PATCH" : "POST", headers: { Authorization: "Bearer admin-access-token", "Content-Type": "application/json" }, body: JSON.stringify(body)
}), baseEnv, ctx());

test("completing a cvs order stores the tracking number before the transition", async () => {
  const calls = fakeAdmin();
  const response = await adminPost("transition", { target_status: "completed", shipment_tracking_number: " F1234-5678 " });
  assert.equal(response.status, 200);
  // 轉換後的通知在 waitUntil 裡，這裡只看同步呼叫的兩支 RPC 順序。
  assert.deepEqual(calls.map(([name]) => name).slice(0, 2), ["admin_set_order_shipment_tracking", "admin_transition_order"]);
  assert.equal(calls[0][1].p_tracking_number, "F1234-5678");
});

test("an invalid tracking number is rejected before any RPC", async () => {
  const calls = fakeAdmin();
  const response = await adminPost("transition", { target_status: "completed", shipment_tracking_number: "F12<34" });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("in-stock cvs orders cannot be marked as arrived", async () => {
  const calls = fakeAdmin({ status: "confirmed", delivery_method: "cvs_delivery", order_items: [{ kind: "in_stock" }] });
  const response = await adminPost("transition", { target_status: "ready_for_pickup" });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("the cvs shipping fee cannot be changed when confirming the balance", async () => {
  const calls = fakeAdmin();
  const changed = await adminPost("fulfillment", { shipping_fee: 0, final_payment_confirmed: true, final_payment_last_five: "54321" });
  assert.equal(changed.status, 400);
  assert.equal(calls.length, 0);
  const kept = await adminPost("fulfillment", { shipping_fee: 60, final_payment_confirmed: true, final_payment_last_five: "54321" });
  assert.equal(kept.status, 200);
});

// 通知文案（業主 2026-10-11 範本）
const cvsBase = {
  storeName: "潮吉好頑", orderNumber: "CJ-261010-232833-CDC8", items: "SAMSAM達摩套娃不倒翁盲盒 ×1",
  deliveryLine: "7-11店到店(交貨便)", paymentLine: "匯款／轉帳", hasPreorder: false, amountDue: 320, depositDue: 320, paidAmount: 0,
  shippingFee: 60, productAmount: 260, finalPaymentConfirmed: false, statusLabel: ""
};
const telegram = (data) => messages.buildTelegramOrderNotificationMessage(messages.buildOrderNotificationMessage(data), "建育");

test("cvs created, confirmed and shipped notifications follow the owner's template", () => {
  assert.equal(telegram({ ...cvsBase, eventType: "created", orderStatus: "pending_payment" }), [
    "【潮吉好頑選物】", "訂單編號：CJ-261010-232833-CDC8", "訂單狀態：待確認付款", "會員名稱：建育", "",
    "商品：SAMSAM達摩套娃不倒翁盲盒 ×1", "商品金額：NT$260", "運費：NT$60", "總金額：NT$320", "付款方式：匯款／轉帳"
  ].join("\n"));
  assert.equal(telegram({ ...cvsBase, eventType: "status_changed", orderStatus: "confirmed" }), [
    "【潮吉好頑選物】", "訂單編號：CJ-261010-232833-CDC8", "訂單狀態：已確認訂單(付款完成)，待出貨", "會員名稱：建育", "",
    "商品：SAMSAM達摩套娃不倒翁盲盒 ×1", "取貨方式：7-11店到店(交貨便)"
  ].join("\n"));
  assert.equal(telegram({ ...cvsBase, eventType: "status_changed", orderStatus: "completed" }), [
    "【潮吉好頑選物】", "訂單編號：CJ-261010-232833-CDC8", "訂單狀態：已出貨，請留意到貨的簡訊通知", "會員名稱：建育", "",
    "商品：SAMSAM達摩套娃不倒翁盲盒 ×1", "取貨方式：7-11店到店(交貨便)"
  ].join("\n"));
});

test("free shipping shows 免運 and preorders add the deposit and notice", () => {
  const text = messages.buildOrderNotificationMessage({ ...cvsBase, eventType: "created", orderStatus: "pending_payment", shippingFee: 0, amountDue: 6000, productAmount: 6000, hasPreorder: true, depositDue: 3000 });
  assert.match(text, /運費：免運/);
  assert.match(text, /訂金：NT\$3,000/);
  assert.match(text, /預購商品注意事項/);
});

test("preorder cvs arrival asks for the balance; in-stock cvs has no arrival message", () => {
  const arrival = { ...cvsBase, eventType: "status_changed", orderStatus: "ready_for_pickup" };
  const arrivalText = messages.buildOrderNotificationMessage({ ...arrival, hasPreorder: true });
  assert.match(arrivalText, /訂單狀態：商品已到貨，請匯尾款\n/);
  assert.doesNotMatch(arrivalText, /私訊小幫手/);
  assert.equal(messages.buildOrderNotificationMessage(arrival), null);
  assert.equal(messages.buildOrderNotificationMessage({ ...cvsBase, eventType: "fulfillment_updated", orderStatus: "ready_for_pickup", hasPreorder: true }), null);
});

test("preorder cvs arrival card ends with the 查看訂單 hint below the pickup store", () => {
  const data = { ...cvsBase, eventType: "status_changed", orderStatus: "ready_for_pickup", hasPreorder: true, pickupStore: "高雄市前鎮區 新憲德門市（241458）" };
  const text = messages.buildOrderNotificationMessage(data);
  assert.match(text, /點擊⬇️查看訂單，查詢尾款\/匯款帳號$/);
  const body = messages.buildLineOrderFlexMessage(data, text, "https://example.test/orders").contents.body.contents;
  const last = body.at(-1);
  assert.equal(last.text, "點擊⬇️查看訂單，查詢尾款/匯款帳號");
  const storeIndex = body.findIndex((item) => JSON.stringify(item).includes("新憲德門市"));
  assert.ok(storeIndex > 0 && storeIndex < body.length - 1, "the hint sits after the pickup store row");
});

test("preorder arrival cards replace 付款方式 with 尾款／運費 = balance + shipping", () => {
  const rowsOf = (data) => {
    const text = messages.buildOrderNotificationMessage(data);
    return JSON.stringify(messages.buildLineOrderFlexMessage(data, text, "https://example.test/orders"));
  };
  const cvs = rowsOf({ ...cvsBase, eventType: "status_changed", orderStatus: "ready_for_pickup", hasPreorder: true, amountDue: 3060, depositDue: 1500, paidAmount: 1500 });
  assert.match(cvs, /"text":"尾款／運費".*?"text":"NT\$1,560"/);
  assert.doesNotMatch(cvs, /付款方式/);
  const store = rowsOf({ ...cvsBase, deliveryLine: "到店取貨", eventType: "status_changed", orderStatus: "ready_for_pickup", hasPreorder: true, shippingFee: 0, amountDue: 3000, depositDue: 1500, paidAmount: 1500 });
  assert.match(store, /"text":"尾款／運費".*?"text":"NT\$1,500"/);
  assert.match(store, /商品已到貨，請確認尾款/);
  assert.doesNotMatch(store, /私訊小幫手/);
  assert.doesNotMatch(store, /付款方式/);
  // 其他通知仍保留付款方式
  assert.match(rowsOf({ ...cvsBase, eventType: "status_changed", orderStatus: "confirmed" }), /付款方式/);
});

test("the LINE card lists the pickup store", () => {
  const card = JSON.stringify(messages.buildLineOrderFlexMessage({ ...cvsBase, eventType: "created", orderStatus: "pending_payment", pickupStore: "臺南市中西區 民生門市（123456）" }, "alt"));
  assert.match(card, /取件門市/);
  assert.match(card, /民生門市（123456）/);
});
