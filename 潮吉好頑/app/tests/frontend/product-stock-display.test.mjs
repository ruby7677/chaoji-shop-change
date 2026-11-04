// 前台庫存文字依規格的「前台顯示庫存」（show_stock）：勾選才顯示數量；舊型錄快取沒有欄位時依類型預設（預購顯示、現貨不顯示）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { preorderStockMarkup, productAvailability, showsStock } from "../../public/product-format.js";
import { productCardMarkup } from "../../public/product-card.js";

const stockItem = (fields = {}) => ({ id: "v1", name: "陀螺", category: "BX系列", type: "現貨", price: 500, stock: 8, ...fields });
const preorderItem = (fields = {}) => ({ id: "v2", name: "預購陀螺", category: "BX系列", type: "預購", price: 900, stock: 20, preorder_arrival: "11 月下旬", ...fields });

test("in-stock items show the count only when show_stock is checked", () => {
  assert.equal(productAvailability(stockItem({ show_stock: false })), "", "hidden in-stock count leaves no duplicate 現貨 line");
  assert.equal(productAvailability(stockItem({ show_stock: true })), "現貨 8 件");
  assert.equal(preorderStockMarkup(stockItem({ show_stock: true })), "", "in-stock items never get the preorder limit line");
});

test("preorder items show the limited quantity only when show_stock is checked", () => {
  assert.equal(preorderStockMarkup(preorderItem({ show_stock: true })), '<p class="preorder-stock">預購限量 20 件</p>');
  assert.equal(preorderStockMarkup(preorderItem({ show_stock: false })), "");
  assert.equal(productAvailability(preorderItem({ show_stock: false })), "預購 · 11 月下旬", "arrival text stays");
});

test("a catalog without show_stock falls back to the kind default", () => {
  assert.equal(showsStock(stockItem()), false);
  assert.equal(showsStock(preorderItem()), true);
  assert.equal(showsStock({ kind: "preorder" }), true);
});

test("hiding the count does not hide the sold-out state on the product card", () => {
  const card = productCardMarkup(stockItem({ stock: 0, show_stock: false }));
  assert.ok(!card.includes("0 件"), "no count on the card");
  assert.ok(card.includes("已售完"), "the card still shows the item is sold out");
});
