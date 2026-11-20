// 內嵌執行設定（cj-config-data）：讀一次就移除，之後、沒有內嵌或內容損壞時回傳 null，呼叫端改請求 /api/config。
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_DATA_ID, takeEmbeddedConfig } from "../../public/embedded-config.js";

function fakeDocument(text) {
  const nodes = new Map();
  if (text !== undefined) nodes.set(CONFIG_DATA_ID, { textContent: text, remove() { nodes.delete(CONFIG_DATA_ID); } });
  return { getElementById: (id) => nodes.get(id) || null };
}

test("the inlined config is read once and its data block removed", () => {
  const doc = fakeDocument('{"liffId":"1-a","ordersLiffId":"1-b"}');
  assert.deepEqual(takeEmbeddedConfig(doc), { liffId: "1-a", ordersLiffId: "1-b" });
  assert.equal(doc.getElementById(CONFIG_DATA_ID), null);
  assert.equal(takeEmbeddedConfig(doc), null, "a later call requests /api/config");
});

test("a missing or broken block gives null so the caller requests /api/config", () => {
  assert.equal(takeEmbeddedConfig(fakeDocument()), null);
  assert.equal(takeEmbeddedConfig(fakeDocument("{broken")), null);
  assert.equal(takeEmbeddedConfig(fakeDocument("null")), null);
  assert.equal(takeEmbeddedConfig(undefined), null, "no document (tests, workers) is not an error");
});
