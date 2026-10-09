// 後台 dashboard API：overview 聚合回應（統計、待辦、最新訂單、低庫存）、分區必填、管理員驗證。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const ADMIN_ID = "00000000-0000-4000-8000-000000000001";
const LINE_ID = "U" + "a".repeat(32);
let restoreFetch = () => {};
afterEach(() => restoreFetch());

function fakeSupabase({ isAdmin = true, todoCount = 2 } = {}) {
  const seen = { restPaths: [], queries: [], bodies: {} };
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/auth/v1/user") {
      return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    }
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: isAdmin, line_user_id: LINE_ID }]);
    seen.restPaths.push(`${init.method || "GET"} ${url.pathname}`);
    seen.queries.push(url);
    seen.bodies[url.pathname] = body;
    if (url.pathname === "/rest/v1/rpc/admin_dashboard_stats") return jsonResponse({ pendingReview: 1, lowStock: 3, memberCount: 9 });
    if (url.pathname === "/rest/v1/orders" && url.searchParams.has("or")) {
      return jsonResponse(Array.from({ length: todoCount }, (_, index) => ({ id: `todo-${index}`, order_number: `CJ-${index}`, status: "pending_review" })));
    }
    if (url.pathname === "/rest/v1/orders") return jsonResponse([{ id: "recent-1", order_number: "CJ-R1", status: "confirmed" }]);
    if (url.pathname === "/rest/v1/rpc/low_stock_variants") {
      return jsonResponse([
        { id: "v-out", name: "A", sku: "A-1", product_name: "缺貨商品", stock_on_hand: 0, safety_stock: 1 },
        { id: "v-low", name: "B", sku: "B-1", product_name: "低庫存商品", stock_on_hand: 2, safety_stock: 2 }
      ]);
    }
    throw new Error(`unexpected request ${url}`);
  });
  return seen;
}

const dashboard = (query) => worker.fetch(new Request(`https://shop.test/api/admin/dashboard${query}`, {
  headers: { Authorization: "Bearer admin-access-token" }
}), baseEnv, ctx());

test("overview returns stats, todo orders, recent orders and low stock in one response", async () => {
  const seen = fakeSupabase();
  const response = await dashboard("?section=overview");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.stats, { pendingReview: 1, lowStock: 3, memberCount: 9 });
  assert.deepEqual(body.overview.todoOrders.map((order) => order.id), ["todo-0", "todo-1"]);
  assert.equal(body.overview.todoTruncated, false);
  assert.deepEqual(body.overview.recentOrders.map((order) => order.id), ["recent-1"]);
  assert.deepEqual(body.overview.lowStock, [
    { id: "v-out", name: "A", product_name: "缺貨商品", stock_on_hand: 0, safety_stock: 1 },
    { id: "v-low", name: "B", product_name: "低庫存商品", stock_on_hand: 2, safety_stock: 2 }
  ]);
  assert.deepEqual(seen.restPaths.sort(), ["GET /rest/v1/orders", "GET /rest/v1/orders", "POST /rest/v1/rpc/admin_dashboard_stats", "POST /rest/v1/rpc/low_stock_variants"]);
  assert.deepEqual(seen.bodies["/rest/v1/rpc/low_stock_variants"], { p_limit: 20 }, "low stock comes from the shared database definition, capped at 20");
});

test("todo orders are filtered by the database with the three manual-work rules", async () => {
  const seen = fakeSupabase();
  await dashboard("?section=overview");
  const todoQuery = seen.queries.find((url) => url.pathname === "/rest/v1/orders" && url.searchParams.has("or"));
  const filter = todoQuery.searchParams.get("or");
  for (const rule of [
    "status.eq.pending_review",
    "and(delivery_method.eq.seller_delivery,status.eq.pending_payment,bank_account_id.is.null)",
    "and(delivery_method.eq.home_delivery,status.eq.ready_for_pickup,final_payment_confirmed_at.is.null)"
  ]) assert.ok(filter.includes(rule), `todo filter includes ${rule}`);
  assert.ok(!filter.includes("refund_pending"), "refund flow is no longer a todo");
  assert.match(todoQuery.searchParams.get("select"), /order_items\(kind\)/, "status labels can tell preorders apart");
  assert.doesNotMatch(todoQuery.searchParams.get("select"), /shipping_address|shipping_phone|account_number/, "overview does not load unnecessary personal or bank fields");
});

test("more than 50 todo orders are truncated and flagged", async () => {
  fakeSupabase({ todoCount: 51 });
  const body = await (await dashboard("?section=overview")).json();
  assert.equal(body.overview.todoOrders.length, 50);
  assert.equal(body.overview.todoTruncated, true);
});

test("the legacy full dashboard without a section is gone", async () => {
  const seen = fakeSupabase();
  const response = await dashboard("");
  assert.equal(response.status, 400);
  assert.deepEqual(seen.restPaths, [], "no table is read");
  const unknown = await dashboard("?section=everything");
  assert.equal(unknown.status, 400);
});

test("non-admins cannot load the overview", async () => {
  const seen = fakeSupabase({ isAdmin: false });
  const response = await dashboard("?section=overview");
  assert.equal(response.status, 403);
  assert.deepEqual(seen.restPaths, []);
});

test("the product list sends category, kind and status to the database so filtering happens before paging", async () => {
  const bodies = [];
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/auth/v1/user") return jsonResponse({ id: ADMIN_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_ID } }] });
    if (url.pathname === "/rest/v1/profiles") return jsonResponse([{ is_admin: true, line_user_id: LINE_ID }]);
    if (url.pathname === "/rest/v1/rpc/admin_search_product_ids") { bodies.push(body); return jsonResponse({ ids: [], pagination: { page: 0, pageSize: 100, hasMore: false } }); }
    if (url.pathname === "/rest/v1/rpc/admin_management_options") return jsonResponse({ products: [], members: [], categories: [] });
    throw new Error(`unexpected request ${url}`);
  });
  const category = "cccccccc-0000-4000-8000-000000000001";
  assert.equal((await dashboard(`?section=products&page=0&page_size=100&status=unpublished&kind=preorder&category=${category}`)).status, 200);
  assert.deepEqual(
    { status: bodies[0].p_status, kind: bodies[0].p_kind, category: bodies[0].p_category, page: bodies[0].p_page },
    { status: "unpublished", kind: "preorder", category, page: 0 }
  );
  assert.equal((await dashboard("?section=products")).status, 200);
  assert.deepEqual({ status: bodies[1].p_status, kind: bodies[1].p_kind, category: bodies[1].p_category }, { status: "all", kind: "all", category: "all" }, "missing filters default to all");
});
