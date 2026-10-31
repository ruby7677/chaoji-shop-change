// 後台訂單分類：與 SQL private.admin_order_stage 相同的判斷（tests/db/admin_order_stage.test.sql 驗證伺服器端）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ORDER_STAGES, adminOrderStage, orderMatchesFilter, stageCount, stageOpenCount } from "../../public/admin-order-stages.js";
import { adminOrderStatusLabel, orderStatusLabel } from "../../public/app-core.js";

const pre = [{ kind: "preorder" }];
const stock = [{ kind: "in_stock" }];
const cvs = { delivery_method: "cvs_delivery", order_items: pre, amount_due: 3060, paid_amount: 1500, final_payment_confirmed_at: null, final_payment_reported_at: null };

test("分頁順序：全部之後依序為待付訂…失效訂單，待出貨在已通知待尾款確認與已完成之間", () => {
  assert.deepEqual(ORDER_STAGES.map(([, label]) => label), ["待付訂", "待訂金對帳", "待到貨", "已通知待尾款確認", "待出貨／取貨", "已完成", "失效訂單"]);
});

test("預購交貨便每一步只落在一個分類", () => {
  assert.equal(adminOrderStage({ ...cvs, status: "pending_payment" }), "pending_payment");
  assert.equal(adminOrderStage({ ...cvs, status: "pending_review" }), "pending_review");
  assert.equal(adminOrderStage({ ...cvs, status: "confirmed" }), "awaiting_arrival");
  assert.equal(adminOrderStage({ ...cvs, status: "ready_for_pickup" }), "awaiting_balance");
  assert.equal(adminOrderStage({ ...cvs, status: "partially_ready" }), "awaiting_balance");
  assert.equal(adminOrderStage({ ...cvs, status: "ready_for_pickup", final_payment_reported_at: "2026-10-29T12:00:00Z" }), "awaiting_balance", "a reported balance stays until the admin confirms it");
  assert.equal(adminOrderStage({ ...cvs, status: "ready_for_pickup", final_payment_reported_at: "2026-10-29T12:00:00Z", final_payment_confirmed_at: "2026-10-30T00:00:00Z" }), "ready_to_ship");
  assert.equal(adminOrderStage({ ...cvs, status: "completed" }), "completed");
});

test("現貨已確認、到店取貨預購到貨、宅配已收齊歸待出貨；取消與舊退款歸失效", () => {
  assert.equal(adminOrderStage({ status: "confirmed", delivery_method: "cvs_delivery", order_items: stock }), "ready_to_ship");
  assert.equal(adminOrderStage({ status: "ready_for_pickup", delivery_method: "store_pickup", order_items: pre, amount_due: 2000, paid_amount: 1000 }), "ready_to_ship");
  const home = { status: "ready_for_pickup", delivery_method: "home_delivery", order_items: pre, amount_due: 3150, paid_amount: 1500 };
  assert.equal(adminOrderStage(home), "awaiting_balance", "fee not confirmed yet");
  assert.equal(adminOrderStage({ ...home, paid_amount: 3150 }), "awaiting_balance", "paid in full needs a confirmed fee");
  assert.equal(adminOrderStage({ ...home, paid_amount: 3150, shipping_fee_notified_at: "2026-10-29T00:00:00Z" }), "ready_to_ship");
  assert.equal(adminOrderStage({ status: "cancelled", order_items: pre }), "cancelled");
  assert.equal(adminOrderStage({ status: "refunded", order_items: stock }), "cancelled");
});

test("篩選：分類值比對分類，舊的狀態值比對狀態；徽章只給需要處理的分類", () => {
  const order = { ...cvs, status: "ready_for_pickup" };
  assert.equal(orderMatchesFilter(order, "awaiting_balance"), true);
  assert.equal(orderMatchesFilter(order, "ready_to_ship"), false);
  assert.equal(orderMatchesFilter(order, "ready_for_pickup"), true);
  assert.equal(orderMatchesFilter(order, "all"), true);
  const stats = { balanceReported: 3, stageCounts: { awaiting_balance: 5, awaiting_arrival: 4, ready_to_ship: 2 } };
  assert.equal(stageCount("awaiting_balance", stats), 3, "only reported balances need the admin");
  assert.equal(stageCount("ready_to_ship", stats), 2);
  assert.equal(stageCount("awaiting_arrival", stats), 0);
  assert.equal(stageCount("ready_to_ship", {}), 0);
});

test("尾款確認後，前台與後台狀態都顯示「尾款已確認，待出貨」；到店取貨與現貨不受影響", () => {
  const confirmed = { ...cvs, status: "ready_for_pickup", final_payment_confirmed_at: "2026-10-30T00:00:00Z" };
  assert.equal(orderStatusLabel(confirmed), "尾款已確認，待出貨");
  assert.equal(adminOrderStatusLabel({ ...confirmed, delivery_method: "home_delivery" }), "尾款已確認，待出貨");
  assert.equal(orderStatusLabel({ ...cvs, status: "ready_for_pickup" }), "已到貨，待尾款／運費");
  assert.equal(adminOrderStatusLabel({ ...confirmed, delivery_method: "store_pickup" }), "預購到店待取貨");
  assert.equal(orderStatusLabel({ ...confirmed, status: "completed" }), "已出貨");
});

test("SQL 分類值清單與前端一致", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/202610290002_admin_order_stage_filter.sql", import.meta.url), "utf8");
  const listed = sql.match(/v_stages constant text\[\] := array\[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map((value) => value.slice(1, -1));
  assert.deepEqual(listed, ORDER_STAGES.map(([value]) => value));
});

test("分頁一般筆數取自未結案分類計數，沒有資料時為 0", () => {
  const stats = { stageCounts: { awaiting_arrival: 4, pending_payment: 2 } };
  assert.equal(stageOpenCount("awaiting_arrival", stats), 4);
  assert.equal(stageOpenCount("completed", stats), 0);
  assert.equal(stageOpenCount("pending_payment", {}), 0);
});
