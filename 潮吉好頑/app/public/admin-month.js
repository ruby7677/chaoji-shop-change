// 後台月份篩選共用：月份一律是台灣時間的 YYYY-MM（與資料庫 private.admin_month_range 相同），"all" 代表不限月份。
// 業績卡（admin-sales-summary.js）與訂單頁月份下拉（admin-orders-ui.js）共用。
import { escapeHtml } from "./product-format.js";

export const ALL_MONTHS = "all";
// 已結案的分類筆數會一直累積，預設只看當月；其餘待處理分類預設全部月份，避免跨月的預購單被藏起來
const CURRENT_MONTH_STAGES = new Set(["completed", "cancelled"]);

const ORDER_MONTH_SELECTOR = "#admin-order-month-filter";

export function taipeiMonth(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date).slice(0, 7);
}

export function monthLabel(month) {
  if (month === ALL_MONTHS) return "全部月份";
  const [year, monthNumber] = String(month).split("-");
  return `${year} 年 ${Number(monthNumber)} 月`;
}

// 選項：全部月份＋有訂單的月份（新到舊）；當月與目前選取值即使沒有訂單也列出
export function monthOptionsMarkup(months, selected) {
  const list = new Set([taipeiMonth(), ...(Array.isArray(months) ? months : []).filter((month) => /^\d{4}-\d{2}$/.test(month))]);
  if (selected && selected !== ALL_MONTHS) list.add(selected);
  const sorted = [...list].sort().reverse();
  return [ALL_MONTHS, ...sorted]
    .map((month) => `<option value="${escapeHtml(month)}"${month === selected ? " selected" : ""}>${escapeHtml(monthLabel(month))}</option>`)
    .join("");
}

export function defaultOrderMonth(status) {
  return CURRENT_MONTH_STAGES.has(status) ? taipeiMonth() : ALL_MONTHS;
}

export function orderMonthSelect() {
  return document.querySelector(ORDER_MONTH_SELECTOR);
}

// 切換訂單分類時套用該分類的預設月份（之後可再自行下拉）
export function resetOrderMonth(status) {
  const select = orderMonthSelect();
  if (!select) return;
  const month = defaultOrderMonth(status);
  if (![...select.options].some((option) => option.value === month)) select.add(new Option(monthLabel(month), month), 1);
  select.value = month;
}

// 訂單查詢帶的月份：搜尋關鍵字時一律不限月份（例如從待辦跳到上個月的訂單）
export function orderMonthQuery(searchKeyword) {
  if (searchKeyword) return ALL_MONTHS;
  return orderMonthSelect()?.value || ALL_MONTHS;
}
