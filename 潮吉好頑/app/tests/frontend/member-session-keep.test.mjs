// 會員登入只在確定失效時清除：Supabase 暫時故障（網路、限流、5xx）保留登入與 OAuth refresh token。
// member-profile.js／liff-session.js 依賴完整 DOM 與 LIFF，這裡以原始碼檢查分流條件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../../public/${name}`, import.meta.url), "utf8");

test("loadMember logs out only when Supabase rejects the token", async () => {
  const source = await read("member-profile.js");
  const body = source.slice(source.indexOf("export function loadMember()"), source.indexOf("async function loadProfile()"));
  assert.match(body, /if \(response\.status === 401 \|\| response\.status === 403\) throw new MemberSessionRejected\(\);/);
  assert.match(body, /if \(error instanceof MemberSessionRejected\) \{ clearStoredAuthSession\(\); return; \}/);
  assert.equal(body.match(/clearStoredAuthSession\(\)/g).length, 1, "no other failure clears the session");
  assert.match(body, /memberLoadResolved = result !== MEMBER_LOAD_RETRY;/, "a transient failure lets a later call retry");
});

test("ensureWebSession drops the OAuth refresh token only on a definite rejection", async () => {
  const source = await read("liff-session.js");
  const body = source.slice(source.indexOf("export async function ensureWebSession()"), source.indexOf("export async function renewWebSession()"));
  assert.match(body, /else if \(!retryable\) \{ auth\.refreshToken = null;/);
});

test("checkout retries a member load that failed temporarily before sending the member to LINE login", async () => {
  const source = await read("checkout-flow.js");
  const body = source.slice(source.indexOf("export async function openCheckout"), source.indexOf("export function showCheckoutError"));
  assert.ok(body.indexOf("await loadMember();") >= 0);
  assert.ok(body.indexOf("await loadMember()") < body.indexOf("return beginLineLogin()"), "the retry runs before the login redirect");
  const afterReload = body.slice(body.indexOf("await loadMember();"), body.indexOf("return beginLineLogin()"));
  assert.ok(afterReload.includes('if (auth.accessToken && !auth.user) return showToast("會員資料暫時無法載入，請稍後再試", "warning");'), "a second temporary failure stays on the page");
});

test("expiry handling receives restored, failed or retry instead of a boolean", async () => {
  const app = await read("app.js");
  assert.ok(app.includes("tryRestore: () => (liffState.isInClient ? renewLiffSession() : renewWebSession()),"));
  const source = await read("liff-session.js");
  const web = source.slice(source.indexOf("export async function renewWebSession()"), source.indexOf("function acceptWebSession"));
  assert.ok(web.indexOf("const started = await startWebSession(auth.refreshToken);") < web.indexOf("await refreshWebSessionOutcome()"), "a kept OAuth token is handed to start first");
  assert.ok(web.includes('return retryable ? "retry" : "failed";'));
});

test("boot uses the config inlined in the page before requesting /api/config", async () => {
  const source = await read("liff-session.js");
  const body = source.slice(source.indexOf("export async function loadRuntimeConfig()"), source.indexOf("export function readLiffLaunchContext()"));
  assert.ok(body.indexOf("takeEmbeddedConfig()") >= 0 && body.indexOf("takeEmbeddedConfig()") < body.indexOf('fetch("/api/config")'), "inline first, request as fallback");
});
