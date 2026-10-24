// 後台「預購叫貨」統計表畫面（純函式，不碰 DOM，方便測試）。
import { escapeHtml } from "./product-format.js";

const HEAD = '<thead><tr><th>商品</th><th>規格</th><th class="num">已付款（待叫貨）</th><th class="num">待付款／待核對</th><th class="num">已到貨／完成</th></tr></thead>';

const count = (value) => Number(value || 0);

/** 統計表畫面；rows 為 API 回傳的 preorderDemand。沒有資料時顯示說明文字。 */
export function preorderDemandHtml(rows) {
  if (!rows?.length) return '<p class="cvs-admin-note">目前沒有預購訂單。</p>';
  const body = rows.map((row) => {
    const arrival = row.arrival ? `<span class="cell-sub">${escapeHtml(row.arrival)}</span>` : "";
    return `<tr><td data-l="商品"><strong>${escapeHtml(row.product_name)}</strong>${arrival}</td>`
      + `<td data-l="規格">${escapeHtml(row.variant_name)}</td>`
      + `<td data-l="已付款（待叫貨）" class="num"><strong>${count(row.paid)}</strong></td>`
      + `<td data-l="待付款／待核對" class="num">${count(row.unpaid)}</td>`
      + `<td data-l="已到貨／完成" class="num">${count(row.arrived)}</td></tr>`;
  }).join("");
  const total = rows.reduce((sum, row) => sum + count(row.paid), 0);
  return `<div class="admin-table-wrap"><table class="admin-stack-table">${HEAD}<tbody>${body}</tbody></table></div>`
    + `<p class="preorder-demand-total">已付款合計 <strong>${total}</strong> 件</p>`;
}
