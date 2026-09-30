// Supabase 保活（src/supabase-keepalive.ts）：每日固定小時只送一次唯讀 GET，失敗不丟錯，缺設定不送請求。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const keepalive = await loadSourceModule("supabase-keepalive");
const worker = await loadWorker();
const env = { SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon-key" };

let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("only the 18:00 UTC hour triggers the keepalive", () => {
  assert.equal(keepalive.isKeepaliveHour(Date.UTC(2026, 9, 1, 18, 0)), true);
  assert.equal(keepalive.isKeepaliveHour(Date.UTC(2026, 9, 1, 17, 0)), false);
  assert.equal(keepalive.isKeepaliveHour(Date.UTC(2026, 9, 1, 19, 0)), false);
  assert.equal(keepalive.isKeepaliveHour(Date.UTC(2026, 9, 2, 0, 0)), false);
});

test("ping sends one read-only GET with the anon key and never the service key", async () => {
  const calls = [];
  restoreFetch = stubFetch((url, init) => { calls.push({ url: url.href, method: init.method || "GET", headers: init.headers, body: init.body }); return jsonResponse([{ id: "x" }]); });
  assert.equal(await keepalive.pingSupabase({ ...env, SUPABASE_SERVICE_ROLE_KEY: "service-key" }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].url, "https://project.supabase.test/rest/v1/storefront_variants?select=id&limit=1");
  assert.equal(calls[0].headers.apikey, "anon-key");
  assert.ok(!JSON.stringify(calls[0].headers).includes("service-key"));
});

test("ping reports failure without throwing on HTTP errors and network errors", async () => {
  restoreFetch = stubFetch(() => new Response("nope", { status: 503 }));
  assert.equal(await keepalive.pingSupabase(env), false);
  restoreFetch();
  restoreFetch = stubFetch(() => { throw new TypeError("network down"); });
  assert.equal(await keepalive.pingSupabase(env), false);
});

test("ping does nothing when Supabase settings are missing", async () => {
  let called = false;
  restoreFetch = stubFetch(() => { called = true; return jsonResponse([]); });
  assert.equal(await keepalive.pingSupabase({}), false);
  assert.equal(await keepalive.pingSupabase({ SUPABASE_URL: env.SUPABASE_URL }), false);
  assert.equal(called, false);
});

// Cron Trigger 整合：只有每小時排程且在 18:00 UTC 才保活；每 5 分鐘排程與其他小時不會。
async function pingsDuring(cron, scheduledTime) {
  let pings = 0;
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/rest/v1/storefront_variants") pings += 1;
    return jsonResponse([]);
  });
  const context = ctx();
  worker.scheduled({ cron, scheduledTime }, baseEnv, context);
  await context.settle();
  return pings;
}

test("hourly cron at 18:00 UTC pings once", async () => {
  assert.equal(await pingsDuring("0 * * * *", Date.UTC(2026, 9, 1, 18, 0)), 1);
});

test("hourly cron at other hours does not ping", async () => {
  assert.equal(await pingsDuring("0 * * * *", Date.UTC(2026, 9, 1, 12, 0)), 0);
});

test("the 5-minute cron never pings, even at 18:00 UTC", async () => {
  assert.equal(await pingsDuring("*/5 * * * *", Date.UTC(2026, 9, 1, 18, 0)), 0);
});
