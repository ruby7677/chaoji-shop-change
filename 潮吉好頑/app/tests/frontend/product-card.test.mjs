import test from "node:test";
import assert from "node:assert/strict";
import { productCardMarkup, productPageHref } from "../../public/product-card.js";

const variant = { id: "v-1", product_id: "p-1", name: "UX11-衝擊龍神", category: "UX系列", type: "現貨", price: 1380, stock: 3 };

test("商品頁網址帶商品 ID 與規格 ID，並跳脫特殊字元", () => {
  assert.equal(productPageHref({ id: "a b", product_id: "p/1" }), "/products/p%2F1?v=a%20b");
});

test("有商品 ID 時，商品名稱是可用鍵盤進入的商品頁連結", () => {
  const html = productCardMarkup(variant);
  assert.match(html, /<h3><a class="product-card-link" href="\/products\/p-1\?v=v-1">UX11-衝擊龍神<\/a><\/h3>/);
});

test("示範資料沒有商品 ID 時，名稱維持純文字", () => {
  const html = productCardMarkup({ ...variant, product_id: undefined });
  assert.match(html, /<h3>UX11-衝擊龍神<\/h3>/);
  assert.doesNotMatch(html, /product-card-link/);
});
