// 前台 JS 預先載入：入口 module 靜態 import 的檔案分好幾層（app.js → 約 22 個 → 約 21 個 → …），瀏覽器要等上一層下載完
// 才知道下一層要抓什麼，每層至少一次往返；JS 沒有雜湊檔名，每次開啟都要逐一向伺服器確認（304）。
// 在 HTML 列出整棵 import 樹的 <link rel="modulepreload">，讓瀏覽器解析 <head> 時就同時發出全部請求。
// 清單用 esbuild 的 metafile 從入口起只沿著靜態 import 產生（後台的動態 import 不列入，維持延後載入）。
// 頁面與入口見 PAGES（首頁 index.html、獨立訂單頁 orders.html）。
// 不在 wrangler build 自動改寫 HTML：改了 import 後執行 node scripts/build-modulepreload.mjs，
// 清單過期時 tests/frontend/modulepreload.test.mjs 會失敗。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PUBLIC_DIR, normalizeNewlines } from "./build-css.mjs";

export const PAGES = [
  { html: "index.html", entry: "app.js" },
  { html: "orders.html", entry: "orders-page.js" }
];
export const START_MARKER = "<!-- modulepreload:start（node scripts/build-modulepreload.mjs 產生，請勿手改） -->";
export const END_MARKER = "<!-- modulepreload:end -->";

/** 入口靜態 import 樹的所有 module（不含入口本身），依層級先後排列。 */
export async function modulepreloadPaths(entry) {
  const result = await build({
    absWorkingDir: PUBLIC_DIR,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent"
  });
  const inputs = result.metafile.inputs;
  const seen = new Set([entry]);
  const order = [];
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    for (const { path, kind } of inputs[current]?.imports || []) {
      if (kind !== "import-statement" || seen.has(path)) continue;
      seen.add(path);
      order.push(path);
      queue.push(path);
    }
  }
  return order;
}

export function modulepreloadBlock(paths) {
  return [START_MARKER, ...paths.map((path) => `<link rel="modulepreload" href="/${path}" />`), END_MARKER]
    .map((line) => `  ${line}`).join("\n");
}

/** 把 HTML 的標記區段換成 block；找不到標記時丟錯，避免靜默略過。 */
export function replaceBlock(html, block) {
  const text = normalizeNewlines(html);
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start < 0 || end < start) throw new Error("HTML 缺少 modulepreload 標記區段");
  const lineStart = text.lastIndexOf("\n", start) + 1;
  return text.slice(0, lineStart) + block + text.slice(end + END_MARKER.length);
}

/** 更新一個頁面的清單；回傳是否有變更。 */
export async function buildModulepreload({ html, entry }) {
  const path = join(PUBLIC_DIR, html);
  const current = await readFile(path, "utf8");
  const next = replaceBlock(current, modulepreloadBlock(await modulepreloadPaths(entry)));
  if (normalizeNewlines(current) === next) return false;
  // 維持檔案原本的換行格式
  await writeFile(path, current.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const page of PAGES) {
    console.log(await buildModulepreload(page) ? `${page.html} 的 modulepreload 清單已更新` : `${page.html} 的 modulepreload 清單已是最新`);
  }
}
