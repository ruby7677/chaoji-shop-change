// 開機計時（?cj_timing=1）：機房代碼、同源 JS 的重驗證／下載／快取統計、追蹤請求的起訖與報告格式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { coloFromRay, formatBootReport, requestLines, summarizeScripts } from "../../public/boot-timing.js";

const ORIGIN = "https://shop.test";
const entry = (name, startTime, responseEnd, transferSize = 500, encodedBodySize = 4000) => ({ name, startTime, responseEnd, transferSize, encodedBodySize });

test("the cf-ray suffix is the Cloudflare location that ran the Worker", () => {
  assert.equal(coloFromRay("a49fb40f7f033c3a-tpe"), "TPE");
  assert.equal(coloFromRay(null), "未知");
  assert.equal(coloFromRay("a49fb40f7f033c3a"), "未知");
});

test("same-origin scripts are split into revalidated, downloaded and cached", () => {
  const summary = summarizeScripts([
    entry(`${ORIGIN}/app.js`, 90.4, 230.6, 300, 15000),
    entry(`${ORIGIN}/cart.js`, 240, 410, 16000, 15000),
    entry(`${ORIGIN}/liff-auth.js`, 240, 300, 0, 3000),
    entry(`${ORIGIN}/bundle-base.css`, 10, 900),
    entry("https://static.line-scdn.net/liff/edge/2/sdk.js", 100, 950)
  ], ORIGIN);
  assert.deepEqual(summary, { count: 3, revalidated: 1, downloaded: 1, cached: 1, start: 90, end: 410 });
});

test("no same-origin scripts gives no summary", () => {
  assert.equal(summarizeScripts([entry("https://static.line-scdn.net/liff/edge/2/sdk.js", 1, 2)], ORIGIN), null);
});

test("tracked requests list each attempt with its duration, in tracking order", () => {
  const lines = requestLines([
    entry(`${ORIGIN}/api/auth/session/restore`, 800, 2000),
    entry(`${ORIGIN}/api/config`, 400, 450),
    entry(`${ORIGIN}/api/auth/session/restore`, 2500, 2900),
    entry("https://db.supabase.co/auth/v1/user?x=1", 2950, 3100),
    entry(`${ORIGIN}/api/products`, 1, 2)
  ]);
  assert.deepEqual(lines, [
    "/api/config：400→450（50ms）",
    "登入恢復 restore：800→2000（1200ms）",
    "登入恢復 restore：2500→2900（400ms）",
    "會員身分 auth/v1/user：2950→3100（150ms）"
  ]);
});

test("the report keeps phases, scripts, requests and Worker notes in separate blocks", () => {
  const text = formatBootReport({
    marks: [["JS 載入完成", 420], ["設定", 716]],
    notes: ["登入恢復：HTTP 200・機房 IAD"],
    scripts: { count: 43, revalidated: 43, downloaded: 0, cached: 0, start: 90, end: 410 },
    requests: ["/api/config：420→700（280ms）"],
    openCount: 2,
    navigationType: "reload"
  });
  assert.equal(text, [
    "開機計時（本分頁第 2 次・reload）",
    "JS 載入完成：420ms",
    "設定：716ms",
    "",
    "JS 43 個：90→410ms",
    "重驗證 43・下載 0・快取 0",
    "",
    "/api/config：420→700（280ms）",
    "",
    "登入恢復：HTTP 200・機房 IAD"
  ].join("\n"));
});
