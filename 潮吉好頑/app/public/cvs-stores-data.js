// 7-11 門市 CSV（縣市,鄉鎮區,店號,路名,店名,地址）的解析、分組與比對。
// 純函式、不依賴 Node 或 DOM：build 腳本（scripts/build-cvs-stores.mjs）與後台上傳頁（admin-cvs-stores.js）共用。
// Worker 端的縣市白名單在 src/cvs-stores.ts（Worker 不能 import public/），tests/worker/cvs-stores.test.mjs 會比對兩邊一致。

// 由北到南排列；slug 只作為檔名
export const CITY_SLUGS = {
  "台北市": "taipei", "新北市": "new-taipei", "基隆市": "keelung", "桃園市": "taoyuan", "新竹市": "hsinchu-city", "新竹縣": "hsinchu",
  "苗栗縣": "miaoli", "台中市": "taichung", "彰化縣": "changhua", "南投縣": "nantou", "雲林縣": "yunlin", "嘉義市": "chiayi-city",
  "嘉義縣": "chiayi", "台南市": "tainan", "高雄市": "kaohsiung", "屏東縣": "pingtung", "宜蘭縣": "yilan", "花蓮縣": "hualien",
  "台東縣": "taitung", "澎湖縣": "penghu", "金門縣": "kinmen", "連江縣": "lienchiang"
};

/** 解析 CSV（支援雙引號欄位內的逗號）。 */
export function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
      else cell += char;
    }
    cells.push(cell);
    rows.push(cells.map((value) => value.trim()));
  }
  return rows;
}

/** 依縣市／鄉鎮區分組；不合規的列（未知縣市、店號不是 6 碼、缺鄉鎮區或店名）略過，欄位超過資料庫長度限制則丟錯。 */
export function groupStores(rows) {
  const cities = new Map();
  for (const [city, district, code, , name, address] of rows) {
    if (!CITY_SLUGS[city] || !district || !/^\d{6}$/.test(code) || !name) continue;
    const storeName = name.endsWith("門市") ? name : `${name}門市`;
    if (city.length > 10 || district.length > 10 || storeName.length > 40) throw new Error(`欄位超過資料庫長度限制：${city}${district} ${storeName}`);
    const districts = cities.get(city) || new Map();
    cities.set(city, districts);
    const stores = districts.get(district) || [];
    districts.set(district, stores);
    stores.push([code, storeName, address || ""]);
  }
  return cities;
}

/**
 * 把分組結果排成前台使用的檔案內容：
 * files[slug] = { 鄉鎮區: [[店號, 店名, 地址], ...] }，index = [[縣市, slug, 排序後的鄉鎮區], ...]（只含有門市的縣市）。
 */
export function buildStoreFiles(cities) {
  const index = [];
  const files = {};
  let total = 0;
  for (const [city, slug] of Object.entries(CITY_SLUGS)) {
    const districts = cities.get(city);
    if (!districts) continue;
    const sorted = [...districts.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const data = Object.fromEntries(sorted.map((district) => [district, districts.get(district).sort((a, b) => a[1].localeCompare(b[1], "zh-Hant"))]));
    total += sorted.reduce((sum, district) => sum + data[district].length, 0);
    index.push([city, slug, sorted]);
    files[slug] = data;
  }
  return { index, files, total };
}

export function countStores(data) {
  return Object.values(data || {}).reduce((sum, stores) => sum + stores.length, 0);
}

function codeMap(data) {
  const map = new Map();
  for (const [district, stores] of Object.entries(data || {})) {
    for (const [code, name, address] of stores) map.set(code, { district, name, address });
  }
  return map;
}

/**
 * 比對目前與新的單一縣市檔：回傳新增、移除、地址（或店名）變更的店號與筆數。
 * before/after 為縣市檔內容（沒有該縣市時傳 null）。
 */
export function diffCityData(before, after) {
  const oldMap = codeMap(before);
  const newMap = codeMap(after);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [code, store] of newMap) {
    const old = oldMap.get(code);
    if (!old) added.push({ code, ...store });
    else if (old.address !== store.address || old.name !== store.name) changed.push({ code, name: store.name, from: old.address, to: store.address });
  }
  for (const [code, store] of oldMap) if (!newMap.has(code)) removed.push({ code, ...store });
  return { added, removed, changed, before: oldMap.size, after: newMap.size };
}

/** 總量縮減超過比例（預設 5%）就視為異常，後台不允許確認。 */
export function shrinkRatio(beforeTotal, afterTotal) {
  return beforeTotal > 0 ? Math.max(0, (beforeTotal - afterTotal) / beforeTotal) : 0;
}
export const MAX_SHRINK_RATIO = 0.05;

/** 後台上傳用版本代號：UTC 時間（可排序）＋ 6 碼隨機，與 Worker 的 CVS_VERSION_PATTERN 一致。 */
export function newVersionId(now = new Date(), random = globalThis.crypto.getRandomValues(new Uint8Array(3))) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${stamp}-${[...random].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const LIST_LIMIT = 200;

/**
 * 後台上傳預覽：解析 CSV，和目前使用中的各縣市檔（currentFiles = { slug: 縣市檔內容 }）比對。
 * blockers 非空時不可發佈：缺縣市、店號重複、或總量比目前少超過 MAX_SHRINK_RATIO。
 * 欄位超過資料庫長度限制時 groupStores 會丟錯，由呼叫端顯示。
 */
export function planStoreUpload(csvText, currentFiles = {}) {
  const rows = parseCsv(csvText);
  const cities = groupStores(rows);
  const { index, files, total } = buildStoreFiles(cities);
  const hasHeader = rows[0]?.[0] === "縣市" && !/^\d{6}$/.test(rows[0]?.[2] || "");
  const skipped = rows.length - (hasHeader ? 1 : 0) - [...cities.values()].reduce((sum, districts) => sum + [...districts.values()].reduce((n, stores) => n + stores.length, 0), 0);
  const seen = new Map();
  const duplicates = [];
  for (const [city, districts] of cities) {
    for (const stores of districts.values()) {
      for (const [code, name] of stores) {
        if (seen.has(code)) duplicates.push(`${code} ${seen.get(code)} / ${city}${name}`);
        else seen.set(code, `${city}${name}`);
      }
    }
  }
  const perCity = [];
  const addedList = [];
  const removedList = [];
  let beforeTotal = 0;
  for (const [city, slug] of Object.entries(CITY_SLUGS)) {
    const diff = diffCityData(currentFiles[slug] || null, files[slug] || null);
    beforeTotal += diff.before;
    perCity.push({ city, slug, before: diff.before, after: diff.after, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length });
    diff.added.forEach((store) => addedList.push({ city, ...store }));
    diff.removed.forEach((store) => removedList.push({ city, ...store }));
  }
  const missing = Object.keys(CITY_SLUGS).filter((city) => !files[CITY_SLUGS[city]]);
  const shrink = shrinkRatio(beforeTotal, total);
  const blockers = [];
  if (missing.length) blockers.push(`CSV 缺少縣市：${missing.join("、")}`);
  if (duplicates.length) blockers.push(`店號重複 ${duplicates.length} 筆，例如 ${duplicates[0]}`);
  if (shrink > MAX_SHRINK_RATIO) blockers.push(`門市總數從 ${beforeTotal} 減為 ${total}（少 ${(shrink * 100).toFixed(1)}%，超過 ${MAX_SHRINK_RATIO * 100}% 上限），請確認 CSV 是否完整`);
  if (!total) blockers.push("CSV 內沒有可用的門市資料（需要 6 欄：縣市,鄉鎮區,店號,路名,店名,地址）");
  return {
    files, index, total, beforeTotal, perCity, skipped, duplicates, missing, shrink, blockers,
    added: perCity.reduce((sum, row) => sum + row.added, 0),
    removed: perCity.reduce((sum, row) => sum + row.removed, 0),
    changed: perCity.reduce((sum, row) => sum + row.changed, 0),
    addedList: addedList.slice(0, LIST_LIMIT),
    removedList: removedList.slice(0, LIST_LIMIT)
  };
}
