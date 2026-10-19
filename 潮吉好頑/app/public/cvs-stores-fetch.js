// 後台「抓取最新門市」：逐縣市呼叫 POST /api/admin/cvs-stores/fetch（Worker 代查 7-11 官方電子地圖，每次 5 個鄉鎮），
// 收齊後整理成與 scripts/fetch_711_stores.py 相同的 6 欄 CSV，交給既有的上傳比對流程（planStoreUpload）。
// 任何縣市或鄉鎮查不到都會列在 failed：呼叫端必須擋下發佈，否則那些門市會從結帳清單悄悄消失（5% 縮水保護抓不到單一鄉鎮）。
import { CITY_SLUGS } from "./cvs-stores-data.js";
import { toCsv, toFinalRows } from "./cvs-road-name.js";

/** 後台 API 每位管理員每分鐘 60 次：兩次呼叫至少間隔這麼久，整趟維持在上限以下 */
export const MIN_CALL_INTERVAL_MS = 1100;
const RATE_LIMIT_WAIT_MS = 20_000;
const MAX_RATE_LIMIT_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * request(body) 送出一次抓取並回傳 JSON（失敗時丟出帶 status 的錯誤，同 adminFetch）。
 * onProgress({ city, cityIndex, cityTotal, townsDone, townsTotal }) 更新畫面。
 * 回傳 { rows（6 欄，已排序去重）, csv, failed（"縣市" 或 "縣市鄉鎮"）}。
 */
export async function fetchOfficialStores(request, { onProgress = () => {}, wait = sleep, interval = MIN_CALL_INTERVAL_MS } = {}) {
  const cities = Object.keys(CITY_SLUGS);
  const raw = [];
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
        if (error.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) throw error;
        await wait(RATE_LIMIT_WAIT_MS);
      }
    }
  };
  for (const [cityIndex, city] of cities.entries()) {
    let offset = 0;
    let townsTotal = 0;
    try {
      for (;;) {
        onProgress({ city, cityIndex, cityTotal: cities.length, townsDone: offset, townsTotal });
        const result = await call({ city, offset });
        townsTotal = Number(result.towns_total) || 0;
        for (const [town, code, name, address] of result.rows || []) raw.push([city, town, code, name, address]);
        for (const town of result.failed || []) failed.push(`${city}${town}`);
        if (result.next_offset === null || result.next_offset === undefined) break;
        offset = result.next_offset;
      }
    } catch (error) {
      // 登入失效時整趟停下；其他錯誤記成這個縣市失敗，繼續抓下一個，最後一次列出
      if (error.status === 401 || error.status === 403) throw error;
      failed.push(city);
    }
  }
  const rows = toFinalRows(raw);
  return { rows, csv: toCsv(rows), failed };
}

/** 讓管理員下載 CSV（存檔或之後再上傳）；檔名帶台灣日期 */
export function downloadCsv(csv, fileName) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
