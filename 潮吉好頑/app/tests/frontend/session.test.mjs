// 前端登入續期（public/web-session.js、public/auth-expiry.js）：以最小的瀏覽器全域物件在 Node 執行。
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const timers = [];
const intervals = [];
const listeners = {};
const windowListeners = {};
globalThis.window = {
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  clearTimeout: () => {},
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  addEventListener: (type, fn) => { windowListeners[type] = fn; }
};
globalThis.document = {
  cookie: "",
  visibilityState: "visible",
  addEventListener: (type, fn) => { listeners[type] = fn; },
  querySelector: () => null,
  querySelectorAll: () => []
};
let lockRequests = 0;
Object.defineProperty(globalThis, "navigator", {
  value: { locks: { request: async (_name, fn) => { lockRequests += 1; return fn(); } } },
  configurable: true
});
let fetches = [];
let reply = { status: 200, body: { access_token: "new-access", user_id: "user-1" } };
globalThis.fetch = async (path, init) => {
  fetches.push({ path, init });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Response(JSON.stringify(reply.body), { status: reply.status });
};

const webSession = await import("../../public/web-session.js");
const authExpiry = await import("../../public/auth-expiry.js");

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jwt = (expSeconds) => "header." + Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url") + ".signature";

beforeEach(() => {
  fetches = [];
  lockRequests = 0;
  reply = { status: 200, body: { access_token: "new-access", user_id: "user-1" } };
  document.cookie = "";
});

test("no hint cookie means no renewal request", async () => {
  assert.equal(await webSession.refreshWebSession(), null);
  assert.equal(fetches.length, 0);
});

test("concurrent renewals share one request under a Web Lock and send the CSRF header", async () => {
  document.cookie = "other=1; __Host-cj-web-hint=1";
  const [first, second] = await Promise.all([webSession.refreshWebSession(), webSession.refreshWebSession()]);
  assert.equal(fetches.length, 1);
  assert.equal(lockRequests, 1);
  assert.equal(first, second);
  assert.equal(first.access_token, "new-access");
  assert.equal(fetches[0].path, "/api/auth/web-session/refresh");
  assert.equal(fetches[0].init.method, "POST");
  assert.equal(fetches[0].init.headers["X-CJ-Web-Session"], "1");
});

test("a failed renewal resolves to null", async () => {
  document.cookie = "__Host-cj-web-hint=1";
  reply = { status: 401, body: { code: "WEB_SESSION_EXPIRED" } };
  assert.equal(await webSession.refreshWebSession(), null);
});

for (const [status, retryable] of [[503, true], [429, true], [401, false]]) {
  test(`a ${status} renewal reports retryable=${retryable} so expiry handling can keep the session`, async () => {
    document.cookie = "__Host-cj-web-hint=1";
    reply = { status, body: { error: "x" } };
    assert.deepEqual(await webSession.refreshWebSessionOutcome(), { session: null, retryable });
  });
}

test("startWebSession posts the OAuth refresh token once and ignores empty input", async () => {
  assert.deepEqual(await webSession.startWebSession(null), { session: null, retryable: false });
  assert.equal(fetches.length, 0);
  const { session } = await webSession.startWebSession("oauth-token");
  assert.equal(session.access_token, "new-access");
  assert.equal(fetches[0].path, "/api/auth/web-session/start");
  assert.deepEqual(JSON.parse(fetches[0].init.body), { refresh_token: "oauth-token" });
});

for (const [status, retryable] of [[503, true], [429, true], [401, false], [403, false]]) {
  test(`a ${status} start ${retryable ? "is retryable so the OAuth token is kept" : "is a definite rejection"}`, async () => {
    reply = { status, body: { error: "x" } };
    assert.deepEqual(await webSession.startWebSession("oauth-token"), { session: null, retryable });
  });
}

test("a network failure on start is retryable", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try { assert.deepEqual(await webSession.startWebSession("oauth-token"), { session: null, retryable: true }); }
  finally { globalThis.fetch = realFetch; }
});

// auth-expiry keeps module state, so these run in order against one set of deps.
test("auth-expiry renews early, keeps a still-valid session on a failed early renewal, and logs out on 401", async () => {
  let token = jwt(nowSeconds() + 3600);
  let restoreResult = false;
  let cleared = 0;
  const toasts = [];
  authExpiry.initAuthExpiry({
    getAccessToken: () => token,
    tryRestore: async () => {
      if (restoreResult === true) token = jwt(nowSeconds() + 7200);
      return restoreResult;
    },
    clearSession: () => { cleared += 1; token = null; },
    closeDialog: () => {},
    showToast: (message) => toasts.push(message)
  });

  authExpiry.watchSessionExpiry();
  const scheduled = timers.at(-1).ms;
  assert.ok(scheduled > 3_600_000 - 62_000 && scheduled < 3_600_000 - 58_000, `renewal is scheduled about a minute early (${scheduled})`);
  assert.equal(authExpiry.accessTokenExpiresSoon(token), false);
  assert.equal(authExpiry.accessTokenExpiresSoon(jwt(nowSeconds() + 30)), true);

  token = jwt(nowSeconds() + 30);
  await authExpiry.handleSessionExpired({ early: true });
  assert.equal(cleared, 0, "a failed early renewal does not log out while the token is valid");
  assert.equal(toasts.length, 0);
  assert.ok(timers.at(-1).ms > 25_000 && timers.at(-1).ms <= 30_000, "retries at the real expiry");

  restoreResult = true;
  await authExpiry.handleSessionExpired({ early: true });
  assert.equal(cleared, 0);
  assert.equal(authExpiry.accessTokenExpiresSoon(token), false, "a successful renewal swaps in a fresh token");

  restoreResult = false;
  token = jwt(nowSeconds() + 3000);
  await authExpiry.handleSessionExpired();
  assert.equal(cleared, 1, "an API 401 logs out when renewal fails even if the clock says valid");
  assert.ok(toasts.includes("登入已過期，請重新登入"));

  // 暫時故障（"retry"）：token 已到期也不登出，提示一次並排程重試
  token = jwt(nowSeconds() - 10);
  restoreResult = "retry";
  await authExpiry.handleSessionExpired();
  assert.equal(cleared, 1, "a temporary renewal failure keeps the session");
  assert.equal(timers.at(-1).ms, authExpiry.RENEW_RETRY_MS, "the renewal is retried later");
  await authExpiry.handleSessionExpired();
  assert.equal(toasts.filter((message) => message.includes("稍後會自動重試")).length, 1, "the retry notice is shown once");
  restoreResult = true;
  await authExpiry.handleSessionExpired();
  assert.equal(cleared, 1);
  assert.equal(authExpiry.accessTokenExpiresSoon(token), false, "a later successful retry restores the session");

  restoreResult = false;
  token = jwt(nowSeconds() - 10);
  listeners.visibilitychange();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleared, 2, "returning to a tab after expiry logs out");

  // 分頁一直在前景（電腦休眠後）：沒有 visibilitychange，靠視窗焦點與每分鐘檢查
  assert.equal(intervals.at(-1).ms, authExpiry.EXPIRY_CHECK_INTERVAL_MS);
  token = jwt(nowSeconds() - 10);
  intervals.at(-1).fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleared, 3, "the periodic check logs out an expired session on a foreground tab");
  token = jwt(nowSeconds() - 10);
  windowListeners.focus();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleared, 4, "focusing the window checks expiry");
  token = jwt(nowSeconds() + 3600);
  windowListeners.pageshow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cleared, 4, "a valid token is left alone");

  // 結帳前：已到期先換發，成功就拿到新 token
  token = jwt(nowSeconds() - 10);
  restoreResult = true;
  await authExpiry.ensureFreshSession();
  assert.equal(cleared, 4);
  assert.equal(authExpiry.accessTokenExpiresSoon(token), false, "ensureFreshSession renews an expired token before checkout");
});
