// 登入／重新整理時本機與雲端購物車的合併規則：只有訪客新增的部分與雲端相加，
// 已同步過的會員快照不再相加（否則每次重新整理數量倍增），庫存裁切不算使用者修改。
import { test } from "node:test";
import assert from "node:assert/strict";
import { markCartGuestStart, normalizeCartItems, planLoginCart, readCartOwner, readStoredCartItems } from "../../public/cart-merge.js";

function fakeSessionStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  globalThis.sessionStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, val) => data.set(k, String(val)), removeItem: (k) => data.delete(k) };
}

test("a legacy sync record (syncedHash only) is read as the synced items, so the snapshot is not added again", () => {
  fakeSessionStorage({ "cj-cart-owner": JSON.stringify({ userId: "user-a", syncedHash: JSON.stringify([{ variant_id: "v1", quantity: 2 }]) }) });
  const owner = readCartOwner();
  assert.deepEqual(owner.items, [{ variant_id: "v1", quantity: 2 }]);
  const plan = planLoginCart({ owner, userId: "user-a", localItems: [{ variant_id: "v1", quantity: 2 }], remoteItems: [{ variant_id: "v1", quantity: 5 }] });
  assert.deepEqual(normalizeCartItems([...plan.local, ...plan.remote]), [{ variant_id: "v1", quantity: 5 }]);
});

test("signing out records the cart once as the guest starting point", () => {
  fakeSessionStorage({ "cj-cart-owner": JSON.stringify({ userId: "user-a", items: [{ variant_id: "v1", quantity: 1 }] }) });
  markCartGuestStart([{ id: "v1", quantity: 2 }]);
  markCartGuestStart([{ id: "v1", quantity: 9 }]);
  assert.deepEqual(readCartOwner().guestBase, [{ variant_id: "v1", quantity: 2 }]);
});

test("unreadable storage returns null so the caller falls back to the in-memory cart", () => {
  globalThis.sessionStorage = { getItem: () => { throw new Error("blocked"); } };
  assert.equal(readStoredCartItems(), null);
  fakeSessionStorage();
  assert.deepEqual(readStoredCartItems(), []);
});

const A = "user-a";
const B = "user-b";
const v = (variant_id, quantity) => ({ variant_id, quantity });
const total = (plan) => normalizeCartItems([...plan.local, ...plan.remote]);

test("a synced member snapshot reloaded unchanged follows the server (no doubling)", () => {
  const plan = planLoginCart({ owner: { userId: A, items: [v("v1", 2)] }, userId: A, localItems: [{ id: "v1", quantity: 2 }], remoteItems: [v("v1", 2)] });
  assert.deepEqual(total(plan), [v("v1", 2)]);
});

test("an unedited snapshot keeps items another device added, even when stock later shrinks", () => {
  // 本機原本 v1×5（已同步），雲端另有其他裝置加的 v2×2；本機未修改，庫存裁切由呼叫端處理
  const plan = planLoginCart({ owner: { userId: A, items: [v("v1", 5)] }, userId: A, localItems: [v("v1", 5)], remoteItems: [v("v1", 5), v("v2", 2)] });
  assert.deepEqual(plan.local, []);
  assert.deepEqual(total(plan), [v("v1", 5), v("v2", 2)]);
});

test("local edits that never reached the server win and are re-uploaded", () => {
  const plan = planLoginCart({ owner: { userId: A, items: [v("v1", 2)] }, userId: A, localItems: [v("v1", 3)], remoteItems: [v("v1", 2)] });
  assert.deepEqual(plan, { local: [v("v1", 3)], remote: [] });
});

test("a guest cart is added to the member's server cart on login", () => {
  const plan = planLoginCart({ owner: null, userId: A, localItems: [v("v2", 1)], remoteItems: [v("v1", 2)] });
  assert.deepEqual(total(plan), [v("v1", 2), v("v2", 1)]);
});

test("an unmarked local cart identical to the server is not added again", () => {
  const plan = planLoginCart({ owner: null, userId: A, localItems: [v("v1", 2)], remoteItems: [v("v1", 2)] });
  assert.deepEqual(total(plan), [v("v1", 2)]);
});

test("switching member carries only what was added as a guest after the previous member's sync", () => {
  // A 同步過 v1×2，登出後以訪客身分再加 v1×1 與 v3×1，接著 B 登入
  const plan = planLoginCart({ owner: { userId: A, items: [v("v1", 2)] }, userId: B, localItems: [v("v1", 3), v("v3", 1)], remoteItems: [v("v9", 4)] });
  assert.deepEqual(plan.local, [v("v1", 1), v("v3", 1)]);
  assert.deepEqual(total(plan), [v("v1", 1), v("v3", 1), v("v9", 4)]);
});

test("a guest cart started after A synced an empty cart is kept when B logs in", () => {
  const plan = planLoginCart({ owner: { userId: A, items: [] }, userId: B, localItems: [v("v2", 1)], remoteItems: [] });
  assert.deepEqual(total(plan), [v("v2", 1)]);
});

test("the previous member's unsynced additions are not carried; only what was added after sign-out is", () => {
  // A 最後同步 v1×1；登入期間又加 v1×1 尚未同步就失效（guestBase 記下 v1×2），之後以訪客身分加 v3×1
  const owner = { userId: A, items: [v("v1", 1)], guestBase: [v("v1", 2)] };
  const plan = planLoginCart({ owner, userId: B, localItems: [v("v1", 2), v("v3", 1)], remoteItems: [] });
  assert.deepEqual(plan.local, [v("v3", 1)]);
});

test("the previous member's own items are not carried into another member's cart", () => {
  const plan = planLoginCart({ owner: { userId: A, items: [v("v1", 2)] }, userId: B, localItems: [v("v1", 2)], remoteItems: [v("v9", 4)] });
  assert.deepEqual(total(plan), [v("v9", 4)]);
});
