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
  assert.ok(boot.indexOf("await catalogLoading") > boot.indexOf("initializeLiffBridge"), "rendering still waits for the LIFF bridge");
  assert.ok(!source.includes("waitForHeroImageDecode"), "hero decode wait removed");
});

test("a failed catalog shows a reload prompt instead of demo products and leaves saved carts untouched", async () => {
  const catalog = await readFile(new URL("../../public/storefront-catalog.js", import.meta.url), "utf8");
  const cartSource = await readFile(new URL("../../public/cart.js", import.meta.url), "utf8");
  assert.match(catalog, /export let products = \[\];/);
  assert.match(catalog, /data-catalog-retry/);
  for (const fn of ["export function loadLocalCart()", "export async function loadMemberCart()"]) {
    const body = cartSource.slice(cartSource.indexOf(fn), cartSource.indexOf(fn) + 300);
    assert.match(body, /if \(!catalogLoaded\) return;/, fn);
  }
});
