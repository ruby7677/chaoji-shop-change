import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableRestoreStatus } from "../../public/liff-restore-policy.js";

test("限流與伺服器暫時故障視為可重試", () => {
  assert.deepEqual([429, 500, 502, 503, 504].map(isRetryableRestoreStatus), [true, true, true, true, true]);
});

test("確定失效或輸入錯誤不重試（交給既有登入流程）", () => {
  assert.deepEqual([200, 400, 401, 403, 409].map(isRetryableRestoreStatus), [false, false, false, false, false]);
});
