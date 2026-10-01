// 低庫存通知：與後台相同，由資料庫 low_stock_variants 決定哪些規格低庫存；已通知過但不再低庫存（補貨或下架）的規格一次重設。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const notifications = await loadSourceModule("notifications.ts");
let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("low stock alerts use the shared definition and reset recovered variants in one request", async () => {
  const seen = { patches: [], claims: [], recorded: [], lowStockAuth: null };
  restoreFetch = stubFetch((url, init, body) => {
    if (url.pathname === "/rest/v1/rpc/low_stock_variants") {
      seen.lowStockAuth = new Headers(init.headers).get("Authorization");
      return jsonResponse([{ id: "v-low", name: "藍色", sku: "B-1", product_name: "戰鬥陀螺", stock_on_hand: 1, safety_stock: 3 }]);
    }
    if (url.pathname === "/rest/v1/line_low_stock_states" && (init.method || "GET") === "GET") {
      return jsonResponse([
        { variant_id: "v-low", last_notified_stock: 2 },
        { variant_id: "v-restocked", last_notified_stock: 0 },
        { variant_id: "v-unpublished", last_notified_stock: 1 },
        { variant_id: "v-already-reset", last_notified_stock: null }
      ]);
    }
    if (url.pathname === "/rest/v1/line_low_stock_states" && init.method === "PATCH") { seen.patches.push(url.searchParams.get("variant_id")); return new Response(null, { status: 204 }); }
    if (url.pathname === "/rest/v1/line_low_stock_states" && init.method === "POST") { seen.recorded.push(body); return new Response(null, { status: 201 }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      seen.claims.push(body);
      return jsonResponse({ id: "n1", claim_token: null, status: "sent", attempt_count: 1, payload: {}, claimed: false });
    }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  await notifications.notifyLowStock(baseEnv);
  assert.equal(seen.lowStockAuth, "Bearer service-key");
  assert.deepEqual(seen.patches, ["in.(v-restocked,v-unpublished)"], "restocked and unpublished variants are reset together; already-reset ones are left alone");
  assert.equal(seen.claims.length, 2, "one alert per Telegram admin");
  assert.match(seen.claims[0].p_payload.text, /戰鬥陀螺 · 藍色：剩 1 件/);
  assert.deepEqual(seen.recorded.map((row) => [row.variant_id, row.last_notified_stock]), [["v-low", 1]], "the alerted level is remembered");
});

test("nothing is sent when no variant dropped since the last alert", async () => {
  let claimed = false;
  restoreFetch = stubFetch((url, init) => {
    if (url.pathname === "/rest/v1/rpc/low_stock_variants") return jsonResponse([{ id: "v-low", name: "藍色", sku: "B-1", product_name: "戰鬥陀螺", stock_on_hand: 2, safety_stock: 3 }]);
    if (url.pathname === "/rest/v1/line_low_stock_states") return jsonResponse([{ variant_id: "v-low", last_notified_stock: 2 }]);
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") { claimed = true; return jsonResponse({}); }
    throw new Error(`unexpected request ${init.method || "GET"} ${url}`);
  });
  await notifications.notifyLowStock(baseEnv);
  assert.equal(claimed, false);
});
