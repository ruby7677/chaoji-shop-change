// 7-11 門市原始資料 → 上傳用的 6 欄 CSV（縣市,鄉鎮區,店號,路名,店名,地址）。
// 規則逐行移植自 scripts/fetch_711_stores.py 的 road_name／to_final_rows／write_csv（兩邊要一起改）；
// tests/frontend/cvs-road-name.test.mjs 沿用 Python 的測試案例。後台抓取（cvs-stores-fetch.js）與測試共用，純函式。

const CITY_ORDER = Object.fromEntries(["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市", "新竹市", "新竹縣", "苗栗縣", "彰化縣",
  "南投縣", "雲林縣", "嘉義市", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣", "台東縣", "澎湖縣", "金門縣", "連江縣"].map((city, index) => [city, index + 1]));

const CITY_PATTERN = /^(台北市|新北市|桃園市|台中市|台南市|高雄市|基隆市|新竹市|嘉義市|新竹縣|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/u;
const DISTRICT_PATTERN = /^(中正區|大同區|中山區|松山區|大安區|萬華區|信義區|士林區|北投區|內湖區|南港區|文山區|板橋區|三重區|中和區|永和區|新莊區|新店區|樹林區|鶯歌區|三峽區|淡水區|汐止區|瑞芳區|土城區|蘆洲區|五股區|泰山區|林口區|深坑區|石碇區|坪林區|三芝區|石門區|八里區|平溪區|雙溪區|貢寮區|金山區|萬里區|烏來區|中壢區|平鎮區|龍潭區|楊梅區|新屋區|觀音區|桃園區|龜山區|八德區|大溪區|復興區|大園區|蘆竹區|中區|東區|南區|西區|北區|北屯區|西屯區|南屯區|太平區|大里區|霧峰區|烏日區|豐原區|后里區|石岡區|東勢區|和平區|新社區|潭子區|大雅區|神岡區|大肚區|沙鹿區|龍井區|梧棲區|清水區|大甲區|外埔區|大安區|[一-龥]{1,3}[區鄉鎮市])/u;
// Python 的 \d 也比對全形數字：用 \p{Nd} 對齊
const NEIGHBOR_PATTERN = /[\p{Nd}一二三四五六七八九十百零壹貳參肆伍陸柒捌玖拾]+鄰/gu;
// 標記前至少要有一個字：「路竹區路科十路」不能只剩「路」
const ROAD_PATTERN = /(?<=.)(大道|路|街|巷)/u;
const DIGIT = /\p{Nd}/u;
const VILLAGE_MARKERS = ["村", "里"];

/** 去掉路名前的里／村（「中正里大安路」→「大安路」）；「大里路」「美村路二段」不受影響。 */
function stripAdminPrefix(cleaned) {
  let stripped = cleaned;
  for (const match of cleaned.matchAll(/[里村]/gu)) {
    const end = match.index + match[0].length;
    if (DIGIT.test(cleaned.slice(0, end))) break;
    const rest = cleaned.slice(end);
    if (ROAD_PATTERN.test(rest)) stripped = rest;
  }
  return stripped;
}

/** 從地址抽出路、街、大道、巷；沒有時依序取村／里、號碼前的地名，都沒有回空字串。 */
export function roadName(address) {
  const cleaned = stripAdminPrefix(address.replace(CITY_PATTERN, "").replace(DISTRICT_PATTERN, "").replace(NEIGHBOR_PATTERN, ""));
  const road = ROAD_PATTERN.exec(cleaned);
  if (road) return cleaned.slice(0, road.index + road[0].length).trim();
  for (const marker of VILLAGE_MARKERS) {
    const end = cleaned.indexOf(marker);
    if (end === -1) continue;
    let start = 0;
    for (let i = end - 1; i >= 0; i -= 1) {
      const char = cleaned[i];
      if (DIGIT.test(char) || char < "一" || char > "鿿") { start = i + 1; break; }
    }
    return cleaned.slice(start, end + 1).trim();
  }
  const match = cleaned.match(/^([一-龥]+)\p{Nd}/u);
  return match ? match[1] : "";
}

const isStoreRow = (row) => row.length >= 5 && /^\p{Nd}{6}$/u.test(String(row[2]).trim());

/** [縣市, 鄉鎮區, 店號, 店名, 地址] → 6 欄，店號重複時後者為準，依縣市順序、鄉鎮區、店號排序。 */
export function toFinalRows(rawRows) {
  const byCode = new Map();
  for (const row of rawRows) {
    if (!isStoreRow(row)) continue;
    const [city, district, code, name, address] = row.slice(0, 5).map((cell) => String(cell).trim());
    byCode.set(code, [city, district, code, roadName(address), name, address]);
  }
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...byCode.values()].sort((a, b) => ((CITY_ORDER[a[0]] ?? 99) - (CITY_ORDER[b[0]] ?? 99)) || compare(a[1], b[1]) || compare(a[2], b[2]));
}

/** 與 Python csv.writer 相同：含逗號、引號或換行的欄位加雙引號，列尾 \r\n，不含標題列。 */
export function toCsv(rows) {
  const cell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return rows.map((row) => row.map((value) => cell(String(value))).join(",")).join("\r\n") + (rows.length ? "\r\n" : "");
}
