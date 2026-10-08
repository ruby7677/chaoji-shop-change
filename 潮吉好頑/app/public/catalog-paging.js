// 首頁商品列表分批顯示：一次畫 PAGE_SIZE 件，「載入更多商品」再多畫一批。
// 型錄 API 仍一次取得全部商品（搜尋與系列篩選用完整清單）；這裡只控制畫出幾張卡。
// 切換系列或改搜尋字從頭顯示；同一個清單重畫（加入購物車、庫存更新）時保留已展開的數量。
// 已展開的數量記在 sessionStorage：從商品頁回來或重新整理後，才能捲回原本停留的位置。
import { escapeHtml } from "./product-format.js";

export const PAGE_SIZE = 40;
const STORAGE_KEY = "cj-catalog-limit";

let currentKey = null;
let limit = PAGE_SIZE;

function readStoredLimit(key) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    return stored?.key === key && Number.isInteger(stored.limit) && stored.limit > PAGE_SIZE ? stored.limit : PAGE_SIZE;
  } catch {
    return PAGE_SIZE;
  }
}

function storeLimit() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ key: currentKey, limit })); } catch { /* restricted storage */ }
}

/** 依目前的系列與搜尋字決定要畫幾件；清單條件改變時回到第一批。 */
export function visibleLimit(listKey) {
  if (listKey !== currentKey) {
    // 第一次（開機）沿用 sessionStorage 記住的數量；之後切換條件一律從第一批開始
    limit = currentKey === null ? readStoredLimit(listKey) : PAGE_SIZE;
    currentKey = listKey;
  }
  return limit;
}

/** 多顯示一批，回傳展開前已顯示的件數（用來替新出現的卡片加上淡入效果）。 */
export function showMore() {
  const previous = limit;
  limit += PAGE_SIZE;
  storeLimit();
  return previous;
}

export function loadMoreMarkup(shown, total) {
  const left = total - shown;
  if (left <= 0) return total > PAGE_SIZE ? `<p class="catalog-more-done">已顯示全部 ${total} 件商品</p>` : "";
  const next = Math.min(PAGE_SIZE, left);
  return `<span class="catalog-more-count">已顯示 ${shown} / ${total} 件</span>`
    + `<button class="catalog-more-button" type="button" data-catalog-more>載入更多商品 <span class="catalog-more-next" aria-label="再顯示 ${next} 件">+${escapeHtml(String(next))}</span></button>`;
}
