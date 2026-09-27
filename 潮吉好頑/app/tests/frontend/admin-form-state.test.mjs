// 編輯面板分頁化：表單欄位快照／還原純邏輯（不碰 DOM，見 admin-form-state.js 開頭說明）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotFields, matchField, createFormStateStore } from "../../public/admin-form-state.js";

test("snapshotFields：文字輸入記錄 name、type、value", () => {
  const fields = snapshotFields([{ name: "name", type: "text", value: "潮吉好頑" }]);
  assert.deepEqual(fields, [{ name: "name", type: "text", value: "潮吉好頑" }]);
});

test("snapshotFields：select 記錄目前選取的 value", () => {
  const fields = snapshotFields([{ name: "kind", type: "select-one", value: "preorder" }]);
  assert.deepEqual(fields, [{ name: "kind", type: "select-one", value: "preorder" }]);
});

test("snapshotFields：checkbox 記錄 checked（勾選與未勾選皆同）", () => {
  const fields = snapshotFields([
    { name: "is_published", type: "checkbox", value: "on", checked: true },
    { name: "points_excluded", type: "checkbox", value: "on", checked: false }
  ]);
  assert.deepEqual(fields, [
    { name: "is_published", type: "checkbox", value: "on", checked: true },
    { name: "points_excluded", type: "checkbox", value: "on", checked: false }
  ]);
});

test("snapshotFields：radio 記錄 value 與 checked", () => {
  const fields = snapshotFields([
    { name: "kind", type: "radio", value: "in_stock", checked: false },
    { name: "kind", type: "radio", value: "preorder", checked: true }
  ]);
  assert.deepEqual(fields, [
    { name: "kind", type: "radio", value: "in_stock", checked: false },
    { name: "kind", type: "radio", value: "preorder", checked: true }
  ]);
});

test("snapshotFields：略過 file 類型欄位", () => {
  const fields = snapshotFields([
    { name: "image", type: "file", value: "" },
    { name: "name", type: "text", value: "測試商品" }
  ]);
  assert.deepEqual(fields, [{ name: "name", type: "text", value: "測試商品" }]);
});

test("snapshotFields：略過沒有 name 的欄位", () => {
  const fields = snapshotFields([{ name: "", type: "text", value: "不該保留" }]);
  assert.deepEqual(fields, []);
});

test("matchField：只還原同名欄位，其他欄位不受影響", () => {
  const fields = snapshotFields([
    { name: "name", type: "text", value: "改過的名稱" },
    { name: "sku", type: "text", value: "SKU-1" }
  ]);
  assert.deepEqual(matchField(fields, { name: "name", type: "text" }), { name: "name", type: "text", value: "改過的名稱" });
  assert.equal(matchField(fields, { name: "display_order", type: "number" }), null);
});

test("matchField：checkbox 需連 value 一起比對，同名不同選項不會互相覆蓋", () => {
  const fields = snapshotFields([
    { name: "flag", type: "checkbox", value: "a", checked: true },
    { name: "flag", type: "checkbox", value: "b", checked: false }
  ]);
  assert.deepEqual(matchField(fields, { name: "flag", type: "checkbox", value: "a" }), { name: "flag", type: "checkbox", value: "a", checked: true });
  assert.deepEqual(matchField(fields, { name: "flag", type: "checkbox", value: "b" }), { name: "flag", type: "checkbox", value: "b", checked: false });
});

test("matchField：radio 依 value 找出目前選取的那一個", () => {
  const fields = snapshotFields([
    { name: "kind", type: "radio", value: "in_stock", checked: false },
    { name: "kind", type: "radio", value: "preorder", checked: true }
  ]);
  assert.equal(matchField(fields, { name: "kind", type: "radio", value: "preorder" }).checked, true);
  assert.equal(matchField(fields, { name: "kind", type: "radio", value: "in_stock" }).checked, false);
});

test("matchField：找不到對應欄位或缺少 name 時回傳 null", () => {
  const fields = snapshotFields([{ name: "name", type: "text", value: "x" }]);
  assert.equal(matchField(fields, { name: "not_in_snapshot", type: "text" }), null);
  assert.equal(matchField(fields, { name: "", type: "text" }), null);
  assert.equal(matchField(null, { name: "name", type: "text" }), null);
});

test("createFormStateStore：save 後 take 一次即取出並清除", () => {
  const store = createFormStateStore();
  const fields = [{ name: "name", type: "text", value: "v" }];
  store.save("product:p1", fields);
  assert.equal(store.has("product:p1"), true);
  assert.deepEqual(store.take("product:p1"), fields);
  assert.equal(store.has("product:p1"), false);
  assert.equal(store.take("product:p1"), null);
});

test("createFormStateStore：未知的表單 key 一律回傳 null（呼叫端可安全略過還原）", () => {
  const store = createFormStateStore();
  assert.equal(store.take("variant:does-not-exist"), null);
  assert.equal(store.has("variant:does-not-exist"), false);
});

test("createFormStateStore：不同 key 互不影響", () => {
  const store = createFormStateStore();
  store.save("product:p1", [{ name: "name", type: "text", value: "A" }]);
  store.save("variant:v1", [{ name: "sku", type: "text", value: "SKU-A" }]);
  assert.deepEqual(store.take("variant:v1"), [{ name: "sku", type: "text", value: "SKU-A" }]);
  assert.deepEqual(store.take("product:p1"), [{ name: "name", type: "text", value: "A" }]);
});
