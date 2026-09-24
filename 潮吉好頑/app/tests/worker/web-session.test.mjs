// 一般瀏覽器登入續期（src/web-session.ts）：cookie 屬性、加密、12 小時上限與各種失敗處理。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, ctx, jsonResponse, lineUser, loadWorker, stubFetch } from "./harness.mjs";

const worker = await loadWorker();
let supabase;
let restoreFetch;
let realNow;

beforeEach(() => {
  supabase = { mode: "ok", user: lineUser("user-1"), calls: [], rotation: 0 };
  realNow = Date.now;
  restoreFetch = stubFetch((url, _init, body) => {
    assert.equal(url.pathname, "/auth/v1/token", "only the Supabase token endpoint is called");
    supabase.calls.push(body.refresh_token);
    if (supabase.mode === "down") return jsonResponse({}, 503);
    if (supabase.mode === "reject") return jsonResponse({ error: "invalid_grant" }, 400);
    supabase.rotation += 1;
    return jsonResponse({ access_token: `access-${supabase.rotation}`, refresh_token: `refresh-token-${supabase.rotation}`, expires_in: 3600, user: supabase.user });
  });
});

afterEach(() => {
  restoreFetch();
  Date.now = realNow;
});

function call(path, { body = {}, cookie, header = true, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (header) headers["X-CJ-Web-Session"] = "1";
  if (cookie) headers.Cookie = cookie;
  return worker.fetch(new Request(`https://shop.test${path}`, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), baseEnv, ctx());
}

const setCookies = (response) => response.headers.getSetCookie();
const sessionCookie = (response) => setCookies(response).find((cookie) => cookie.startsWith("__Host-cj-web-session="))?.split(";")[0];
const isCleared = (response) => setCookies(response).length === 2 && setCookies(response).every((cookie) => cookie.includes("Max-Age=0"));

async function startSession() {
  const response = await call("/api/auth/web-session/start", { body: { refresh_token: "oauth-refresh-token" } });
  assert.equal(response.status, 200);
  return { response, body: await response.json(), cookie: sessionCookie(response) };
}

test("start requires the custom CSRF header", async () => {
  const response = await call("/api/auth/web-session/start", { body: { refresh_token: "x" }, header: false });
  assert.equal(response.status, 400);
  assert.equal(supabase.calls.length, 0);
});

test("start rotates the OAuth token once and sets an encrypted browser-session cookie", async () => {
  const { response, body } = await startSession();
  assert.equal(body.access_token, "access-1");
  assert.equal(body.user_id, "user-1");
  assert.deepEqual(supabase.calls, ["oauth-refresh-token"]);
  assert.ok(!JSON.stringify(body).includes("refresh-token"), "response body never exposes a refresh token");
  const [session, hint] = setCookies(response);
  assert.match(session, /^__Host-cj-web-session=w1\./);
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Strict/);
  assert.doesNotMatch(session, /Max-Age|Expires/, "browser-session cookie ends when the browser closes");
  assert.ok(!session.includes("refresh-token-1"), "cookie is encrypted");
  assert.equal(hint, "__Host-cj-web-hint=1; Path=/; Secure; SameSite=Strict");
});

test("refresh renews with the rotated token and keeps the original 12-hour deadline", async () => {
  const started = await startSession();
  const response = await call("/api/auth/web-session/refresh", { cookie: started.cookie });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.access_token, "access-2");
  assert.equal(supabase.calls.at(-1), "refresh-token-1");
  assert.equal(body.session_expires_at, started.body.session_expires_at);
  assert.notEqual(sessionCookie(response), started.cookie);
});

test("renewals stop 11 hours after login so the last access token ends within 12 hours", async () => {
  const { cookie } = await startSession();
  const loginAt = realNow();
  Date.now = () => loginAt + (10 * 60 + 59) * 60_000;
  const renewed = await call("/api/auth/web-session/refresh", { cookie });
  assert.equal(renewed.status, 200);
  Date.now = () => loginAt + 11 * 3_600_000;
  const callsBefore = supabase.calls.length;
  const expired = await call("/api/auth/web-session/refresh", { cookie: sessionCookie(renewed) });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).code, "WEB_SESSION_EXPIRED");
  assert.ok(isCleared(expired));
  assert.equal(supabase.calls.length, callsBefore, "an expired session never reaches Supabase");
});

test("a Supabase outage returns 503 and keeps the cookie", async () => {
  const { cookie } = await startSession();
  supabase.mode = "down";
  const response = await call("/api/auth/web-session/refresh", { cookie });
  assert.equal(response.status, 503);
  assert.equal(setCookies(response).length, 0);
});

test("a rejected refresh token clears the cookie", async () => {
  const { cookie } = await startSession();
  supabase.mode = "reject";
  const response = await call("/api/auth/web-session/refresh", { cookie });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "INVALID_WEB_SESSION");
  assert.ok(isCleared(response));
});

test("missing, tampered and LIFF-format cookies are rejected", async () => {
  const { cookie } = await startSession();
  const missing = await call("/api/auth/web-session/refresh");
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).code, "NO_WEB_SESSION");
  const tampered = await call("/api/auth/web-session/refresh", { cookie: cookie.slice(0, -4) + "AAAA" });
  assert.equal(tampered.status, 401);
  assert.ok(isCleared(tampered));
  const liffFormat = await call("/api/auth/web-session/refresh", { cookie: "__Host-cj-web-session=v1.abc.def" });
  assert.equal(liffFormat.status, 401);
});

test("a token that now belongs to another user is rejected", async () => {
  const { cookie } = await startSession();
  supabase.user = lineUser("someone-else");
  const response = await call("/api/auth/web-session/refresh", { cookie });
  assert.equal(response.status, 401);
  assert.ok(isCleared(response));
});

test("non-LINE accounts cannot start a web session", async () => {
  supabase.user = { id: "user-1", identities: [{ provider: "email", identity_data: {} }] };
  const response = await call("/api/auth/web-session/start", { body: { refresh_token: "email-token" } });
  assert.equal(response.status, 403);
  assert.ok(isCleared(response));
});

test("only POST is routed", async () => {
  const response = await call("/api/auth/web-session/refresh", { method: "GET" });
  assert.equal(response.status, 404);
});
