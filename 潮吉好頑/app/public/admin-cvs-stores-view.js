// 後台「7-11 門市」面板的畫面組裝：只回傳 HTML 字串。上傳內容是不受信任的資料，所有店名／地址一律 escapeHtml。
import { escapeHtml } from "./product-format.js";

const shortId = (id) => (id ? String(id).slice(0, 8) : "—");

export function currentCardHtml(list, formatTime) {
  const { current, published = [], staged = [] } = list;
  const status = current
    ? `<p class="cvs-admin-status"><strong>後台上傳的版本</strong>・共 ${Number(current.total)} 間<small>發佈於 ${escapeHtml(formatTime(current.publishedAt))}・管理員 ${escapeHtml(shortId(current.publishedBy))}</small></p>`
    : '<p class="cvs-admin-status"><strong>內建檔案</strong>・尚未從後台上傳過<small>結帳目前使用網站程式內附的門市清單。</small></p>';
  const rows = published.map((item) => `<li class="${item.is_current ? "is-current" : ""}">
      <div><strong>${escapeHtml(formatTime(item.published_at))}</strong><small>${Number(item.total)} 間・管理員 ${escapeHtml(shortId(item.published_by))}</small></div>
      ${item.is_current ? '<span class="cvs-admin-badge">使用中</span>' : `<button class="secondary-button" type="button" data-cvs-rollback="${escapeHtml(item.version)}">回復這一版</button>`}
    </li>`).join("");
  const history = published.length ? `<h4>歷史版本（保留最近 5 版）</h4><ul class="cvs-admin-history">${rows}</ul>` : "";
  const baseline = current ? '<button class="secondary-button" type="button" data-cvs-baseline>回到內建檔案</button>' : "";
  const leftover = staged.length ? `<p class="cvs-admin-note">有 ${staged.length} 份未完成發佈的暫存，下次發佈時會自動清掉。</p>` : "";
  return `<div class="cvs-admin-card">${status}${baseline ? `<div class="form-actions">${baseline}</div>` : ""}${history}${leftover}</div>`;
}

const signed = (value) => (value > 0 ? `+${value}` : String(value));

function storeList(title, items, cls) {
  if (!items.length) return "";
  const rows = items.map((store) => `<li><code>${escapeHtml(store.code)}</code> ${escapeHtml(store.city)}${escapeHtml(store.district)}　${escapeHtml(store.name)}<small>${escapeHtml(store.address)}</small></li>`).join("");
  return `<details class="cvs-admin-detail ${cls}"><summary>${escapeHtml(title)}（顯示前 ${items.length} 筆）</summary><ul>${rows}</ul></details>`;
}

export function previewHtml(plan, fileName, { downloadable = false } = {}) {
  const blocked = plan.blockers.length > 0;
  const blockers = blocked ? `<ul class="cvs-admin-blockers" role="alert">${plan.blockers.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : "";
  const notes = [];
  if (plan.skipped > 0) notes.push(`有 ${plan.skipped} 列不合規（未知縣市、店號不是 6 碼數字、缺鄉鎮區或店名）已略過。`);
  const cityRows = plan.perCity.map((row) => `<tr class="${row.added || row.removed || row.changed ? "has-change" : ""}">
      <th scope="row">${escapeHtml(row.city)}</th><td>${row.before}</td><td>${row.after}</td>
      <td>${row.added ? signed(row.added) : "—"}</td><td>${row.removed ? signed(-row.removed) : "—"}</td><td>${row.changed || "—"}</td></tr>`).join("");
  return `<div class="cvs-admin-card" data-cvs-preview>
    <p class="cvs-admin-status"><strong>${escapeHtml(fileName)}</strong>・共 ${plan.total} 間<small>目前使用中 ${plan.beforeTotal} 間</small></p>
    <dl class="cvs-admin-kpis"><div><dt>新增</dt><dd>${plan.added}</dd></div><div><dt>移除</dt><dd>${plan.removed}</dd></div><div><dt>地址／店名變更</dt><dd>${plan.changed}</dd></div></dl>
    ${blockers}${notes.map((text) => `<p class="cvs-admin-note">${escapeHtml(text)}</p>`).join("")}
    <div class="cvs-admin-table-wrap"><table class="cvs-admin-table"><thead><tr><th scope="col">縣市</th><th scope="col">原有</th><th scope="col">新版</th><th scope="col">新增</th><th scope="col">移除</th><th scope="col">變更</th></tr></thead><tbody>${cityRows}</tbody></table></div>
    ${storeList("新增的門市", plan.addedList, "is-added")}${storeList("移除的門市", plan.removedList, "is-removed")}
    <div class="form-actions"><button class="primary-button" type="button" data-cvs-publish ${blocked ? "disabled" : ""}>確認並發佈</button>${downloadable ? '<button class="secondary-button" type="button" data-cvs-download>下載 CSV</button>' : ""}<button class="secondary-button" type="button" data-cvs-cancel>取消</button></div>
    <p class="cvs-admin-note">發佈後客人結帳約 10 分鐘內換成新清單；已選好的舊門市仍可送出訂單。</p>
  </div>`;
}

export function progressHtml(step, total, label) {
  return `<div class="cvs-admin-card" role="status"><p class="cvs-admin-status"><strong>${escapeHtml(label)}</strong><small>${step} / ${total}，請勿關閉頁面</small></p><progress max="${total}" value="${step}"></progress></div>`;
}

export function uploadFormHtml() {
  return `<div class="cvs-admin-card"><div class="form-actions"><button class="primary-button" type="button" data-cvs-fetch>從 7-11 官方網站抓取</button></div>
    <p class="cvs-admin-note">由網站代為查詢全台門市（約 3–5 分鐘，請勿關閉頁面），完成後先比對差異，確認才發佈；也可以下載 CSV 留存。任何鄉鎮查不到時不會產生結果，可稍後重試或改用 <code>scripts/fetch_711_stores.py</code>。</p>
    <label class="cvs-admin-file">選擇門市 CSV<input id="admin-cvs-file" type="file" accept=".csv,text/csv" /></label>
    <p class="cvs-admin-note">需要 6 欄、不含標題列：縣市,鄉鎮區,店號,路名,店名,地址（<code>scripts/fetch_711_stores.py</code> 產生的 <code>711_stores_sorted.csv</code>）。選檔後會先比對差異，確認後才會發佈。</p></div>`;
}

/** 抓取後仍有縣市或鄉鎮查不到：不產生預覽、不能發佈，避免那些門市從結帳清單消失 */
export function fetchFailedHtml(failed) {
  const shown = failed.slice(0, 30).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const more = failed.length > 30 ? `<li>…另 ${failed.length - 30} 個</li>` : "";
  return `<div class="cvs-admin-card"><p class="cvs-admin-status"><strong class="form-error">有 ${failed.length} 個縣市／鄉鎮查不到，未產生新的門市清單</strong><small>官方網站可能暫時忙碌，請稍後再試；不會影響目前使用中的清單。</small></p>
    <ul class="cvs-admin-blockers" role="alert">${shown}${more}</ul>
    <div class="form-actions"><button class="primary-button" type="button" data-cvs-fetch>重新抓取</button><button class="secondary-button" type="button" data-cvs-cancel>返回</button></div></div>`;
}
