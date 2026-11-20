// 營運概況的月份業績卡：業績（不含運費）、已收金額、未收金額（含運費）。
// 預設顯示當月（台灣時間），資料隨概況回應（overview.salesSummary）一起載入；換月份才另外請求 section=sales。
// 計算規則在資料庫 admin_sales_summary：不含待付訂與失效訂單，月份依建單日期。
import { escapeHtml, money } from "./product-format.js";
import { ALL_MONTHS, monthLabel, monthOptionsMarkup, taipeiMonth } from "./admin-month.js";

let deps = null;
let card = null;
// null＝跟著概況顯示當月；使用者選過月份後保留選擇
let selectedMonth = null;
let requestId = 0;
let lastMonths = [];

function statMarkup(label, value, note) {
  return `<div class="admin-sales-stat"><small>${escapeHtml(label)}</small><b>${money(value)}</b>${note ? `<span>${escapeHtml(note)}</span>` : ""}</div>`;
}

function render(summary, month, message = "") {
  if (Array.isArray(summary?.months)) lastMonths = summary.months;
  const title = month === ALL_MONTHS ? "全部業績" : `${monthLabel(month)}業績`;
  const body = summary
    ? `<div class="admin-sales-stats">${statMarkup("業績", summary.revenue, "商品金額，不含運費")}${statMarkup("已收金額", summary.received)}${statMarkup("未收金額", summary.outstanding, "含運費")}</div>
       <p class="admin-sales-note">${escapeHtml(`${Number(summary.orderCount || 0)} 筆訂單；不含待付訂與失效訂單，依建單日期（台灣時間）計算`)}</p>`
    : `<p class="admin-dash-empty" role="alert">${escapeHtml(message || "業績載入失敗，請按右上角重新整理。")}</p>`;
  card.innerHTML = `<header><div><h3>${escapeHtml(title)}</h3></div>
    <label class="admin-sales-month"><span class="sr-only">業績月份</span><select data-admin-sales-month aria-label="業績月份">${monthOptionsMarkup(lastMonths, month)}</select></label></header>${body}`;
}

async function load(month) {
  const current = ++requestId;
  card.setAttribute("aria-busy", "true");
  try {
    const result = await deps.adminFetch(`/api/admin/dashboard?section=sales&month=${encodeURIComponent(month)}`);
    if (current === requestId) render(result.salesSummary, month);
  } catch (error) {
    if (current === requestId) render(null, month, error.status === 429 ? "操作太頻繁，請 1 分鐘後再試。" : `業績載入失敗：${error.message || "未知錯誤"}`);
  } finally {
    if (current === requestId) card.removeAttribute("aria-busy");
  }
}

// 概況資料載入或更新後呼叫（admin-overview.js 的 renderLatest）；選了其他月份時重新查詢該月，讓訂單操作後的數字也更新
export function syncSalesSummary(overview) {
  if (!card) return;
  const summary = overview?.salesSummary || null;
  const month = summary?.month || taipeiMonth();
  if (selectedMonth && selectedMonth !== month) return void load(selectedMonth);
  requestId += 1;
  card.removeAttribute("aria-busy");
  render(summary, month);
}

export function initAdminSalesSummary(dependencies, panel, before) {
  if (card || !panel) return;
  deps = dependencies;
  card = document.createElement("section");
  card.className = "admin-dash-card admin-sales";
  card.setAttribute("aria-live", "polite");
  panel.insertBefore(card, before || null);
  card.innerHTML = '<p class="admin-dash-empty">載入業績中…</p>';
  card.addEventListener("change", (event) => {
    const select = event.target.closest("[data-admin-sales-month]");
    if (!select) return;
    selectedMonth = select.value;
    const overviewSummary = deps.getOverview?.()?.salesSummary;
    if (overviewSummary && overviewSummary.month === selectedMonth) return syncSalesSummary(deps.getOverview());
    load(selectedMonth);
  });
}
