// 開機各階段計時（只在除錯時開啟）：網址帶 ?cj_timing=1 開啟一次後，同分頁（含 LINE 登入轉址回來）都會記錄，
// 開機與會員載入完成後跳出精簡報告（一個畫面放得下），方便在 LINE 手機上直接看時間花在哪裡。
// 各請求耗時從 Resource Timing 讀取；Worker 回應的 cf-ray 結尾是實際執行的 Cloudflare 機房（TPE、SJC…）。
// 歷次結果存在 localStorage（關掉 LINE 視窗也會累計），報告附最近幾次的 P50；?cj_timing=reset 清除歷次結果重新累計。
// LCP 取報告當下最新的一筆（之後圖片才載完時可能再更新）；瀏覽器不支援時顯示「不支援」。不記錄 token、Cookie 或會員資料。
const TIMING_PARAM = "cj_timing";
const TIMING_KEY = "cj-boot-timing";
const HISTORY_KEY = "cj-boot-timing-history";
export const HISTORY_LIMIT = 10;

// 報告列出的請求：短標籤、判斷網址的條件、選項（span：另列開始→結束時間，看請求是不是太晚才發出）
export const TRACKED_REQUESTS = [
  ["SDK", (url) => url.hostname === "static.line-scdn.net"],
  ["設定", (url) => url.pathname === "/api/config"],
  ["型錄", (url) => url.pathname === "/api/catalog", { span: true }],
  ["恢復", (url) => url.pathname === "/api/auth/session/restore"],
  ["身分", (url) => url.pathname === "/auth/v1/user"],
  ["Profile", (url) => url.pathname === "/rest/v1/profiles"],
  ["點數", (url) => url.pathname === "/api/member/points"],
  ["購物車", (url) => url.pathname === "/api/cart"],
  ["同步", (url) => url.pathname === "/api/member/identity-sync"]
];

// markBoot 標籤 → 報告用的短標籤
const PHASE_LABELS = new Map([
  ["JS 載入完成", "JS"],
  ["型錄", "型錄"],
  ["型錄失敗", "型錄失敗"],
  ["LIFF 初始化", "LIFF"],
  ["畫面顯示（遮罩關閉）", "遮罩"],
  ["LINE 登入恢復（背景）", "登入"],
  ["會員資料", "會員"],
  ["會員功能就緒", "就緒"],
  ["開機失敗", "失敗"],
  ["LCP", "LCP"]
]);
// 跨次比較的關鍵時間點（短標籤）
const SUMMARY_PHASES = ["遮罩", "LCP", "登入", "就緒"];

const enabled = (() => {
  try {
    const param = new URL(location.href).searchParams.get(TIMING_PARAM);
    if (param === "reset") localStorage.removeItem(HISTORY_KEY);
    if (param !== null) sessionStorage.setItem(TIMING_KEY, "1");
    return sessionStorage.getItem(TIMING_KEY) === "1";
  } catch {
    return false;
  }
})();

// 預設只保留 250 筆資源紀錄：首頁商品圖多，排在後面的登入恢復與會員請求會被擠掉
if (enabled) performance.setResourceTimingBufferSize?.(2000);

let lcp = null;
if (enabled) {
  try {
    new PerformanceObserver((list) => { lcp = list.getEntries().at(-1) || lcp; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch { /* 不支援 LCP 的瀏覽器：報告顯示「不支援」 */ }
}

/** LCP 元素類型：圖片（含背景圖）顯示 IMG，其餘顯示元素標籤，例如文字標題 H1。 */
export function lcpLabel(entry) {
  if (!entry) return "LCP 不支援";
  const tag = entry.url ? "IMG" : (entry.element?.tagName || "?");
  return `LCP元素 ${tag}`;
}

const marks = [];
const notes = [];

export function markBoot(label) {
  if (enabled) marks.push([label, Math.round(performance.now())]);
}

/** 記下 Worker 回應的狀態碼、執行機房與 placement；同一標籤可記多次（例如登入恢復重試）。 */
export function noteBootResponse(label, response) {
  if (!enabled || !response) return;
  try {
    const placement = response.headers.get("cf-placement");
    notes.push(`${label}${response.status} ${coloFromRay(response.headers.get("cf-ray"))}${placement ? `(${placement})` : ""}`);
  } catch { /* 除錯工具出錯不能影響開機 */ }
}

export function coloFromRay(ray) {
  const colo = String(ray || "").split("-")[1];
  return colo ? colo.toUpperCase() : "未知";
}

/**
 * 單一資源的取得方式：cached（未發請求）、revalidated（304，只傳標頭）、downloaded（傳了內容）。
 * 304 的 encodedBodySize 依瀏覽器不同可能是 0（Chromium）或快取內容大小，兩種都要算重驗證；有 responseStatus 時以它為準。
 */
export function scriptFetchKind(entry) {
  if (entry.transferSize === 0) return "cached";
  if (entry.responseStatus === 304) return "revalidated";
  if (entry.transferSize > 0 && entry.encodedBodySize === 0) return "revalidated";
  if (entry.encodedBodySize > 0 && entry.transferSize < entry.encodedBodySize) return "revalidated";
  return "downloaded";
}

/** 同源 JS：個數、304 重驗證／下載／快取，以及第一個開始與最後一個完成的時間。 */
export function summarizeScripts(entries, origin) {
  const scripts = entries.filter((entry) => entry.name.startsWith(origin) && new URL(entry.name).pathname.endsWith(".js"));
  if (!scripts.length) return null;
  const counts = { revalidated: 0, downloaded: 0, cached: 0 };
  for (const entry of scripts) counts[scriptFetchKind(entry)] += 1;
  return {
    count: scripts.length,
    ...counts,
    start: Math.round(Math.min(...scripts.map((entry) => entry.startTime))),
    end: Math.round(Math.max(...scripts.map((entry) => entry.responseEnd)))
  };
}

/**
 * 每個追蹤請求的耗時（ms）；同一請求出現多次（重試、重複下載）以「+」相連，依追蹤順序排列。
 * 設了 span 的請求在耗時後加上（開始→結束），例如「型錄221(400→621)」。
 */
export function requestDurations(entries, tracked = TRACKED_REQUESTS) {
  const durations = [];
  for (const [label, matches, options = {}] of tracked) {
    const times = [];
    for (const entry of entries) {
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (!matches(url)) continue;
      const duration = Math.round(entry.responseEnd - entry.startTime);
      times.push(options.span ? `${duration}(${Math.round(entry.startTime)}→${Math.round(entry.responseEnd)})` : duration);
    }
    if (times.length) durations.push(`${label}${times.join("+")}`);
  }
  return durations;
}

/** 歷次結果各關鍵時間點的中位數；缺值的次數不列入。 */
export function historyMedians(runs) {
  const medians = [];
  for (const phase of SUMMARY_PHASES) {
    const values = runs.map((run) => run?.[phase]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) continue;
    const mid = Math.floor(values.length / 2);
    medians.push([phase, values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2)]);
  }
  return medians;
}

/** 把多個項目以「・」接成每行最多 perLine 個。 */
function rows(items, perLine) {
  const lines = [];
  for (let index = 0; index < items.length; index += perLine) lines.push(items.slice(index, index + perLine).join("・"));
  return lines;
}

/** 只列 PHASE_LABELS 內的階段（其餘時間點可從請求耗時推算），每行 4 個。 */
export function formatBootReport({ marks: phaseMarks, notes: responseNotes, scripts, requests, runNumber, navigationType, runs = [] }) {
  const lines = [`計時 #${runNumber}（${navigationType}）`];
  const phases = phaseMarks.filter(([label]) => PHASE_LABELS.has(label)).map(([label, ms]) => `${PHASE_LABELS.get(label)}${ms}`);
  lines.push(...rows(phases, 4));
  if (scripts) lines.push(`JS×${scripts.count} ${scripts.start}→${scripts.end} 下${scripts.downloaded}驗${scripts.revalidated}快${scripts.cached}`);
  lines.push(...rows(requests, 4));
  if (responseNotes.length) lines.push(responseNotes.join("・"));
  const medians = historyMedians(runs);
  if (runs.length > 1 && medians.length) lines.push(`近${runs.length}次P50 ${medians.map(([phase, ms]) => `${phase}${ms}`).join("・")}`);
  return lines.join("\n");
}

const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

/** 只保留合法的關鍵時間點；格式不對的歷史（手動改過、舊版資料）當作沒有。 */
export function parseHistory(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    const total = isTime(parsed?.total) ? parsed.total : 0;
    const runs = (Array.isArray(parsed?.runs) ? parsed.runs : []).slice(-HISTORY_LIMIT).map((run) => {
      const clean = {};
      for (const phase of SUMMARY_PHASES) if (isTime(run?.[phase])) clean[phase] = run[phase];
      return clean;
    });
    return { total: Math.max(total, runs.length), runs };
  } catch {
    return { total: 0, runs: [] };
  }
}

function readHistory() {
  try {
    return parseHistory(localStorage.getItem(HISTORY_KEY));
  } catch {
    return { total: 0, runs: [] };
  }
}

/** 記下這次的關鍵時間點，回傳累計次數與最近 HISTORY_LIMIT 次（含這次）。 */
function recordRun() {
  const history = readHistory();
  const run = {};
  for (const [label, ms] of marks) {
    const phase = PHASE_LABELS.get(label);
    if (SUMMARY_PHASES.includes(phase)) run[phase] = ms;
  }
  const next = { total: history.total + 1, runs: [...history.runs, run].slice(-HISTORY_LIMIT) };
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* 無法保存時只顯示這一次 */ }
  return next;
}

let reported = false;
export function reportBootTiming() {
  if (!enabled || reported || !marks.length) return;
  reported = true;
  // 除錯工具出錯（舊版 WebView 缺少 Performance API 等）不能讓開機流程變成失敗
  try {
    const entries = performance.getEntriesByType("resource");
    if (lcp) marks.push(["LCP", Math.round(lcp.renderTime || lcp.startTime)]);
    notes.push(lcpLabel(lcp));
    const history = recordRun();
    const text = formatBootReport({
      marks,
      notes,
      scripts: summarizeScripts(entries, location.origin),
      requests: requestDurations(entries),
      runNumber: history.total,
      navigationType: performance.getEntriesByType("navigation")[0]?.type || "unknown",
      runs: history.runs
    });
    console.info(text);
    window.alert(text);
  } catch (error) {
    console.warn("開機計時報告失敗", error);
  }
}
