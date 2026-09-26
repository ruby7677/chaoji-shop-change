// 四個登入／持久登入 bootstrap 路由（LIFF 驗證、LIFF 持久登入 remember／restore、
// 一般瀏覽器 web-session start/refresh）現在是兩層速率限制：
//   1) IP 層（API_AUTH_IP_RATE_LIMITER）：驗證 LINE id_token 或打 Supabase 之前先擋，
//      同一 IP 下的多個使用者不會互相卡住彼此的驗證額度。
//   2) 已驗證身分層（API_MEMBER_RATE_LIMITER）：LINE id_token／Supabase 都驗證成功後，
//      再依驗證後拿到的身分（LINE sub 或 Supabase user id）擋一次，避免單一帳號換 IP 灌爆。
// 被 IP 層擋下時完全不會打任何驗證用的上游 fetch；被身分層擋下時只會打到「驗證身分」
// 那一次 fetch，不會再往下打 Supabase refresh／vault 等後續請求。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, keyedRateLimit, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
const LINE_SUB = "U" + "e".repeat(32);

const authEnvBase = {
  ...baseEnv,
  LIFF_ID: "liff-test-id",
  LINE_LOGIN_CHANNEL_ID: "channel-test-id"
};

let restoreFetch = () => {};
afterEach(() => restoreFetch());

/** Always-allow limiter, used on the layer that must NOT be the one blocking a given test. */
const alwaysAllow = { limit: async () => ({ success: true }) };

function lineVerifyResponse(sub = LINE_SUB) {
  return jsonResponse({ iss: "https://access.line.me", aud: "channel-test-id", sub, exp: Math.floor(Date.now() / 1000) + 3600 });
}

/** Records every fetch call's pathname/hostname so a test can assert exactly how far a request got. */
function stubOnlyLineVerify() {
  const calls = [];
  restoreFetch = stubFetch((url) => {
    calls.push(url.href);
    if (url.hostname === "api.line.me" && url.pathname === "/oauth2/v2.1/verify") return lineVerifyResponse();
    throw new Error(`unexpected request beyond LINE token verification: ${url}`);
  });
  return calls;
}

function post(path, env, body, headers = {}) {
  return worker.fetch(new Request(`https://shop.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  }), env, ctx());
}

const routes = [
  { path: "/api/auth/liff/verify", body: { id_token: "valid-id-token" }, ipKeyPrefix: "liff:", userKeyPrefix: "liff-user:" },
  { path: "/api/auth/session/remember", body: { refresh_token: "refresh-token", id_token: "valid-id-token" }, ipKeyPrefix: "session-remember:", userKeyPrefix: "session-remember-user:" },
  { path: "/api/auth/session/restore", body: { id_token: "valid-id-token" }, ipKeyPrefix: "session-restore:", userKeyPrefix: "session-restore-user:" }
];

for (const { path, body, ipKeyPrefix, userKeyPrefix } of routes) {
  test(`${path}: a denied IP-layer limit returns 429 before any verification fetch`, async () => {
    const ipLimiter = keyedRateLimit(() => true);
    const calls = [];
    restoreFetch = stubFetch((url) => { calls.push(url.href); throw new Error(`unexpected request: ${url}`); });
    const env = { ...authEnvBase, API_AUTH_IP_RATE_LIMITER: ipLimiter, API_MEMBER_RATE_LIMITER: alwaysAllow };
    const response = await post(path, env, body);
    assert.equal(response.status, 429);
    assert.deepEqual(calls, [], "no verification fetch happens when the IP layer denies the request");
    assert.equal(ipLimiter.calls.length, 1);
    assert.ok(ipLimiter.calls[0].startsWith(ipKeyPrefix), `IP-layer key should start with "${ipKeyPrefix}", got "${ipLimiter.calls[0]}"`);
  });

  test(`${path}: a denied per-identity limit returns 429 right after LINE verification, before any further upstream call`, async () => {
    const userLimiter = keyedRateLimit(() => true);
    const calls = stubOnlyLineVerify();
    const env = { ...authEnvBase, API_AUTH_IP_RATE_LIMITER: alwaysAllow, API_MEMBER_RATE_LIMITER: userLimiter };
    const response = await post(path, env, body);
    assert.equal(response.status, 429);
    assert.equal(calls.length, 1, "only the LINE token verification call happens before the per-identity limiter runs");
    assert.equal(userLimiter.calls.length, 1);
    assert.equal(userLimiter.calls[0], `${userKeyPrefix}${LINE_SUB}`, "the per-identity key is keyed by the LINE-verified sub");
  });
}

// web-session start/refresh (src/web-session.ts): 兩層檢查與上面三個路由相同，只是驗證後
// 拿到的身分是 Supabase user id（透過 lineMemberId 確認帶 LINE 身分），不是 LINE sub。
const WEB_SESSION_HEADER = { "X-CJ-Web-Session": "1" };
const WEB_MEMBER_ID = "00000000-0000-4000-8000-0000000000c1";

function stubOnlySupabaseTokenRefresh() {
  const calls = [];
  restoreFetch = stubFetch((url) => {
    calls.push(url.href);
    if (url.pathname === "/auth/v1/token") {
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        user: { id: WEB_MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_SUB } }] }
      });
    }
    throw new Error(`unexpected request beyond Supabase token refresh: ${url}`);
  });
  return calls;
}

test("POST /api/auth/web-session/start: a denied IP-layer limit returns 429 before any Supabase call", async () => {
  const ipLimiter = keyedRateLimit(() => true);
  const calls = [];
  restoreFetch = stubFetch((url) => { calls.push(url.href); throw new Error(`unexpected request: ${url}`); });
  const env = { ...baseEnv, API_AUTH_IP_RATE_LIMITER: ipLimiter, API_MEMBER_RATE_LIMITER: alwaysAllow };
  const response = await post("/api/auth/web-session/start", env, { refresh_token: "oauth-refresh-token" }, WEB_SESSION_HEADER);
  assert.equal(response.status, 429);
  assert.deepEqual(calls, [], "no Supabase call happens when the IP layer denies the request");
  assert.ok(ipLimiter.calls[0].startsWith("web-session-start:"));
});

test("POST /api/auth/web-session/start: a denied per-identity limit returns 429 right after the Supabase refresh confirms a LINE member", async () => {
  const userLimiter = keyedRateLimit(() => true);
  const calls = stubOnlySupabaseTokenRefresh();
  const env = { ...baseEnv, API_AUTH_IP_RATE_LIMITER: alwaysAllow, API_MEMBER_RATE_LIMITER: userLimiter };
  const response = await post("/api/auth/web-session/start", env, { refresh_token: "oauth-refresh-token" }, WEB_SESSION_HEADER);
  assert.equal(response.status, 429);
  assert.equal(calls.length, 1, "only the Supabase token refresh happens before the per-identity limiter runs");
  assert.equal(userLimiter.calls[0], `web-session-start-user:${WEB_MEMBER_ID}`, "the per-identity key is keyed by the verified Supabase user id");
});

test("POST /api/auth/web-session/refresh: a denied per-identity limit returns 429 right after the Supabase refresh confirms a LINE member", async () => {
  // First establish a valid session cookie with both layers open.
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/auth/v1/token") {
      return jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        user: { id: WEB_MEMBER_ID, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_SUB } }] }
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  const openEnv = { ...baseEnv, API_AUTH_IP_RATE_LIMITER: alwaysAllow, API_MEMBER_RATE_LIMITER: alwaysAllow };
  const started = await post("/api/auth/web-session/start", openEnv, { refresh_token: "oauth-refresh-token" }, WEB_SESSION_HEADER);
  assert.equal(started.status, 200);
  const cookie = started.headers.getSetCookie().find((c) => c.startsWith("__Host-cj-web-session="))?.split(";")[0];
  restoreFetch();

  const userLimiter = keyedRateLimit(() => true);
  const calls = stubOnlySupabaseTokenRefresh();
  const env = { ...baseEnv, API_AUTH_IP_RATE_LIMITER: alwaysAllow, API_MEMBER_RATE_LIMITER: userLimiter };
  const response = await worker.fetch(new Request("https://shop.test/api/auth/web-session/refresh", {
    method: "POST",
    headers: { ...WEB_SESSION_HEADER, Cookie: cookie }
  }), env, ctx());
  assert.equal(response.status, 429);
  assert.equal(calls.length, 1, "only the Supabase token refresh happens before the per-identity limiter runs");
  assert.equal(userLimiter.calls[0], `web-session-refresh-user:${WEB_MEMBER_ID}`);
});
