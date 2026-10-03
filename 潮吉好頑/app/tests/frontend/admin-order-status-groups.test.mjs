import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_STATUS_GROUPS, defaultStatusOfGroup, groupCount, groupOfStatus } from "../../public/admin-order-status-groups.js";

const byKey = (key) => ORDER_STATUS_GROUPS.find((group) => group.key === key);

test("七個訂單狀態各屬於一個分組，沒有遺漏或重複；退款狀態已移除", () => {
  const all = ORDER_STATUS_GROUPS.flatMap((group) => group.statuses.map(([value]) => value));
  assert.equal(all.length, 7);
  assert.equal(new Set(all).size, 7);
  assert.equal(groupOfStatus("ready_for_pickup").key, "active");
  assert.equal(groupOfStatus("refund_pending"), null);
  assert.equal(groupOfStatus("refunded"), null);
  assert.equal(groupOfStatus("all"), null);
});

test("分組徽章為組內待辦總數", () => {
  assert.equal(groupCount(byKey("todo"), { pendingReview: 2, sellerPending: 1 }), 3);
  assert.equal(groupCount(byKey("closed"), { pendingReview: 2 }), 0);
});

test("點分組時開啟第一個有待辦的狀態，沒有待辦時開第一個", () => {
  assert.equal(defaultStatusOfGroup(byKey("todo"), { sellerPending: 1 }), "seller_pending");
  assert.equal(defaultStatusOfGroup(byKey("todo"), {}), "pending_review");
  assert.equal(defaultStatusOfGroup(byKey("active"), { readyForPickup: 4 }), "ready_for_pickup");
});
