// 訪客購物車只存商品 id，開機時必須等正式型錄載入後才還原；
// 先還原會只對到內建示範商品，真實商品全被濾掉（重新整理或 LINE 登入回來購物車就清空）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
const boot = source.slice(source.indexOf("async function bootstrapAuth"), source.indexOf("startAuthBoot();"));

test("the local cart is restored after the catalog loads and before the first render", () => {
  const loadProducts = boot.indexOf("await catalogLoading");
  const loadCart = boot.indexOf("loadLocalCart()");
  const firstRender = boot.indexOf("renderInitialPageOnce()");
  assert.ok(loadProducts > 0, "bootstrap loads the catalog");
  assert.equal(boot.split("loadLocalCart()").length - 1, 1, "the cart is restored exactly once");
  assert.ok(loadCart > loadProducts, "cart restore waits for the catalog");
  assert.ok(loadCart < firstRender, "cart is restored before the first render");
});

test("the catalog request starts before config and LIFF login, and the hero image no longer blocks the boot screen", () => {
  const catalogStart = boot.indexOf("loadProducts()");
  assert.ok(catalogStart > 0 && catalogStart < boot.indexOf("await loadRuntimeConfig()"), "catalog starts before config");
  assert.ok(catalogStart < boot.indexOf("await initializeLiffStage"), "catalog starts before LIFF init");
  assert.ok(boot.indexOf("await catalogLoading") > boot.indexOf("initializeLiffBridge"), "the LIFF bridge starts before rendering");
  assert.ok(!source.includes("waitForHeroImageDecode"), "hero decode wait removed");
});

test("a failed catalog shows a reload prompt instead of demo products and leaves saved carts untouched", async () => {
  const catalog = await readFile(new URL("../../public/storefront-catalog.js", import.meta.url), "utf8");
  const cartSource = await readFile(new URL("../../public/cart.js", import.meta.url), "utf8");
  assert.match(catalog, /export let products = \[\];/);
  assert.match(catalog, /data-catalog-retry/);
  for (const fn of ["export function loadLocalCart()", "async function runLoadMemberCart("]) {
    const body = cartSource.slice(cartSource.indexOf(fn), cartSource.indexOf(fn) + 300);
    assert.match(body, /if \(!catalogLoaded\) return;/, fn);
  }
});

test("LINE login restores in the background after the page shows, without an automatic OAuth redirect", async () => {
  assert.ok(boot.indexOf("await liffBridge") > boot.indexOf("finishAuthBoot()"), "login restore no longer blocks the boot screen");
  assert.ok(boot.indexOf("initializeLiffBridge(") < boot.indexOf("await catalogLoading"), "the bridge still starts right after liff.init");
  assert.ok(boot.indexOf("markAuthSettled()") > boot.indexOf("await loadMember()"), "auth settles after the member loads");
  assert.ok(boot.indexOf("markAuthSettled()") < boot.indexOf("await restoreAuthReturnState()"), "auth settles before a resumed checkout waits on it");
  assert.match(source.slice(source.indexOf("await bootstrapAuth();")), /catch \(error\) \{\s*markAuthSettled\(\);/, "a failed boot never leaves buttons waiting");
  const liffSession = await readFile(new URL("../../public/liff-session.js", import.meta.url), "utf8");
  assert.ok(!liffSession.includes("beginLineLogin({ automatic: true })"), "the bridge never starts OAuth on its own");
});
test("login, checkout and my-orders wait for the background login before deciding the member is logged out", async () => {
  const memberEntry = source.slice(source.indexOf("async function openMemberEntry"));
  assert.ok(memberEntry.indexOf("if (memberEntryPending) return;") < memberEntry.indexOf("await whenAuthReady()"), "repeated taps while waiting start only one login");
  assert.ok(memberEntry.indexOf("await whenAuthReady()") < memberEntry.indexOf("beginLineLogin()"), "the member button waits for the background login");
  for (const [file, fn] of [["checkout-flow.js", "export async function openCheckout"], ["member-orders.js", "export async function openOrders"]]) {
    const text = await readFile(new URL(`../../public/${file}`, import.meta.url), "utf8");
    const body = text.slice(text.indexOf(fn));
    assert.ok(body.indexOf("await whenAuthReady()") > 0 && body.indexOf("await whenAuthReady()") < body.indexOf("beginLineLogin()"), file);
  }
});

test("checkout snapshots the cart only after the background login and member cart merge finish", async () => {
  const text = await readFile(new URL("../../public/checkout-flow.js", import.meta.url), "utf8");
  const body = text.slice(text.indexOf("export async function openCheckout"));
  assert.ok(body.indexOf("await whenAuthReady()") < body.indexOf("cartGroups()"), "wait before reading the cart");
  assert.ok(body.indexOf("await whenAuthReady()") < body.indexOf("activeCheckoutItems = "), "wait before the snapshot");
  assert.ok(body.indexOf("await settleMemberCart()") > 0 && body.indexOf("await settleMemberCart()") < body.indexOf("cartGroups()"), "a pending member cart merge finishes before the snapshot");
});

test("member cart sync waits for the first merge, and LINE logins keep the LIFF callback marker", async () => {
  const cartSource = await readFile(new URL("../../public/cart.js", import.meta.url), "utf8");
  assert.match(cartSource, /cartSyncUserId === auth\.user\.id\);/);
  for (const fn of ["function scheduleMemberCartSync()", "export async function syncMemberCartNow"]) {
    const body = cartSource.slice(cartSource.indexOf(fn), cartSource.indexOf(fn) + 120);
    assert.match(body, /if \(!memberCartReady\(\)\) \{/, fn);
  }
  const profile = await readFile(new URL("../../public/member-profile.js", import.meta.url), "utf8");
  assert.match(profile, /if \(automatic \|\| liffState\.isInClient\) redirectUrl\.searchParams\.set\(LIFF_AUTO_CALLBACK_PARAM/);
});

test("a failed first member cart load is retried on later cart changes instead of disabling sync for the session", async () => {
  const cartSource = await readFile(new URL("../../public/cart.js", import.meta.url), "utf8");
  assert.match(cartSource, /if \(!memberCartReady\(\)\) \{ retryMemberCartMerge\(\); return; \}/);
  assert.match(cartSource, /if \(!memberCartReady\(\)\) \{ await retryMemberCartMerge\(\); return; \}/);
  assert.match(cartSource, /catch \(error\) \{\s*memberCartLoadFailed = true;/);
  assert.match(source, /addEventListener\("pageshow", \(event\) => \{ if \(event\.persisted\) memberEntryPending = false; \}\)/, "bfcache restore unlocks the login button");
});

test("waiting for the background login is bounded", async () => {
  const ready = await readFile(new URL("../../public/auth-ready.js", import.meta.url), "utf8");
  assert.match(ready, /Promise\.race\(\[settledPromise, new Promise\(\(resolve\) => setTimeout\(resolve, AUTH_READY_TIMEOUT_MS\)\)\]\)/);
});
