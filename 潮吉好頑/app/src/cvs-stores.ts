// 7-11 取件門市資料（R2 版本）的共用常數、驗證與儲存鍵。
// 結帳門市清單預設是 public/cvs-stores/ 的靜態檔；後台上傳後改存 R2（PRODUCT_IMAGES bucket 的 cvs-stores/ 前綴）：
//   cvs-stores/<version>/<slug>.json   各縣市（暫存時 customMetadata 記伺服器計算的筆數與鄉鎮區）
//   cvs-stores/<version>/index.json    發佈時由各縣市 metadata 組成
//   cvs-stores/<version>/manifest.json 發佈紀錄（上傳者、時間、筆數）；有它才算已發佈
//   cvs-stores/current.json            指標，最後才寫入；刪除＝回到 repo 靜態檔（baseline）
// 縣市白名單與 public/cvs-stores-data.js 的 CITY_SLUGS 相同（Worker 不能 import public/），tests/worker/cvs-stores.test.mjs 比對兩邊一致。

export const CVS_CITY_SLUGS: Record<string, string> = {
  "台北市": "taipei", "新北市": "new-taipei", "基隆市": "keelung", "桃園市": "taoyuan", "新竹市": "hsinchu-city", "新竹縣": "hsinchu",
  "苗栗縣": "miaoli", "台中市": "taichung", "彰化縣": "changhua", "南投縣": "nantou", "雲林縣": "yunlin", "嘉義市": "chiayi-city",
  "嘉義縣": "chiayi", "台南市": "tainan", "高雄市": "kaohsiung", "屏東縣": "pingtung", "宜蘭縣": "yilan", "花蓮縣": "hualien",
  "台東縣": "taitung", "澎湖縣": "penghu", "金門縣": "kinmen", "連江縣": "lienchiang"
};
export const CVS_SLUGS = new Set(Object.values(CVS_CITY_SLUGS));

export const CVS_PREFIX = "cvs-stores/";
export const CVS_POINTER_KEY = `${CVS_PREFIX}current.json`;
/** 保留最近幾個已發佈版本（含目前版本）供回復；更舊的在發佈時刪除 */
export const CVS_KEEP_VERSIONS = 5;
/** 新版總筆數比目前版本少超過這個比例就拒絕發佈（抓取失敗或 CSV 殘缺的保護） */
export const CVS_MAX_SHRINK_RATIO = 0.05;
export const CVS_VERSION_PATTERN = /^\d{14}-[0-9a-f]{6}$/;

// R2 customMetadata 單一物件上限 2048 位元組（鄉鎮區清單也存在裡面）：50 個 × 10 字上限仍在範圍內
const MAX_DISTRICTS = 50;
const MAX_STORES_PER_CITY = 3000;
// 與訂單欄位限制一致（create_delivery_order：縣市／鄉鎮區 10 字、店名 40 字）；地址不進訂單，只放寬到合理上限
const MAX_DISTRICT_LENGTH = 10;
const MAX_NAME_LENGTH = 40;
const MAX_ADDRESS_LENGTH = 120;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type CvsStore = [string, string, string];
export type CvsCityData = Record<string, CvsStore[]>;
export type CvsPointer = { version: string; total: number; publishedAt: string; publishedBy: string };
export type CvsManifest = { version: string; total: number; cities: Record<string, number>; publishedAt: string; publishedBy: string };

export const cvsVersionKey = (version: string, name: string) => `${CVS_PREFIX}${version}/${name}.json`;

export type ValidatedCity = { data: CvsCityData; count: number; districts: string[] };

function cleanText(value: unknown, max: number, min = 1) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max && !CONTROL_CHARS.test(text) ? text : null;
}

/** 驗證並正規化單一縣市檔內容（{鄉鎮區: [[店號, 店名, 地址], ...]}）；任何一筆不合規就整份拒絕。 */
export function validateCityData(raw: unknown): { ok: true; value: ValidatedCity } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "門市資料格式不正確" };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_DISTRICTS) return { ok: false, error: "鄉鎮區數量不正確" };
  const data: CvsCityData = {};
  const codes = new Set<string>();
  let count = 0;
  for (const [rawDistrict, stores] of entries) {
    const district = cleanText(rawDistrict, MAX_DISTRICT_LENGTH);
    if (!district || data[district]) return { ok: false, error: `鄉鎮區名稱不正確：${String(rawDistrict).slice(0, 12)}` };
    if (!Array.isArray(stores) || !stores.length) return { ok: false, error: `${district} 沒有門市` };
    const list: CvsStore[] = [];
    for (const row of stores) {
      if (!Array.isArray(row) || row.length !== 3) return { ok: false, error: `${district} 的門市欄位數不正確` };
      const code = typeof row[0] === "string" ? row[0].trim() : "";
      const name = cleanText(row[1], MAX_NAME_LENGTH);
      const address = typeof row[2] === "string" ? cleanText(row[2], MAX_ADDRESS_LENGTH, 0) : null;
      if (!/^\d{6}$/.test(code)) return { ok: false, error: `${district} 有店號不是 6 碼數字：${code.slice(0, 12)}` };
      if (!name) return { ok: false, error: `${district} ${code} 的店名不正確（1–${MAX_NAME_LENGTH} 字）` };
      if (address === null) return { ok: false, error: `${district} ${code} 的地址不正確` };
      if (codes.has(code)) return { ok: false, error: `店號重複：${code}` };
      codes.add(code);
      list.push([code, name, address]);
    }
    data[district] = list;
    count += list.length;
    if (count > MAX_STORES_PER_CITY) return { ok: false, error: "單一縣市門市數量過多" };
  }
  return { ok: true, value: { data, count, districts: Object.keys(data) } };
}
