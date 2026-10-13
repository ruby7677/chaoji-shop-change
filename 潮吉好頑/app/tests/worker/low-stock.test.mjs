// 低庫存通知：與後台相同，由資料庫 low_stock_variants 決定哪些規格低庫存；已通知過但不再低庫存（補貨或下架）的規格一次重設。
// 每個台灣日最多一則：event key 只帶台灣日期，由通知 claim 去重；只有取得當天通知的一方記錄水位。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const notifications = await loadSourceModule("notifications.ts");
let restoreFetch = () => {};
afterEach(() => restoreFetch());

const NOW = new Date("2026-10-13T02:00:00Z"); // 台灣 10:00
const LOW = [{ id: "v-low", name: "藍色", sku: "B-1", product_name: "戰鬥陀螺", stock_on_hand: 1, safety_stock: 3 }];

/** sentToday：今天的低庫存通知已由別次送出（claim 回傳 claimed:false）。 */
function fakeDb({ low = LOW, states = [], sentToday = false } = {}) {
  const seen = { patches: [], claims: [], recorded: [], upserts: 0, telegram: 0, lowStockAuth: null, fetches: [] };
  restoreFetch = stubFetch((url, init, body) => {
    const method = init.method || "GET";
    seen.fetches.push(`${method} ${url.pathname}`);
    if (url.host === "api.telegram.org") { seen.telegram += 1; return jsonResponse({ ok: true }); }
    if (url.pathname === "/rest/v1/rpc/low_stock_variants") {
      seen.lowStockAuth = new Headers(init.headers).get("Authorization");
      return jsonResponse(low);
    }
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "GET") return jsonResponse(states);
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "PATCH") { seen.patches.push(url.searchParams.get("variant_id")); return new Response(null, { status: 204 }); }
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "POST") { seen.recorded.push(...body); seen.upserts += 1; return new Response(null, { status: 201 }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      seen.claims.push(body);
      return sentToday
        ? jsonResponse({ id: "n1", claim_token: null, status: "sent", attempt_count: 1, payload: body.p_payload, claimed: false })
        : jsonResponse({ id: "n1", claim_token: "t", status: "processing", attempt_count: 1, payload: body.p_payload, claimed: true });
    }
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") return jsonResponse(true);
    // 每小時排程的其他工作（取消通知、生日券）：沒有資料
    if (url.pathname === "/rest/v1/orders" || url.pathname === "/rest/v1/coupons") return jsonResponse([]);
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return seen;
}

test("low stock alerts use the shared definition and reset recovered variants in one request", async () => {
  const seen = fakeDb({ states: [
    { variant_id: "v-low", last_notified_stock: 2 },
    { variant_id: "v-restocked", last_notified_stock: 0 },
    { variant_id: "v-unpublished", last_notified_stock: 1 },
    { variant_id: "v-already-reset", last_notified_stock: null }
  ] });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.equal(seen.lowStockAuth, "Bearer service-key");
  assert.deepEqual(seen.patches, ["in.(v-restocked,v-unpublished)"], "restocked and unpublished variants are reset together; already-reset ones are left alone");
  assert.equal(seen.claims.length, 2, "one alert per Telegram admin");
  assert.match(seen.claims[0].p_payload.text, /戰鬥陀螺 · 藍色：剩 1 件/);
  assert.deepEqual(seen.recorded.map((row) => [row.variant_id, row.last_notified_stock]), [["v-low", 1]], "the alerted level is remembered");
  assert.equal(seen.upserts, 1, "all alerted levels are written in one request");
});

test("the alert key is the Taipei date alone, so one alert per admin per day", async () => {
  const seen = fakeDb();
  await notifications.notifyLowStock(baseEnv, new Date("2026-10-13T17:00:00Z")); // 台灣 10/14 01:00
  assert.deepEqual([...new Set(seen.claims.map((claim) => claim.p_event_key))], ["low-stock:2026-10-14"]);
});

test("when today's alert already went out, new low variants are kept for tomorrow", async () => {
  const seen = fakeDb({ sentToday: true });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.equal(seen.telegram, 0, "no second message today");
  assert.deepEqual(seen.recorded, [], "levels stay unrecorded so tomorrow's alert includes them");
});

test("restocked variants are reset even when today's alert already went out", async () => {
  const seen = fakeDb({ low: [], states: [{ variant_id: "v-restocked", last_notified_stock: 1 }], sentToday: true });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.deepEqual(seen.patches, ["in.(v-restocked)"]);
});

test("nothing is sent when no variant dropped since the last alert", async () => {
  const seen = fakeDb({ low: [{ ...LOW[0], stock_on_hand: 2 }], states: [{ variant_id: "v-low", last_notified_stock: 2 }] });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.deepEqual(seen.claims, []);
});

for (const [label, hour, expected] of [["at 10:00 Taipei", "02", true], ["at other hours", "03", false]]) {
  test(`the hourly schedule checks low stock only ${label}`, async () => {
    const seen = fakeDb();
    await notifications.runScheduledNotifications({ ...baseEnv, LINE_NOTIFY_ENABLED: "false" }, new Date(`2026-10-13T${hour}:00:00Z`));
    assert.equal(seen.fetches.includes("POST /rest/v1/rpc/low_stock_variants"), expected);
  });
}
