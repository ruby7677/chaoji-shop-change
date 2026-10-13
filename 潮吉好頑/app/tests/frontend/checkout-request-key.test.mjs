// 結帳請求識別碼：同內容重送沿用 key、內容改變換新 key、成功後清除，且不在瀏覽器保存收件人原文。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutRequestKey, clearCheckoutRequestKey, requestDigest } from "../../public/checkout-request-key.js";

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key)
  };
}

const sequence = () => {
  let n = 0;
  return () => `key-${++n}`;
};

test("retrying the same order content reuses the pending key", () => {
  const storage = memoryStorage();
  const randomUUID = sequence();
  const body = JSON.stringify({ items: [{ variant_id: "a", quantity: 1 }] });
  assert.equal(checkoutRequestKey(body, { storage, randomUUID }), "key-1");
  assert.equal(checkoutRequestKey(body, { storage, randomUUID }), "key-1");
});

test("changing the order content issues a new key", () => {
  const storage = memoryStorage();
  const randomUUID = sequence();
  checkoutRequestKey(JSON.stringify({ quantity: 1 }), { storage, randomUUID });
  assert.equal(checkoutRequestKey(JSON.stringify({ quantity: 2 }), { storage, randomUUID }), "key-2");
});

test("a successful order clears the key so the next purchase gets a new one", () => {
  const storage = memoryStorage();
  const randomUUID = sequence();
  const body = JSON.stringify({ quantity: 1 });
  checkoutRequestKey(body, { storage, randomUUID });
  clearCheckoutRequestKey({ storage });
  assert.equal(checkoutRequestKey(body, { storage, randomUUID }), "key-2");
});

test("only a digest of the order content is stored, not the recipient details", () => {
  const storage = memoryStorage();
  const body = JSON.stringify({ shipping_recipient_name: "王小明", shipping_phone: "0912345678" });
  checkoutRequestKey(body, { storage, randomUUID: sequence() });
  const stored = [...storage.data.values()].join("");
  assert.ok(!stored.includes("王小明") && !stored.includes("0912345678"));
  assert.ok(stored.includes(requestDigest(body)));
});

test("unavailable storage still yields a key without throwing", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(checkoutRequestKey("{}", { storage: broken, randomUUID: () => "fresh" }), "fresh");
  assert.doesNotThrow(() => clearCheckoutRequestKey({ storage: broken }));
});

test("without usable storage a same-page retry still reuses the key", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const randomUUID = sequence();
  const body = JSON.stringify({ items: [{ variant_id: "b", quantity: 3 }] });
  const first = checkoutRequestKey(body, { storage: broken, randomUUID });
  assert.equal(checkoutRequestKey(body, { storage: broken, randomUUID }), first);
  clearCheckoutRequestKey({ storage: broken });
  assert.notEqual(checkoutRequestKey(body, { storage: broken, randomUUID }), first, "a successful order still clears the in-page key");
});

test("after a successful order the cart is settled before the request key is cleared", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../public/checkout-flow.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export async function submitOrder"));
  const at = (text) => {
    const index = body.indexOf(text);
    assert.ok(index >= 0, `missing: ${text}`);
    return index;
  };
  const cleared = at("clearCheckoutRequestKey();");
  assert.ok(at("cart.splice(") < cleared, "purchased items leave the cart first");
  assert.ok(at("saveCart();") < cleared, "the cart is saved locally first");
  assert.ok(at("await syncMemberCartNow();") < cleared, "the member cloud cart is synced first");
  assert.ok(at("await loadPoints({ force: true })") > cleared, "a slow points reload cannot delay clearing past an unsaved cart");
});
