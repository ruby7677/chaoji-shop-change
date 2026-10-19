// 後台「抓取最新門市」：由 Worker 代管理員向 7-11 官方電子地圖（emap.pcsc.com.tw）查詢門市，
// 流程與 scripts/fetch_711_stores.py 相同（GetTown → 逐鄉鎮 SearchStore）。瀏覽器無法直接呼叫官方 API（跨網域、需要 Origin／Referer）。
// Workers Free 每次請求 50 個子請求、10ms CPU：一次只處理一個縣市的 5 個鄉鎮（後台以 offset 接續），
// 鄉鎮清單由伺服器自己查，用戶端只送白名單縣市與 offset，不能把這裡當成任意代理。
// 只回傳 [鄉鎮, 店號, 店名, 地址]；路名萃取、排序與檢查在瀏覽器（public/cvs-stores-fetch.js），再接既有的 CSV 上傳流程。
import { requireAdmin } from "./auth";
import { CVS_CITY_SLUGS } from "./cvs-stores";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, fetchWithTimeout, json } from "./http";

const EMAP_URL = "https://emap.pcsc.com.tw/EMapSDK.aspx";
const EMAP_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "Origin": "https://emap.pcsc.com.tw",
  "Referer": "https://emap.pcsc.com.tw/default.aspx",
  "X-Requested-With": "XMLHttpRequest",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
};
/** 官方 cityid；24 是連江（馬祖）、25 才是金門（與 Python 腳本相同）。縣市必須與 CVS_CITY_SLUGS 一致（測試比對）。 */
export const EMAP_CITY_IDS: Record<string, string> = {
  "台北市": "01", "基隆市": "02", "新北市": "03", "桃園市": "04", "新竹市": "05", "新竹縣": "06", "苗栗縣": "07", "台中市": "08",
  "彰化縣": "10", "南投縣": "11", "雲林縣": "12", "嘉義市": "13", "嘉義縣": "14", "台南市": "15", "高雄市": "17", "屏東縣": "19",
  "宜蘭縣": "20", "花蓮縣": "21", "台東縣": "22", "澎湖縣": "23", "連江縣": "24", "金門縣": "25"
};
/** 每次請求處理的鄉鎮數：requireAdmin 的子請求＋GetTown＋5 ×（1＋重試 2）＝ 遠低於 50，解析量也在 CPU 額度內 */
export const EMAP_TOWNS_PER_REQUEST = 5;
const EMAP_ATTEMPTS = 3;
const EMAP_TIMEOUT_MS = 15_000;
/** 對官方網站放慢速度：同一請求內連續查詢之間的間隔 */
const EMAP_DELAY_MS = 250;
const MAX_OFFSET = 200;

export type EmapStoreRow = [town: string, code: string, name: string, address: string];

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
function decodeXml(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] !== "#") return ENTITIES[entity.toLowerCase()] ?? whole;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }).trim();
}

// 預先編譯：一個大鄉鎮有上百間門市，每間取 3 個欄位，CPU 額度只有 10ms
const TAG_PATTERNS = Object.fromEntries(["TownName", "POIID", "POIName", "Address"].map((tag) => [tag, new RegExp(`<${tag}>([^<]*)</${tag}>`)]));
function tagText(block: string, tag: keyof typeof TAG_PATTERNS) {
  const match = block.match(TAG_PATTERNS[tag]);
  return match ? decodeXml(match[1]) : "";
}

const geoPositions = (xml: string) => xml.match(/<GeoPosition>[\s\S]*?<\/GeoPosition>/g) || [];

/** GetTown 回應 → 鄉鎮名稱（依官方順序） */
export function parseTownNames(xml: string): string[] {
  return geoPositions(xml).map((block) => tagText(block, "TownName")).filter(Boolean);
}

/** SearchStore 回應 → [店號, 店名, 地址]；缺店號的項目略過（店號格式由瀏覽器端與 Python 相同規則檢查） */
export function parseStores(xml: string): [string, string, string][] {
  return geoPositions(xml).map((block): [string, string, string] => [tagText(block, "POIID"), tagText(block, "POIName"), tagText(block, "Address")]).filter(([code]) => code);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 送出一次查詢，失敗（網路、非 200、不是官方 XML）時重試；全部失敗回 null */
async function postEmap(params: Record<string, string>): Promise<string | null> {
  for (let attempt = 1; attempt <= EMAP_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(EMAP_URL, { method: "POST", headers: EMAP_HEADERS, body: new URLSearchParams(params) }, EMAP_TIMEOUT_MS);
      const text = await response.text();
      if (response.ok && text.includes("<iMapSDKOutput>")) return text;
    } catch { /* 下面重試 */ }
    if (attempt < EMAP_ATTEMPTS) await wait(EMAP_DELAY_MS * attempt);
  }
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_JSON_REQUEST_BYTES) return null;
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/admin/cvs-stores/fetch { city, offset } → { city, towns_total, next_offset, rows, failed }
 * rows：這批鄉鎮的門市；failed：重試後仍查不到的鄉鎮（後台必須擋下發佈）；next_offset 為 null 表示這個縣市已查完。
 */
export async function fetchCvsStoresFromEmap(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const body = await readBody(request);
  if (!body) return json({ error: "請求格式錯誤" }, { status: 400 });
  const city = typeof body.city === "string" ? body.city : "";
  const cityId = Object.hasOwn(EMAP_CITY_IDS, city) && Object.hasOwn(CVS_CITY_SLUGS, city) ? EMAP_CITY_IDS[city] : "";
  if (!cityId) return json({ error: "縣市不正確" }, { status: 400 });
  const offset = body.offset ?? 0;
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_OFFSET) return json({ error: "offset 不正確" }, { status: 400 });

  const townXml = await postEmap({ commandid: "GetTown", cityid: cityId, cityname: city });
  const towns = townXml ? parseTownNames(townXml) : [];
  if (!towns.length) return json({ error: `無法從 7-11 官方網站取得${city}的鄉鎮清單，請稍後再試` }, { status: 502 });

  const start = offset as number;
  const batch = towns.slice(start, start + EMAP_TOWNS_PER_REQUEST);
  const rows: EmapStoreRow[] = [];
  const failed: string[] = [];
  for (const town of batch) {
    await wait(EMAP_DELAY_MS);
    const xml = await postEmap({ commandid: "SearchStore", city, town, roadname: "", ID: "", StoreName: "" });
    if (xml === null) failed.push(town);
    else for (const [code, name, address] of parseStores(xml)) rows.push([town, code, name, address]);
  }
  const next = start + EMAP_TOWNS_PER_REQUEST;
  return json({ city, towns_total: towns.length, next_offset: next < towns.length ? next : null, rows, failed });
}
