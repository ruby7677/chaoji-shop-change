// 訪客購物車只存商品 id，開機時必須等正式型錄載入後才還原；
// 先還原會只對到內建示範商品，真實商品全被濾掉（重新整理或 LINE 登入回來購物車就清空）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../public/app.js", import.meta.url), "utf8");
const boot = source.slice(source.indexOf("async function bootstrapAuth"), source.indexOf("startAuthBoot();"));

test("the local cart is restored after the catalog loads and before the first render", () => {
  const loadProducts = boot.indexOf("await loadProducts()");
  const loadCart = boot.indexOf("loadLocalCart()");
  const firstRender = boot.indexOf("renderInitialPageOnce()");
  assert.ok(loadProducts > 0, "bootstrap loads the catalog");
  assert.equal(boot.split("loadLocalCart()").length - 1, 1, "the cart is restored exactly once");
  assert.ok(loadCart > loadProducts, "cart restore waits for the catalog");
  assert.ok(loadCart < firstRender, "cart is restored before the first render");
});
