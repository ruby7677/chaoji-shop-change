// 開機各階段計時（只在除錯時開啟）：網址帶 ?cj_timing=1 開啟一次後，同分頁（含 LINE 登入轉址回來）都會記錄，
// 開機與會員載入完成後跳出各階段距離頁面開始載入的毫秒數，方便在 LINE 手機上直接看時間花在哪裡。
// 各請求的起訖時間從 Resource Timing 讀取；Worker 回應的 cf-ray 結尾是實際執行的 Cloudflare 機房（TPE、IAD…）。
// 不記錄 token、Cookie 或會員資料。
const TIMING_PARAM = "cj_timing";
const TIMING_KEY = "cj-boot-timing";
const OPEN_COUNT_KEY = "cj-boot-timing-opens";

// 報告列出的請求：標籤 → 判斷網址的條件
export const TRACKED_REQUESTS = [
  ["LIFF SDK", (url) => url.hostname === "static.line-scdn.net"],
  ["/api/config", (url) => url.pathname === "/api/config"],
  ["/api/catalog", (url) => url.pathname === "/api/catalog"],
  ["登入恢復 restore", (url) => url.pathname === "/api/auth/session/restore"],
  ["會員身分 auth/v1/user", (url) => url.pathname === "/auth/v1/user"],
  ["Profile", (url) => url.pathname === "/rest/v1/profiles"],
  ["點數", (url) => url.pathname === "/api/member/points"],
  ["購物車", (url) => url.pathname === "/api/cart"],
  ["身分同步", (url) => url.pathname === "/api/member/identity-sync"]
];

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

/** 記下 Worker 回應的狀態碼與執行機房；同一標籤可記多次（例如登入恢復重試）。 */
export function noteBootResponse(label, response) {
  if (!enabled || !response) return;
  notes.push(`${label}：HTTP ${response.status}・機房 ${coloFromRay(response.headers.get("cf-ray"))}`);
}

export function noteBoot(text) {
  if (enabled) notes.push(text);
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

/** 依 TRACKED_REQUESTS 列出每個請求的開始→完成與耗時；同一請求出現多次（重試）會各列一行。 */
export function requestLines(entries, tracked = TRACKED_REQUESTS) {
  const lines = [];
  for (const [label, matches] of tracked) {
    for (const entry of entries) {
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (!matches(url)) continue;
      const start = Math.round(entry.startTime);
      const end = Math.round(entry.responseEnd);
      lines.push(`${label}：${start}→${end}（${end - start}ms）`);
    }
  }
  return lines;
}

export function formatBootReport({ marks: phaseMarks, notes: responseNotes, scripts, requests, openCount, navigationType }) {
  const sections = [`開機計時（本分頁第 ${openCount} 次・${navigationType}）`];
  sections.push(...phaseMarks.map(([label, ms]) => `${label}：${ms}ms`));
  if (scripts) {
    sections.push("", `JS ${scripts.count} 個：${scripts.start}→${scripts.end}ms`, `重驗證 ${scripts.revalidated}・下載 ${scripts.downloaded}・快取 ${scripts.cached}`);
  }
  if (requests.length) sections.push("", ...requests);
  if (responseNotes.length) sections.push("", ...responseNotes);
  return sections.join("\n");
}

function nextOpenCount() {
  try {
    const count = Number(sessionStorage.getItem(OPEN_COUNT_KEY) || 0) + 1;
    sessionStorage.setItem(OPEN_COUNT_KEY, String(count));
    return count;
  } catch {
    return 1;
  }
}

let reported = false;
export function reportBootTiming() {
  if (!enabled || reported || !marks.length) return;
  reported = true;
  const entries = performance.getEntriesByType("resource");
  const text = formatBootReport({
    marks,
    notes,
    scripts: summarizeScripts(entries, location.origin),
    requests: requestLines(entries),
    openCount: nextOpenCount(),
    navigationType: performance.getEntriesByType("navigation")[0]?.type || "unknown"
  });
  console.info(text);
  window.alert(text);
}
