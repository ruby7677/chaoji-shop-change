// 後台訂單卡的匯款末五碼：店長要拿去比對銀行明細，數字放大加粗並加淡黃底；未回報時只顯示灰字，不像已有資料。
import { escapeHtml } from "./product-format.js";

export function lastFiveMarkup(value, missingLabel = "尚未回報") {
  return value
    ? `<b class="admin-last-five">${escapeHtml(value)}</b>`
    : `<span class="admin-last-five-missing">${escapeHtml(missingLabel)}</span>`;
}
