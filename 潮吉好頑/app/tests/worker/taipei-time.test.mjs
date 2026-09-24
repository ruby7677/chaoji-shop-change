// 時區：通知去重日期與生日券查詢以台灣時間／滾動視窗計算，不依 Worker 的 UTC 午夜。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, jsonResponse, loadSourceModule, stubFetch } from "./harness.mjs";

const notifications = await loadSourceModule("notifications.ts");
let restoreFetch = () => {};
afterEach(() => restoreFetch());

test("taipeiDate switches days at Taiwan midnight, not UTC midnight", () => {
  assert.equal(notifications.taipeiDate(new Date("2026-09-24T15:59:59Z")), "2026-09-24");
  assert.equal(notifications.taipeiDate(new Date("2026-09-24T16:00:00Z")), "2026-09-25");
  assert.equal(notifications.taipeiDate(new Date("2026-09-24T23:30:00Z")), "2026-09-25");
});

test("birthday coupons issued before 08:00 Taiwan time are still found after UTC midnight", async () => {
  let createdFilter = null;
  restoreFetch = stubFetch((url) => {
    if (url.pathname === "/rest/v1/coupons") { createdFilter = url.searchParams.get("created_at"); return jsonResponse([]); }
    throw new Error(`unexpected request ${url}`);
  });
  const before = Date.now();
  await notifications.notifyBirthdayCoupons(baseEnv);
  assert.ok(createdFilter, "the coupon query ran");
  const since = Date.parse(createdFilter.replace(/^gte\./, ""));
  const hours = (before - since) / 3600000;
  assert.ok(hours >= 47.9 && hours <= 48.1, `window is 48 hours, got ${hours}`);
});
