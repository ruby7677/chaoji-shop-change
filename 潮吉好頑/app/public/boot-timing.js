// 開機各階段計時（只在除錯時開啟）：網址帶 ?cj_timing=1 開啟一次後，同分頁（含 LINE 登入轉址回來）都會記錄，
// 開機與會員載入完成後跳出精簡報告（一個畫面放得下），方便在 LINE 手機上直接看時間花在哪裡。
// 各請求耗時從 Resource Timing 讀取；Worker 回應的 cf-ray 結尾是實際執行的 Cloudflare 機房（TPE、SJC…）。
// 歷次結果存在 localStorage（關掉 LINE 視窗也會累計），報告附最近幾次的 P50。不記錄 token、Cookie 或會員資料。
const TIMING_PARAM = "cj_timing";
const TIMING_KEY = "cj-boot-timing";
const HISTORY_KEY = "cj-boot-timing-history";
export const HISTORY_LIMIT = 10;

// 報告列出的請求：短標籤 → 判斷網址的條件
export const TRACKED_REQUESTS = [
  ["SDK", (url) => url.hostname === "static.line-scdn.net"],
  ["設定", (url) => url.pathname === "/api/config"],
  ["型錄", (url) => url.pathname === "/api/catalog"],
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
  ["LIFF 初始化", "LIFF"],
  ["畫面顯示（遮罩關閉）", "遮罩"],
  ["LINE 登入恢復（背景）", "登入"],
  ["會員資料", "會員"],
  ["會員功能就緒", "就緒"],
  ["開機失敗", "失敗"]
]);
// 跨次比較的關鍵時間點（短標籤）
const SUMMARY_PHASES = ["遮罩", "登入", "就緒"];

const enabled = (() => {
  try {
    if (new URL(location.href).searchParams.has(TIMING_PARAM)) sessionStorage.setItem(TIMING_KEY, "1");
    return sessionStorage.getItem(TIMING_KEY) === "1";
  } catch {
    return false;
  }
})();

// 預設只保留 250 筆資源紀錄：首頁商品圖多，排在後面的登入恢復與會員請求會被擠掉
if (enabled) performance.setResourceTimingBufferSize?.(2000);

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

/** 同源 JS：個數、304 重驗證／下載／快取，以及第一個開始與最後一個完成的時間。 */
export function summarizeScripts(entries, origin) {
  const scripts = entries.filter((entry) => entry.name.startsWith(origin) && new URL(entry.name).pathname.endsWith(".js"));
  if (!scripts.length) return null;
  const counts = { revalidated: 0, downloaded: 0, cached: 0 };
  for (const entry of scripts) {
    if (entry.transferSize === 0) counts.cached += 1;
    else if (entry.encodedBodySize > 0 && entry.transferSize < entry.encodedBodySize) counts.revalidated += 1;
    else counts.downloaded += 1;
  }
  return {
    count: scripts.length,
    ...counts,
    start: Math.round(Math.min(...scripts.map((entry) => entry.startTime))),
    end: Math.round(Math.max(...scripts.map((entry) => entry.responseEnd)))
  };
}

/** 每個追蹤請求的耗時（ms）；同一請求出現多次（重試、重複下載）以「+」相連，依追蹤順序排列。 */
export function requestDurations(entries, tracked = TRACKED_REQUESTS) {
  const durations = [];
  for (const [label, matches] of tracked) {
    const times = [];
    for (const entry of entries) {
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (matches(url)) times.push(Math.round(entry.responseEnd - entry.startTime));
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
