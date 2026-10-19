// 後台「7-11 門市」分頁：上傳門市 CSV → 比對目前清單 → 逐縣市暫存 → 發佈；歷史版本回復與回到內建檔案。
// 解析與比對在 cvs-stores-data.js（與 scripts/build-cvs-stores.mjs 共用），伺服器端規則在 src/cvs-stores-admin.ts。
import { adminFetch, adminTabHooks } from "./admin-app.js";
import { escapeHtml } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { formatDateTime, showToast, taipeiDateTimeInputValue } from "./app-core.js";
import { CITY_SLUGS, newVersionId, planStoreUpload } from "./cvs-stores-data.js";
import { currentCardHtml, fetchFailedHtml, previewHtml, progressHtml, uploadFormHtml } from "./admin-cvs-stores-view.js";
import { downloadCsv, fetchOfficialStores } from "./cvs-stores-fetch.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const formatTime = (value) => (value ? formatDateTime(value) : "—");

let list = null;
let plan = null;
let fileName = "";
let busy = false;
let loadError = "";
// 從官方網站抓取時產生的 CSV（可下載）；fetchFailed 是查不到的縣市／鄉鎮，有值時不產生預覽
let generatedCsv = null;
let fetchFailed = null;

const body = () => document.querySelector("#admin-cvs-stores-body");

function render(progress = null) {
  const root = body();
  if (!root) return;
  const current = list ? currentCardHtml(list, formatTime) : `<div class="cvs-admin-card"><p class="cvs-admin-status">${loadError ? `<strong class="form-error">${escapeHtml(loadError)}</strong>` : "<strong>載入中…</strong>"}</p></div>`;
  const upload = progress ? progressHtml(progress.step, progress.total, progress.label)
    : fetchFailed ? fetchFailedHtml(fetchFailed)
    : plan ? previewHtml(plan, fileName, { downloadable: Boolean(generatedCsv) }) : uploadFormHtml();
  root.innerHTML = `<h3>目前使用的門市清單</h3>${current}<h3>上傳新的門市 CSV</h3>${upload}`;
}

async function loadList() {
  try {
    list = await adminFetch("/api/admin/cvs-stores");
    loadError = "";
  } catch (error) {
    list = null;
    loadError = error.message;
  }
  render();
}

/** 目前使用中的各縣市檔（不走瀏覽器快取），用來和新 CSV 比對；沒有的縣市（如內建檔沒有金門）略過。 */
async function fetchCurrentFiles() {
  const entries = await Promise.all(Object.values(CITY_SLUGS).map(async (slug) => {
    const response = await fetch(`/cvs-stores/${slug}.json`, { cache: "no-cache" });
    if (response.status === 404) return [slug, null];
    if (!response.ok) throw new Error("無法讀取目前的門市清單，請稍後再試");
    return [slug, await response.json()];
  }));
  return Object.fromEntries(entries.filter(([, data]) => data));
}

async function chooseFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("檔案過大，請確認是門市 CSV");
    const [text, currentFiles] = await Promise.all([file.text(), fetchCurrentFiles()]);
    plan = planStoreUpload(text, currentFiles);
    fileName = file.name;
    generatedCsv = null;
  } catch (error) {
    plan = null;
    showToast(error.message, "error");
  }
  render();
}

/** 由 Worker 代查官方電子地圖，產生與 Python 腳本相同的 CSV，再走上傳比對流程；任何鄉鎮失敗就不產生預覽 */
async function fetchFromOfficial() {
  if (busy) return;
  busy = true;
  plan = null;
  generatedCsv = null;
  fetchFailed = null;
  try {
    const result = await fetchOfficialStores((body) => adminFetch("/api/admin/cvs-stores/fetch", { method: "POST", body: JSON.stringify(body) }), {
      onProgress: ({ city, cityIndex, cityTotal, townsDone, townsTotal }) => render({ step: cityIndex, total: cityTotal, label: `抓取 ${city}${townsTotal ? `（${townsDone}/${townsTotal} 鄉鎮）` : ""}` })
    });
    if (result.failed.length) {
      fetchFailed = result.failed;
    } else {
      plan = planStoreUpload(result.csv, await fetchCurrentFiles());
      generatedCsv = result.csv;
      fileName = `7-11 官方網站（${taipeiDateTimeInputValue(new Date()).slice(0, 10)} 抓取）`;
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    busy = false;
    render();
  }
}

async function publish(button) {
  if (busy || !plan || plan.blockers.length) return;
  const confirmed = await adminConfirm({
    title: "發佈新的門市清單？",
    details: [["門市總數", `${plan.total} 間（原 ${plan.beforeTotal} 間）`], ["新增／移除／變更", `${plan.added}／${plan.removed}／${plan.changed}`]],
    message: "客人結帳會在約 10 分鐘內換成新清單；之後可在這裡回復舊版。",
    confirmLabel: "發佈",
    trigger: button
  });
  if (!confirmed) return;
  busy = true;
  const version = newVersionId();
  const cities = Object.keys(CITY_SLUGS);
  try {
    for (const [index, city] of cities.entries()) {
      render({ step: index, total: cities.length + 1, label: `上傳 ${city}` });
      await adminFetch("/api/admin/cvs-stores/stage", { method: "PUT", body: JSON.stringify({ version, city, data: plan.files[CITY_SLUGS[city]] }) });
    }
    render({ step: cities.length, total: cities.length + 1, label: "發佈中" });
    const result = await adminFetch("/api/admin/cvs-stores/publish", { method: "POST", body: JSON.stringify({ version }) });
    showToast(`已發佈 ${result.total} 間門市`, "success");
    plan = null;
    generatedCsv = null;
  } catch (error) {
    // 保留預覽讓管理員修正後重試；已暫存的內容不會生效
    showToast(error.message, "error");
  } finally {
    busy = false;
    await loadList();
  }
}

async function rollback(version, button) {
  if (busy) return;
  const toBaseline = version === null;
  const confirmed = await adminConfirm({
    title: toBaseline ? "回到內建的門市清單？" : "回復到這個版本？",
    message: toBaseline ? "結帳會改用網站程式內附的門市清單（上傳過的版本仍保留，之後可再回復）。" : "結帳會在約 10 分鐘內換回這一版。",
    confirmLabel: "確認回復",
    danger: true,
    trigger: button
  });
  if (!confirmed) return;
  busy = true;
  try {
    await adminFetch("/api/admin/cvs-stores/rollback", { method: "POST", body: JSON.stringify({ version }) });
    showToast("已回復", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    busy = false;
    await loadList();
  }
}

function bind() {
  const root = body();
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "true";
  root.addEventListener("change", (event) => {
    if (event.target.matches("#admin-cvs-file")) chooseFile(event.target);
  });
  root.addEventListener("click", (event) => {
    const publishButton = event.target.closest("[data-cvs-publish]");
    if (publishButton) return void publish(publishButton);
    const rollbackButton = event.target.closest("[data-cvs-rollback]");
    if (rollbackButton) return void rollback(rollbackButton.dataset.cvsRollback, rollbackButton);
    const baselineButton = event.target.closest("[data-cvs-baseline]");
    if (baselineButton) return void rollback(null, baselineButton);
    if (event.target.closest("[data-cvs-fetch]")) return void fetchFromOfficial();
    if (event.target.closest("[data-cvs-download]") && generatedCsv) return void downloadCsv(generatedCsv, `711_stores_sorted-${taipeiDateTimeInputValue(new Date()).slice(0, 10)}.csv`);
    if (event.target.closest("[data-cvs-cancel]")) {
      plan = null;
      generatedCsv = null;
      fetchFailed = null;
      render();
    }
  });
}

// admin-app.js 切到此分頁（或按重新整理）時呼叫；這個分頁不走 /api/admin/dashboard
adminTabHooks.set("cvs-stores", () => {
  bind();
  list = null;
  render();
  return loadList();
});
