// 低庫存通知：與後台相同，由資料庫 low_stock_variants 決定哪些規格低庫存；已通知過但不再低庫存（補貨或下架）的規格一次重設。
// 每天一次：只由每小時排程的台灣 10 點那一輪檢查，那一輪不做其他通知工作；確定送出才記錄水位。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const notifications = await loadSourceModule("notifications.ts");
let restoreFetch = () => {};
afterEach(() => restoreFetch());

const NOW = new Date("2026-10-13T02:00:00Z"); // 台灣 10:00
const LOW = [{ id: "v-low", name: "藍色", sku: "B-1", product_name: "戰鬥陀螺", stock_on_hand: 1, safety_stock: 3 }];

function fakeDb({ low = LOW, states = [], telegramStatus = 200 } = {}) {
  const seen = { patches: [], claims: [], recorded: [], upserts: 0, telegram: 0, lowStockAuth: null, fetches: [] };
  restoreFetch = stubFetch((url, init, body) => {
    const method = init.method || "GET";
    seen.fetches.push(`${method} ${url.pathname}`);
    if (url.host === "api.telegram.org") { seen.telegram += 1; return telegramStatus === 200 ? jsonResponse({ ok: true }) : jsonResponse({ ok: false }, telegramStatus); }
    if (url.pathname === "/rest/v1/rpc/low_stock_variants") {
      seen.lowStockAuth = new Headers(init.headers).get("Authorization");
      return jsonResponse(low);
    }
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "GET") return jsonResponse(states);
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "PATCH") { seen.patches.push(url.searchParams.get("variant_id")); return new Response(null, { status: 204 }); }
    if (url.pathname === "/rest/v1/line_low_stock_states" && method === "POST") { seen.recorded.push(...body); seen.upserts += 1; return new Response(null, { status: 201 }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      seen.claims.push(body);
      return jsonResponse({ id: "n1", claim_token: "t", status: "processing", attempt_count: 1, payload: body.p_payload, claimed: true });
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

test("the alert key carries the Taipei date and the alerted levels", async () => {
  const seen = fakeDb();
  await notifications.notifyLowStock(baseEnv, new Date("2026-10-13T17:00:00Z")); // 台灣 10/14 01:00
  assert.deepEqual([...new Set(seen.claims.map((claim) => claim.p_event_key))], ["low-stock:2026-10-14:v-low-1"]);
});

test("levels are not recorded when no admin received the alert", async () => {
  const seen = fakeDb({ telegramStatus: 503 });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.deepEqual(seen.recorded, [], "tomorrow's check alerts again");
});

test("restocked variants are reset even when nothing new is low", async () => {
  const seen = fakeDb({ low: [], states: [{ variant_id: "v-restocked", last_notified_stock: 1 }] });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.deepEqual(seen.patches, ["in.(v-restocked)"]);
  assert.deepEqual(seen.claims, []);
});

test("nothing is sent when no variant dropped since the last alert", async () => {
  const seen = fakeDb({ low: [{ ...LOW[0], stock_on_hand: 2 }], states: [{ variant_id: "v-low", last_notified_stock: 2 }] });
  await notifications.notifyLowStock(baseEnv, NOW);
  assert.deepEqual(seen.claims, []);
});

for (const [label, hour, lowStock, others] of [["at 10:00 Taipei", "02", true, false], ["at other hours", "03", false, true]]) {
  test(`the hourly schedule ${lowStock ? "only checks low stock" : "runs the other jobs"} ${label}`, async () => {
    const seen = fakeDb();
    await notifications.runScheduledNotifications(baseEnv, new Date(`2026-10-13T${hour}:00:00Z`));
    assert.equal(seen.fetches.includes("POST /rest/v1/rpc/low_stock_variants"), lowStock);
    assert.equal(seen.fetches.some((entry) => entry.endsWith("/rest/v1/orders") || entry.endsWith("/rest/v1/coupons")), others);
  });
}

test("admin routes no longer send low stock alerts outside the daily check", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("notifyLowStock"));
});
