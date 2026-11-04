// 商品頁切換規格：規格指定的圖片在圖庫中的位置；沒指定或圖庫沒有該張時不移動（-1）。
import test from "node:test";
import assert from "node:assert/strict";
import { variantImageIndex } from "../../public/variant-image.js";

const images = [{ id: "a", url: "/a" }, { id: "b", url: "/b" }];

test("回傳規格指定圖片的位置", () => {
  assert.equal(variantImageIndex(images, { image_id: "b" }), 1);
});

test("沒指定、圖庫沒有該張或只有主圖時回傳 -1", () => {
  assert.equal(variantImageIndex(images, {}), -1);
  assert.equal(variantImageIndex(images, { image_id: "x" }), -1);
  assert.equal(variantImageIndex([{ url: "/primary" }], { image_id: "a" }), -1);
  assert.equal(variantImageIndex(null, { image_id: "a" }), -1);
});
