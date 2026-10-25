// 登入過期或 LINE 授權失效時，好友檢查不再顯示成「未加入官方 LINE」：分流到換發或重新 LINE 登入，並提供登出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FRIENDSHIP_LINE_RELOGIN, FRIENDSHIP_SESSION_EXPIRED, lineFriendshipFailureKind } from "../../public/line-friendship-failure.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("a site session 401 is a session expiry, not a missing friendship", () => {
  assert.equal(lineFriendshipFailureKind(401, { error: "登入已過期，請重新登入" }), FRIENDSHIP_SESSION_EXPIRED);
});

test("an expired or mismatched LINE authorisation asks for LINE login again", () => {
  assert.equal(lineFriendshipFailureKind(401, { code: "LINE_LOGIN_EXPIRED" }), FRIENDSHIP_LINE_RELOGIN);
  assert.equal(lineFriendshipFailureKind(401, { code: "LINE_IDENTITY_MISMATCH" }), FRIENDSHIP_LINE_RELOGIN);
  assert.equal(lineFriendshipFailureKind(403, {}), FRIENDSHIP_LINE_RELOGIN);
});

test("a missing LINE token (new tab restored from the cookie) asks for LINE login instead of claiming not a friend", () => {
  assert.equal(lineFriendshipFailureKind(200, { friendFlag: false, reason: "LINE_PROVIDER_TOKEN_REQUIRED" }), FRIENDSHIP_LINE_RELOGIN);
  assert.equal(lineFriendshipFailureKind(200, { friendFlag: false, reason: "LINE_ID_MISSING" }), FRIENDSHIP_LINE_RELOGIN);
});

test("a real non-friend and temporary outages are not re-login cases", () => {
  assert.equal(lineFriendshipFailureKind(200, { friendFlag: false, source: "line_login" }), null);
  assert.equal(lineFriendshipFailureKind(200, { friendFlag: true, source: "cached" }), null);
  assert.equal(lineFriendshipFailureKind(503, { error: "LINE 好友狀態暫時無法確認" }), null);
});

test("the Worker sends the codes the classifier relies on", async () => {
  const source = await read("src/member-api.ts");
  assert.ok(source.includes('code: "LINE_LOGIN_EXPIRED"'));
  assert.ok(source.includes('code: "LINE_IDENTITY_MISMATCH"'));
  assert.ok(source.includes('reason: "LINE_PROVIDER_TOKEN_REQUIRED"'));
});

test("a session expiry renews before retrying and falls back to the re-login dialog", async () => {
  const source = await read("public/member-benefits.js");
  const body = source.slice(source.indexOf("export async function ensureLineFriendship"), source.indexOf("export async function checkLineFriendship"));
  assert.ok(body.indexOf("await handleSessionExpired()") >= 0);
  assert.ok(body.indexOf("await handleSessionExpired()") < body.indexOf("friendOrPrompt({ force: true, notFriendMessage })"), "renews before the retry");
  assert.ok(body.includes("showLineReloginDialog("));
  assert.match(source, /export function requireLineFriendshipForCheckout\(\) \{\r?\n  return ensureLineFriendship\(\);/);
});

test("the friend dialog has a re-login button wired to LINE login, and the profile dialog has logout", async () => {
  const html = await read("public/index.html");
  assert.match(html, /<button class="primary-button hidden" type="button" data-line-relogin>/);
  assert.match(html, /<button class="text-button profile-logout hidden" type="button" data-member-logout>登出<\/button>/);
  const app = await read("public/app.js");
  assert.ok(app.includes('if (event.target.closest("[data-line-relogin]")) { closeDialog(document.querySelector("#line-friend-dialog")); beginLineLogin(); }'));
  assert.ok(app.includes('if (event.target.closest("[data-member-logout]")) logoutMember();'));
});

test("logout clears the renewal cookie before dropping local tokens, and stays logged in if that fails", async () => {
  const source = await read("public/member-profile.js");
  const body = source.slice(source.indexOf("export async function logoutMember()"), source.indexOf("export async function saveProfile"));
  assert.ok(body.indexOf("await endWebSession()") < body.indexOf("clearStoredAuthSession()"));
  assert.ok(body.includes('showToast("登出未完成，請確認網路連線後再試", "warning");'));
});

test("checkout renews an expired token before deciding to send the member to LINE login", async () => {
  const source = await read("public/checkout-flow.js");
  const body = source.slice(source.indexOf("export async function openCheckout"), source.indexOf("export function showCheckoutError"));
  assert.ok(body.indexOf("await ensureFreshSession();") >= 0);
  assert.ok(body.indexOf("await ensureFreshSession();") < body.indexOf("return beginLineLogin()"));
});

test("the admin order list keeps orders the server matched by product or variant name", async () => {
  const source = await read("public/admin-orders-panel.js");
  const body = source.slice(source.indexOf("export function renderAdminOrders()"), source.indexOf("if (!orders.length)"));
  assert.ok(body.includes("item.product_name") && body.includes("item.variant_name"));
  assert.ok(body.includes("${itemNames}`.toLowerCase()"));
});
