// 規格編輯表單的規格圖片欄位：無多圖時只顯示提示；有多圖時預選已指定的圖，圖片已刪除時改選「不指定」；
// 只有表單含此欄位時才送 image_id。
import test from "node:test";
import assert from "node:assert/strict";
import { variantImageFieldMarkup, variantImagePayload } from "../../public/admin-variant-image.js";

const product = { id: "p1", product_images: [{ id: "img-b", sort_order: 1, updated_at: "t" }, { id: "img-a", sort_order: 0, updated_at: "t" }] };
const checkedValue = (html) => html.match(/value="([^"]*)" checked/)?.[1];

test("無多圖時顯示提示，不產生單選", () => {
  const html = variantImageFieldMarkup({ id: "p1", product_images: [] }, {});
  assert.match(html, /請先在「照片與展示」分頁上傳多圖/);
  assert.doesNotMatch(html, /type="radio"/);
});

test("依排序列出多圖並預選已指定的圖", () => {
  const html = variantImageFieldMarkup(product, { image_id: "img-b" });
  assert.ok(html.indexOf('value="img-a"') < html.indexOf('value="img-b"'));
  assert.equal(checkedValue(html), "img-b");
});

test("未指定或指定的圖已不存在時預選「不指定」", () => {
  assert.equal(checkedValue(variantImageFieldMarkup(product, {})), "");
  assert.equal(checkedValue(variantImageFieldMarkup(product, { image_id: "deleted" })), "");
});

test("送出內容：有欄位才帶 image_id，不指定送 null", () => {
  const form = (entries) => { const data = new FormData(); entries.forEach(([key, value]) => data.append(key, value)); return data; };
  assert.deepEqual(variantImagePayload(form([["name", "x"]])), {});
  assert.deepEqual(variantImagePayload(form([["image_id", ""]])), { image_id: null });
  assert.deepEqual(variantImagePayload(form([["image_id", "img-a"]])), { image_id: "img-a" });
});
