// 後台會員分頁（/api/admin/dashboard?section=members）：消費紀錄只抓畫面用得到的欄位，
// 並以 memberOrders 回傳，不能用 orders（前台合併各分區資料時會蓋掉訂單分頁的列表）。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const ADMIN_ID = "00000000-0000-4000-8000-000000000002";
const MEMBER_ID = "aaaaaaaa-0000-4000-8000-000000000010";
const LINE_ID = "U" + "c".repeat(32);

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeAdmin() {
  const ordersSelects = [];
  restoreFetch = stubFetch(async (url) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_search_member_ids") return jsonResponse({ ids: [MEMBER_ID], pagination: { page: 0, pageSize: 100, hasMore: false } });
    if (url.pathname === "/rest/v1/admin_member_summary") return jsonResponse([{ id: MEMBER_ID, full_name: "會員" }]);
    if (url.pathname === "/rest/v1/point_ledger") return jsonResponse([]);
    if (url.pathname === "/rest/v1/point_settings") return jsonResponse([]);
    if (url.pathname === "/rest/v1/orders") {
      ordersSelects.push(url.searchParams.get("select"));
      return jsonResponse([{ id: "o1", member_id: MEMBER_ID, order_number: "CJ-1", status: "completed", delivery_method: "cvs_delivery", amount_due: 500, created_at: "2026-10-20T00:00:00Z", order_items: [{ kind: "in_stock" }] }]);
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return ordersSelects;
}

test("the members section returns member orders under memberOrders with only the fields the list shows", async () => {
  const ordersSelects = fakeAdmin();
  const response = await worker.fetch(new Request("https://shop.test/api/admin/dashboard?section=members", {
    headers: { Authorization: "Bearer admin-access-token" }
  }), baseEnv, ctx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.orders, undefined, "must not overwrite the orders tab's list");
  assert.equal(body.memberOrders[0].order_number, "CJ-1");
  const fields = ordersSelects[0].split(",");
  for (const field of ["member_id", "order_number", "status", "delivery_method", "amount_due", "created_at", "order_items(kind)"]) assert.ok(fields.includes(field), field);
  assert.ok(!/bank_accounts|shipping_address|payment_last_five|admin_note/.test(ordersSelects[0]), "full order details are not loaded for the member list");
});
