// 登入／重新整理時本機與雲端購物車的合併規則：只有訪客購物車與雲端相加，
// 已同步過的會員快照不再相加（否則每次重新整理數量倍增）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cartLoginStrategy } from "../../public/cart-merge.js";

const USER = "user-a";
const hash = (items) => JSON.stringify(items);
const synced = hash([{ variant_id: "v1", quantity: 2 }]);

test("a synced member snapshot reloaded unchanged follows the server (no doubling)", () => {
  assert.equal(cartLoginStrategy({ owner: { userId: USER, syncedHash: synced }, userId: USER, localHash: synced, remoteHash: synced }), "remote");
});

test("an unchanged snapshot follows the server even when the server changed on another device", () => {
  const remote = hash([{ variant_id: "v1", quantity: 5 }]);
  assert.equal(cartLoginStrategy({ owner: { userId: USER, syncedHash: synced }, userId: USER, localHash: synced, remoteHash: remote }), "remote");
});

test("local edits that never reached the server win and are re-uploaded", () => {
  const local = hash([{ variant_id: "v1", quantity: 3 }]);
  assert.equal(cartLoginStrategy({ owner: { userId: USER, syncedHash: synced }, userId: USER, localHash: local, remoteHash: synced }), "local");
});

test("a guest cart is added to the member's server cart on login", () => {
  const guest = hash([{ variant_id: "v2", quantity: 1 }]);
  assert.equal(cartLoginStrategy({ owner: null, userId: USER, localHash: guest, remoteHash: synced }), "merge");
});

test("an unmarked local cart identical to the server is not added again", () => {
  assert.equal(cartLoginStrategy({ owner: null, userId: USER, localHash: synced, remoteHash: synced }), "remote");
});

test("another member's snapshot is not carried into this member's cart", () => {
  const other = hash([{ variant_id: "v9", quantity: 4 }]);
  assert.equal(cartLoginStrategy({ owner: { userId: "user-b", syncedHash: other }, userId: USER, localHash: other, remoteHash: synced }), "remote");
});
