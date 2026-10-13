// 開機計時（?cj_timing=1）：機房代碼、同源 JS 的重驗證／下載／快取統計、追蹤請求耗時、歷次中位數與報告格式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { coloFromRay, formatBootReport, historyMedians, lcpLabel, parseHistory, requestDurations, summarizeScripts } from "../../public/boot-timing.js";

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

test("tracked requests show durations in tracking order, repeats joined with +", () => {
  const durations = requestDurations([
    entry(`${ORIGIN}/api/auth/session/restore`, 800, 2000),
    entry(`${ORIGIN}/api/config`, 400, 450),
    entry(`${ORIGIN}/api/auth/session/restore`, 2500, 2900),
    entry("https://db.supabase.co/auth/v1/user?x=1", 2950, 3100),
    entry(`${ORIGIN}/api/products`, 1, 2)
  ]);
  assert.deepEqual(durations, ["設定50", "恢復1200+400", "身分150"]);
});

test("history medians skip runs missing a phase", () => {
  assert.deepEqual(historyMedians([{ 遮罩: 1000, 就緒: 3000 }, { 遮罩: 1400, 登入: 2000, 就緒: 4000 }, { 遮罩: 1100 }]), [
    ["遮罩", 1100],
    ["登入", 2000],
    ["就緒", 3500]
  ]);
});

test("stored history drops invalid counts and times instead of trusting them", () => {
  assert.deepEqual(parseHistory('{"total":-5,"runs":[{"遮罩":-1000},{"遮罩":1200,"登入":"x","其他":5},null]}'), {
    total: 3,
    runs: [{}, { 遮罩: 1200 }, {}]
  });
  assert.deepEqual(parseHistory("not json"), { total: 0, runs: [] });
  assert.deepEqual(parseHistory(null), { total: 0, runs: [] });
});

test("the report fits a phone screen: short labels, 4 items per line, P50 across runs", () => {
  const text = formatBootReport({
    marks: [["JS 載入完成", 420], ["設定", 716], ["LIFF 初始化", 900], ["畫面顯示（遮罩關閉）", 1036], ["LINE 登入恢復（背景）", 1822]],
    notes: ["登入恢復200 SJC"],
    scripts: { count: 44, revalidated: 0, downloaded: 44, cached: 0, start: 188, end: 855 },
    requests: ["設定29", "型錄188+162", "恢復849", "身分116", "點數600"],
    runNumber: 3,
    navigationType: "navigate",
    runs: [{ 遮罩: 1036 }, { 遮罩: 1341 }]
  });
  assert.equal(text, [
    "計時 #3（navigate）",
    "JS420・LIFF900・遮罩1036・登入1822",
    "JS×44 188→855 下44驗0快0",
    "設定29・型錄188+162・恢復849・身分116",
    "點數600",
    "登入恢復200 SJC",
    "近2次P50 遮罩1189"
  ].join("\n"));
});

test("the LCP note names an image or the element tag, or says it is unsupported", () => {
  assert.equal(lcpLabel({ url: "https://img.test/a.webp", element: { tagName: "IMG" } }), "LCP元素 IMG");
  assert.equal(lcpLabel({ url: "", element: { tagName: "H1" } }), "LCP元素 H1");
  assert.equal(lcpLabel(null), "LCP 不支援");
});
