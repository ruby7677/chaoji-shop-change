// 我的訂單：已取消的訂單集中在最下方收合，卡片不顯示付款進度，改顯示款項去向。
import test from "node:test";
import assert from "node:assert/strict";
import { closedOrderCardMarkup, ordersListMarkup } from "../../public/order-views.js";

const base = { order_number: "CJ-1", created_at: "2026-10-29T10:38:00Z", delivery_method: "cvs_delivery", amount_due: 3060, deposit_due: 1500, shipping_fee: 60, order_items: [{ product_name: "鳳凰", variant_name: "單一規格", quantity: 1, kind: "preorder" }] };
const cancelled = { ...base, id: "c1", status: "cancelled", paid_amount: 0 };
const active = { ...base, id: "a1", order_number: "CJ-2", status: "confirmed" };

test("已取消卡片不顯示本次應付、尾款與回報按鈕", () => {
  const html = closedOrderCardMarkup(cancelled);
  assert.doesNotMatch(html, /本次應付|尾款|data-order-payment/);
  assert.match(html, /不需要再匯款/);
  assert.match(html, /訂單總額<\/span><strong>NT\$3,060/);
});

test("有退款或已付款時顯示款項去向", () => {
  assert.match(closedOrderCardMarkup({ ...cancelled, paid_amount: 1500, refunded_amount: 1500 }), /已退款 NT\$1,500/);
  assert.match(closedOrderCardMarkup({ ...cancelled, paid_amount: 1500, refunded_amount: null }), /已付 NT\$1,500，款項處理方式請洽/);
});

test("清單先列進行中訂單，已取消的收進最下方的收合群組", () => {
  const html = ordersListMarkup([cancelled, active]);
  assert.ok(html.indexOf("CJ-2") < html.indexOf("orders-closed-group"));
  assert.match(html, /<details class="orders-closed-group"><summary>已取消的訂單（1）/);
  assert.doesNotMatch(html, /<details class="orders-closed-group" open/);
});

test("只有已取消訂單時提示沒有進行中的訂單；沒有訂單時顯示空狀態", () => {
  assert.match(ordersListMarkup([cancelled]), /目前沒有進行中的訂單/);
  assert.match(ordersListMarkup([]), /目前還沒有訂單/);
});
