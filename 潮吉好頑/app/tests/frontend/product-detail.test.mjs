// 快速選購面板：規格指定的商品圖片從商品明細的多圖中找出；沒指定、明細未載入或圖片不在明細中時回傳 null。
import test from "node:test";
import assert from "node:assert/strict";
import { variantDetailImage } from "../../public/product-detail.js";

const detail = { images: [{ id: "a", url: "https://img.test/p/a.webp?v=1" }, { id: "b", url: "https://img.test/p/b.webp?v=1" }] };

test("找出規格指定的圖片", () => {
  assert.equal(variantDetailImage(detail, { image_id: "b" })?.url, "https://img.test/p/b.webp?v=1");
});

test("沒指定、明細未載入或找不到時回傳 null", () => {
  assert.equal(variantDetailImage(detail, {}), null);
  assert.equal(variantDetailImage(null, { image_id: "a" }), null);
  assert.equal(variantDetailImage({ failed: true }, { image_id: "a" }), null);
  assert.equal(variantDetailImage(detail, { image_id: "x" }), null);
});
