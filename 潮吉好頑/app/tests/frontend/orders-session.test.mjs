// 獨立訂單頁登入：沿用分頁內未到期的 token；LINE 內以 LIFF ID token 恢復保存的登入，暫時性故障只重試一次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedAccessToken, forgetAccessToken, rememberAccessToken, restoreOrdersSession } from "../../public/orders-session.js";

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}
const jwt = (expSeconds) => `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const noWait = async () => {};

test("a fresh token in the tab is reused; an expiring one or a forgotten one is not", () => {
  const storage = memoryStorage();
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
  rememberAccessToken(fresh, storage);
  assert.equal(cachedAccessToken(storage), fresh);
  rememberAccessToken(jwt(Math.floor(Date.now() / 1000) + 10), storage);
  assert.equal(cachedAccessToken(storage), null);
  forgetAccessToken(storage);
  assert.equal(cachedAccessToken(storage), null);
});

test("restoring with the LIFF ID token returns the member access token", async () => {
  const calls = [];
  const fetchImpl = async (path, init) => { calls.push([path, JSON.parse(init.body)]); return reply(200, { access_token: "member-token" }); };
  assert.deepEqual(await restoreOrdersSession({ idToken: "id-token", fetchImpl, wait: noWait }), { outcome: "restored", accessToken: "member-token" });
  assert.deepEqual(calls, [["/api/auth/session/restore", { id_token: "id-token" }]]);
});

test("no saved login means the member must sign in on the shop first", async () => {
  const fetchImpl = async () => reply(401, { code: "NO_PERSISTENT_SESSION" });
  assert.deepEqual(await restoreOrdersSession({ idToken: "id-token", fetchImpl, wait: noWait }), { outcome: "failed" });
  assert.deepEqual(await restoreOrdersSession({ idToken: "", fetchImpl, wait: noWait }), { outcome: "failed" });
});

test("a temporary failure is retried once", async () => {
  let count = 0;
  const flaky = async () => (++count === 1 ? reply(503, {}) : reply(200, { access_token: "t" }));
  assert.equal((await restoreOrdersSession({ idToken: "x", fetchImpl: flaky, wait: noWait })).outcome, "restored");
  count = 0;
  const down = async () => { count += 1; throw new Error("offline"); };
  assert.equal((await restoreOrdersSession({ idToken: "x", fetchImpl: down, wait: noWait })).outcome, "retry");
  assert.equal(count, 2);
});
