// 首頁 JS 預先載入：app.js 靜態 import 的 module 分好幾層（app.js → 約 22 個 → 約 21 個 → …），瀏覽器要等上一層下載完
// 才知道下一層要抓什麼，每層至少一次往返；JS 沒有雜湊檔名，每次開啟都要逐一向伺服器確認（304）。
// 在 index.html 列出整棵 import 樹的 <link rel="modulepreload">，讓瀏覽器解析 <head> 時就同時發出全部請求。
// 清單用 esbuild 的 metafile 從 app.js 起只沿著靜態 import 產生（後台的動態 import 不列入，維持延後載入）。
// 不在 wrangler build 自動改寫 index.html：改了 import 後執行 node scripts/build-modulepreload.mjs，
// 清單過期時 tests/frontend/modulepreload.test.mjs 會失敗。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PUBLIC_DIR, normalizeNewlines } from "./build-css.mjs";

export const ENTRY = "app.js";
export const START_MARKER = "<!-- modulepreload:start（node scripts/build-modulepreload.mjs 產生，請勿手改） -->";
export const END_MARKER = "<!-- modulepreload:end -->";

/** app.js 靜態 import 樹的所有 module（不含 app.js 本身），依層級先後排列。 */
export async function modulepreloadPaths() {
  const result = await build({
    absWorkingDir: PUBLIC_DIR,
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent"
  });
  const inputs = result.metafile.inputs;
  const seen = new Set([ENTRY]);
  const order = [];
  const queue = [ENTRY];
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

/** 把 index.html 的標記區段換成 block；找不到標記時丟錯，避免靜默略過。 */
export function replaceBlock(html, block) {
  const text = normalizeNewlines(html);
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  if (start < 0 || end < start) throw new Error("index.html 缺少 modulepreload 標記區段");
  const lineStart = text.lastIndexOf("\n", start) + 1;
  return text.slice(0, lineStart) + block + text.slice(end + END_MARKER.length);
}

export async function buildModulepreload() {
  const path = join(PUBLIC_DIR, "index.html");
  const current = await readFile(path, "utf8");
  const next = replaceBlock(current, modulepreloadBlock(await modulepreloadPaths()));
  if (normalizeNewlines(current) === next) return false;
  // 維持檔案原本的換行格式
  await writeFile(path, current.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await buildModulepreload() ? "index.html 的 modulepreload 清單已更新" : "modulepreload 清單已是最新");
}
