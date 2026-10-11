// 由 7-ELEVEN 門市 CSV（縣市,鄉鎮區,店號,路名,店名,地址）產生結帳用的門市資料：
// public/cvs-stores/index.json（縣市→鄉鎮區）與每個縣市一個 <slug>.json（鄉鎮區→門市），前台選定縣市時才載入。
// 用法：node scripts/build-cvs-stores.mjs <711_stores.csv>
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../public/cvs-stores/", import.meta.url));
// 由北到南排列；slug 只作為檔名
const CITY_SLUGS = {
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
    stores.push([code, storeName, address]);
  }
  return cities;
}

async function main(csvPath) {
  if (!csvPath) throw new Error("請指定門市 CSV 路徑");
  const cities = groupStores(parseCsv(await readFile(csvPath, "utf8")));
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const index = [];
  let total = 0;
  for (const [city, slug] of Object.entries(CITY_SLUGS)) {
    const districts = cities.get(city);
    if (!districts) continue;
    const sorted = [...districts.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
    const data = Object.fromEntries(sorted.map((district) => [district, districts.get(district).sort((a, b) => a[1].localeCompare(b[1], "zh-Hant"))]));
    total += sorted.reduce((sum, district) => sum + data[district].length, 0);
    index.push([city, slug, sorted]);
    await writeFile(join(OUT_DIR, `${slug}.json`), JSON.stringify(data));
  }
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index));
  console.log(`已產生 ${index.length} 個縣市、${total} 間門市`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv[2]);
