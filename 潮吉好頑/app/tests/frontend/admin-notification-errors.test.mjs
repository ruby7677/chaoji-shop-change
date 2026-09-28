import test from "node:test";
import assert from "node:assert/strict";
import { describeDeliveryError } from "../../public/admin-notification-errors.js";

test("LINE 429：說明額度用完並提示重新排入，保留原始訊息", () => {
  const result = describeDeliveryError("LINE 429: You have reached your monthly limit.");
  assert.match(result.reason, /本月訊息額度已用完/);
  assert.match(result.hint, /重新排入/);
  assert.equal(result.raw, "LINE 429: You have reached your monthly limit.");
});

test("LINE 429 沒有細節時也能辨識", () => {
  assert.match(describeDeliveryError("LINE 429:").reason, /額度/);
});

test("授權、格式、伺服器與網路錯誤各有白話說明", () => {
  assert.match(describeDeliveryError("LINE 401: invalid token").reason, /權杖/);
  assert.match(describeDeliveryError("Telegram 403: bot was blocked").reason, /bot token/);
  assert.match(describeDeliveryError("LINE 400: bad request").reason, /收件人或內容格式/);
  assert.match(describeDeliveryError("Telegram 502: bad gateway").reason, /暫時故障/);
  assert.match(describeDeliveryError("LINE network: timeout").reason, /連不上 LINE/);
  assert.match(describeDeliveryError("Telegram 429: Too Many Requests").reason, /限制發送頻率/);
});

test("無法辨識的格式原樣顯示；空值顯示無錯誤訊息", () => {
  assert.deepEqual(describeDeliveryError("其他錯誤"), { reason: "其他錯誤", hint: "", raw: "其他錯誤" });
  assert.equal(describeDeliveryError("").reason, "無錯誤訊息");
});
