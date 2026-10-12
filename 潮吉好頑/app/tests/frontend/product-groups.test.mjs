// 多規格商品在首頁合併成一張卡：最低價「起」、庫存合計、按鈕改成到商品頁選規格；單規格商品不變。
import test from "node:test";
import assert from "node:assert/strict";
import { groupProductCards, productCardFromVariants } from "../../public/product-groups.js";
import { productCardMarkup } from "../../public/product-card.js";

const box = { id: "v-box", product_id: "p-30th", product_name: "30周年(日版原膜盒)", name: "30周年(日版原膜盒)", variant_name: "單一規格", category: "卡牌系列", type: "現貨", price: 6500, stock: 4 };
const pack = { ...box, id: "v-pack", name: "30周年(日版原膜盒) · 單包", variant_name: "單包", price: 350, compare_at_price: 400, stock: 3 };
const other = { id: "v-other", product_id: "p-other", product_name: "陀螺", name: "陀螺", variant_name: "單一規格", category: "BX", type: "現貨", price: 500, stock: 2 };

test("同商品的規格合併成一張卡，單規格商品維持原樣且順序不變", () => {
  const cards = groupProductCards([box, other, pack]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].product_id, "p-30th");
  assert.equal(cards[1], other);
});

test("合併卡：商品名稱、最低價、庫存合計，不顯示單一規格的原價", () => {
  const card = productCardFromVariants([box, pack]);
  assert.equal(card.name, "30周年(日版原膜盒)");
  assert.equal(card.price, 350);
  assert.equal(card.stock, 7);
  assert.equal(card.compare_at_price, null);
  assert.equal(card.price_varies, true);
  assert.equal(card.id, "v-box", "the first in-stock variant leads");
});

test("代表規格：第一個規格沒庫存時改用有庫存的規格", () => {
  assert.equal(productCardFromVariants([{ ...box, stock: 0 }, pack]).id, "v-pack");
  assert.equal(productCardFromVariants([{ ...box, stock: 0 }, { ...pack, stock: 0 }]).stock, 0);
});

test("合併卡的按鈕是「選擇規格」，價格標「起」；單規格卡仍可直接加入購物車", () => {
  const html = productCardMarkup(productCardFromVariants([box, pack]));
  assert.match(html, /data-choose-variant="v-box">選擇規格/);
  assert.doesNotMatch(html, /data-add=/);
  assert.match(html, /NT\$350<small class="price-from"> 起<\/small>/);
  const single = productCardMarkup(other);
  assert.match(single, /data-add="v-other"/);
  assert.doesNotMatch(single, /price-from/);
  assert.match(productCardMarkup(productCardFromVariants([{ ...box, stock: 0 }, { ...pack, stock: 0 }])), />查看規格</);
});
