// 後台「抓取最新門市」：逐縣市呼叫 POST /api/admin/cvs-stores/fetch（Worker 代查 7-11 官方電子地圖，每次幾個鄉鎮），
// 收齊後整理成與 scripts/fetch_711_stores.py 相同的 6 欄 CSV，交給既有的上傳比對流程（planStoreUpload）。
// 任何縣市或鄉鎮查不到都會列在 failed：呼叫端必須擋下發佈，否則那些門市會從結帳清單悄悄消失（5% 縮水保護抓不到單一鄉鎮）。
// 已抓齊的縣市放在 byCity，管理員可以只重抓失敗的縣市再合併（手機網路瞬斷或 LINE 視窗切到背景時常見）。
import { CITY_SLUGS } from "./cvs-stores-data.js";
import { toCsv, toFinalRows } from "./cvs-road-name.js";

/** 後台 API 每位管理員每分鐘 60 次：兩次呼叫至少間隔這麼久，整趟維持在上限以下 */
export const MIN_CALL_INTERVAL_MS = 1100;
const RATE_LIMIT_WAIT_MS = 20_000;
/** 網路中斷、5xx、429、回應不是 JSON（例如逾時頁面）都視為暫時錯誤，同一批最多再試這麼多次 */
const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isTransient = (error) => error.status === undefined || error.status === 429 || error.status >= 500;

/**
 * request(body) 送出一次抓取並回傳 JSON（失敗時丟出帶 status 的錯誤，同 adminFetch）。
 * cities 預設全部縣市；只重抓失敗縣市時傳入那幾個。
 * onProgress({ city, cityIndex, cityTotal, townsDone, townsTotal }) 更新畫面。
 * 回傳 { byCity: Map<縣市, 5 欄原始列>（只含完整抓齊的縣市）, failed: [{ city, town, reason }] }。
 */
export async function fetchOfficialStores(request, { cities = Object.keys(CITY_SLUGS), onProgress = () => {}, wait = sleep, interval = MIN_CALL_INTERVAL_MS } = {}) {
  const byCity = new Map();
  const failed = [];
  let lastCall = -Infinity;
  const call = async (body) => {
    for (let attempt = 0; ; attempt += 1) {
      const gap = interval - (Date.now() - lastCall);
      if (gap > 0) await wait(gap);
      lastCall = Date.now();
      try {
        return await request(body);
      } catch (error) {
        if (!isTransient(error) || attempt >= MAX_RETRIES) throw error;
        await wait(error.status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_WAIT_MS * (attempt + 1));
      }
    }
  };
  for (const [cityIndex, city] of cities.entries()) {
    const raw = [];
    const cityFailed = [];
    let offset = 0;
    let townsTotal = 0;
    try {
      for (;;) {
        onProgress({ city, cityIndex, cityTotal: cities.length, townsDone: offset, townsTotal });
        const result = await call({ city, offset });
        townsTotal = Number(result.towns_total) || 0;
        for (const [town, code, name, address] of result.rows || []) raw.push([city, town, code, name, address]);
        for (const town of result.failed || []) cityFailed.push({ city, town, reason: "官方網站查詢失敗" });
        if (result.next_offset === null || result.next_offset === undefined) break;
        offset = result.next_offset;
      }
    } catch (error) {
      // 登入失效或權限不足時整趟停下；其他錯誤記成這個縣市失敗，繼續抓下一個，最後一次列出
      if (error.status === 401 || error.status === 403) throw error;
      cityFailed.push({ city, town: "", reason: error.message || "連線失敗" });
    }
    if (cityFailed.length) failed.push(...cityFailed);
    else byCity.set(city, raw);
  }
  return { byCity, failed };
}

/** 抓齊的各縣市原始列 → 6 欄（已排序去重）與 CSV 文字 */
export function buildFetchedCsv(byCity) {
  const rows = toFinalRows([...byCity.values()].flat());
  return { rows, csv: toCsv(rows) };
}

/** 抓取期間盡量不讓手機螢幕關閉（LINE 視窗切到背景時請求會被中斷）；不支援時略過 */
export async function keepScreenOn() {
  try {
    const lock = await globalThis.navigator?.wakeLock?.request("screen");
    return () => lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}

/** 讓管理員下載 CSV（存檔或之後再上傳） */
export function downloadCsv(csv, fileName) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
