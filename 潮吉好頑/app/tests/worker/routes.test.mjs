// 路由層級的安全預設：受保護 API 未登入一律 401 且不碰外部服務、未知 API 404、過大 body 413、安全 header。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const ORDER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
let restoreFetch = () => {};
afterEach(() => restoreFetch());

const request = (method, path, init = {}) => worker.fetch(new Request(`https://shop.test${path}`, { method, ...init }), baseEnv, ctx());

const protectedRoutes = [
  ["GET", "/api/orders"],
  ["POST", "/api/orders"],
  ["GET", "/api/cart"],
  ["PUT", "/api/cart"],
  ["GET", "/api/bank-accounts"],
  ["GET", "/api/member/points"],
  ["POST", `/api/orders/${ORDER_ID}/payment`],
  ["GET", "/api/admin/dashboard"],
  ["GET", "/api/admin/audit-logs"],
  ["GET", "/api/admin/notification-deliveries"],
  ["POST", `/api/admin/orders/${ORDER_ID}/transition`],
  ["PATCH", `/api/admin/orders/${ORDER_ID}/fulfillment`],
  ["POST", "/api/admin/telegram-test"],
  ["POST", "/api/admin/products"],
  ["POST", `/api/admin/variants/${ORDER_ID}/inventory`],
  ["PUT", "/api/admin/point-settings"],
  ["POST", `/api/admin/members/${ORDER_ID}/points`]
];

for (const [method, path] of protectedRoutes) {
  test(`${method} ${path} requires login`, async () => {
    const outbound = [];
    restoreFetch = stubFetch((url) => { outbound.push(url.href); return new Response("{}"); });
    const body = ["POST", "PUT", "PATCH"].includes(method) ? JSON.stringify({}) : undefined;
    const response = await request(method, path, { body, headers: { "Content-Type": "application/json" } });
    assert.equal(response.status, 401);
    assert.deepEqual(outbound, [], "an anonymous request never reaches Supabase or LINE");
  });
}

test("unknown API paths return 404 instead of the SPA", async () => {
  const response = await request("GET", "/api/does-not-exist");
  assert.equal(response.status, 404);
});

test("oversized JSON bodies are rejected before any work", async () => {
  const response = await request("POST", "/api/orders", {
    body: "{}",
    headers: { "Content-Type": "application/json", "Content-Length": String(129 * 1024) }
  });
  assert.equal(response.status, 413);
});

test("JSON responses carry the security headers and no-store", async () => {
  const response = await request("GET", "/api/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'self'/);
  assert.doesNotMatch(response.headers.get("Content-Security-Policy"), /unsafe-inline/);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});
