// 首頁 CSS 合併：把 index.html 中連續的前台樣式合併成一個檔，減少開頁時必須先下載（或逐一向伺服器確認）的 CSS 數量。
// 後台樣式（data-admin-href）在原位置延後載入，它們之間的前台檔案不能跨過去合併，否則後台頁面的覆寫順序會改變；
// 因此依 index.html 的順序分成數段，每段依序串接。原始檔仍是編輯的對象，合併檔由這支程式產生（部署時 wrangler build 會自動執行）。
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

// 順序就是 cascade 順序；改動時同步調整 index.html 中合併檔與後台 <link> 的相對位置
export const CSS_BUNDLES = {
  "bundle-base.css": ["styles.css", "storefront-refinements.css"],
  "bundle-storefront.css": [
    "product-showcase.css", "hero-desktop.css", "hero-ratio.css", "store-info.css", "product-page.css",
    "storefront-legibility.css", "hero-flag-shine.css", "header-orders.css", "card-subgrid.css",
    "filter-chips.css", "catalog-paging.css"
  ]
};

const CHARSET = /^﻿?@charset\s+"UTF-8";\s*/i;

export async function bundleContent(name) {
  const parts = await Promise.all(CSS_BUNDLES[name].map(async (file) => {
    const css = (await readFile(join(PUBLIC_DIR, file), "utf8")).replace(CHARSET, "").trimEnd();
    return `/* ==== ${file} ==== */\n${css}\n`;
  }));
  return `@charset "UTF-8";\n/* 自動產生（scripts/build-css.mjs），請改原始檔：${CSS_BUNDLES[name].join("、")} */\n${parts.join("")}`;
}

export async function buildCss() {
  const changed = [];
  for (const name of Object.keys(CSS_BUNDLES)) {
    const path = join(PUBLIC_DIR, name);
    const next = await bundleContent(name);
    const current = await readFile(path, "utf8").catch(() => null);
    // 內容相同不寫入，避免 wrangler dev 監看 public/ 時重複觸發
    if (current !== next) {
      await writeFile(path, next);
      changed.push(name);
    }
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = await buildCss();
  console.log(changed.length ? `CSS 合併檔已更新：${changed.join("、")}` : "CSS 合併檔已是最新");
}
