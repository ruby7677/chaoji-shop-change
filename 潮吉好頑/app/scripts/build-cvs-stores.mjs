// 由 7-ELEVEN 門市 CSV（縣市,鄉鎮區,店號,路名,店名,地址）產生結帳用的門市資料：
// public/cvs-stores/index.json（縣市→鄉鎮區）與每個縣市一個 <slug>.json（鄉鎮區→門市），前台選定縣市時才載入。
// 用法：node scripts/build-cvs-stores.mjs <711_stores.csv>
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoreFiles, groupStores, parseCsv } from "../public/cvs-stores-data.js";

// 解析與分組邏輯在 public/cvs-stores-data.js（後台上傳頁共用）；這裡保留匯出，舊的呼叫端與測試不變
export { groupStores, parseCsv };

const OUT_DIR = fileURLToPath(new URL("../public/cvs-stores/", import.meta.url));
async function main(csvPath) {
  if (!csvPath) throw new Error("請指定門市 CSV 路徑");
  const cities = groupStores(parseCsv(await readFile(csvPath, "utf8")));
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const { index, files, total } = buildStoreFiles(cities);
  for (const [slug, data] of Object.entries(files)) await writeFile(join(OUT_DIR, `${slug}.json`), JSON.stringify(data));
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(index));
  console.log(`已產生 ${index.length} 個縣市、${total} 間門市`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv[2]);
