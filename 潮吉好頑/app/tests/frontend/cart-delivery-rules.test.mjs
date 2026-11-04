// 商品可用取貨方式的前台規則：同組商品只顯示共同允許的方式、沒有共同方式時提示、缺欄位視為全開、標籤與購物車畫面。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_DELIVERY_METHODS, allowedDeliveryMethods, deliveryConflictMessage, deliveryMethodError, deliveryRestrictionLabel, itemDeliveryMethods, resolveDeliveryMethod
} from "../../public/cart-delivery-rules.js";
import { cartGroupMarkup, cartItemMarkup } from "../../public/cart-markup.js";
import { productTagMarkup } from "../../public/product-format.js";

const open = { id: "a", name: "一般商品", product_name: "一般商品", price: 100, quantity: 1, category: "卡", type: "現貨" };
const homeOrStore = { ...open, id: "b", name: "大型商品 · 單一規格", product_name: "大型商品", allowed_delivery_methods: ["home_delivery", "store_pickup"] };
const cvsOnly = { ...open, id: "c", name: "小物", product_name: "小物", allowed_delivery_methods: ["cvs_delivery"] };

test("欄位缺少、格式不明或沒有有效值時視為三種全開", () => {
  for (const item of [{}, { allowed_delivery_methods: null }, { allowed_delivery_methods: "home_delivery" }, { allowed_delivery_methods: [] }, { allowed_delivery_methods: ["teleport"] }]) {
    assert.deepEqual(itemDeliveryMethods(item), ALL_DELIVERY_METHODS);
  }
});

test("單一商品依固定順序回傳允許的方式，忽略未知值", () => {
  assert.deepEqual(itemDeliveryMethods({ allowed_delivery_methods: ["home_delivery", "store_pickup", "teleport"] }), ["store_pickup", "home_delivery"]);
});

test("一組商品只剩每項都允許的方式", () => {
  assert.deepEqual(allowedDeliveryMethods([open]), ALL_DELIVERY_METHODS);
  assert.deepEqual(allowedDeliveryMethods([open, homeOrStore]), ["store_pickup", "home_delivery"]);
  assert.deepEqual(allowedDeliveryMethods([homeOrStore, { ...open, allowed_delivery_methods: ["home_delivery"] }]), ["home_delivery"]);
  assert.deepEqual(allowedDeliveryMethods([]), ALL_DELIVERY_METHODS);
});

test("沒有共同方式時回空陣列並提示哪些商品衝突", () => {
  assert.deepEqual(allowedDeliveryMethods([homeOrStore, cvsOnly]), []);
  const message = deliveryConflictMessage([open, homeOrStore, cvsOnly]);
  assert.match(message, /「大型商品」僅限 到店取貨、宅配/);
  assert.match(message, /「小物」僅限 7-11店到店/);
  assert.match(message, /沒有共同的取貨方式/);
  assert.equal(deliveryConflictMessage([open, homeOrStore]), "");
});

test("目前選擇仍可用就保留，否則改選第一個可用方式", () => {
  assert.equal(resolveDeliveryMethod("home_delivery", ["store_pickup", "home_delivery"]), "home_delivery");
  assert.equal(resolveDeliveryMethod("cvs_delivery", ["store_pickup", "home_delivery"]), "store_pickup");
  assert.equal(resolveDeliveryMethod("cvs_delivery", []), "cvs_delivery");
});

test("送出前檢查所選方式是否被某項商品禁止", () => {
  assert.equal(deliveryMethodError([open, homeOrStore], "home_delivery"), "");
  assert.match(deliveryMethodError([open, homeOrStore], "cvs_delivery"), /「大型商品」僅限 到店取貨、宅配/);
});

test("標籤只在有限制時出現", () => {
  assert.equal(deliveryRestrictionLabel(open), "");
  assert.equal(deliveryRestrictionLabel(homeOrStore), "僅限 到店取貨、宅配");
  assert.match(productTagMarkup(homeOrStore), /product-tag-delivery[^>]*>僅限 到店取貨、宅配</);
  assert.doesNotMatch(productTagMarkup(open), /product-tag-delivery/);
});

test("購物車品項顯示限制，分組只列出傳入的取貨選項", () => {
  assert.match(cartItemMarkup(homeOrStore), /cart-item-restriction">僅限 到店取貨、宅配</);
  assert.doesNotMatch(cartItemMarkup(open), /cart-item-restriction/);
  const html = cartGroupMarkup({
    scope: "in_stock", group: [homeOrStore], method: "home_delivery",
    options: [["store_pickup", "到店取貨", "店址"], ["home_delivery", "宅配", "運費"]]
  });
  assert.match(html, /value="store_pickup"/);
  assert.match(html, /value="home_delivery" data-group-delivery="in_stock" checked/);
  assert.doesNotMatch(html, /value="cvs_delivery"/);
  assert.match(html, /data-checkout-scope="in_stock"/);
});

test("商品名稱含特殊字元時限制提示會跳脫", () => {
  const html = cartItemMarkup({ ...homeOrStore, name: "<b>x</b>" });
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
