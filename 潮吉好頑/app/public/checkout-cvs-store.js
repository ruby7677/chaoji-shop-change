// 結帳第二步的 7-11 取件門市：縣市→鄉鎮區→門市下拉（資料在 /cvs-stores/，由 scripts/build-cvs-stores.mjs 產生），
// 選門市後自動帶入名稱與 6 碼店號；找不到門市時可改為手動填寫。記住上次選的門市。
import { escapeHtml } from "./product-format.js";
import { CVS_STORE_LOOKUP_URL } from "./cvs-delivery.js";
import { createExpiringCache } from "./expiring-cache.js";

const LAST_STORE_KEY = "cj-cvs-pickup-store";
const MANUAL = "manual";
// 後台隨時可能發佈新的門市清單（伺服器端快取 5 分鐘）：頁面內的快取也只保留同樣久，到期後整批重新載入
const storeCache = createExpiringCache(5 * 60 * 1000);

const $ = (selector) => document.querySelector(selector);

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error("門市資料載入失敗");
  return response.json();
}

function loadCityIndex() {
  return storeCache.get("index", () => fetchJson("/cvs-stores/index.json"));
}

function loadCityStores(slug) {
  return storeCache.get(slug, () => fetchJson(`/cvs-stores/${slug}.json`));
}

function setOptions(select, options, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>${options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("")}`;
  select.disabled = !options.length;
}

function showLoadError() {
  $("#checkout-cvs-load-error")?.classList.remove("hidden");
}

async function fillDistricts(selected = "") {
  const city = $("#checkout-cvs-city").value;
  const entry = (await loadCityIndex()).find(([name]) => name === city);
  if ($("#checkout-cvs-city").value !== city) return; // 等待期間已改選其他縣市
  setOptions($("#checkout-cvs-district"), (entry?.[2] || []).map((name) => [name, name]), city ? "請選擇鄉鎮區" : "請先選擇縣市");
  if (entry?.[2].includes(selected)) $("#checkout-cvs-district").value = selected;
  await fillStores();
}

async function fillStores(selectedCode = "") {
  const city = $("#checkout-cvs-city").value;
  const district = $("#checkout-cvs-district").value;
  const select = $("#checkout-cvs-store");
  const entry = (await loadCityIndex()).find(([name]) => name === city);
  const stores = entry && district ? (await loadCityStores(entry[1]))[district] || [] : [];
  // 較慢的舊請求晚到時不可覆寫目前選擇，否則縣市／區與門市會不一致
  if ($("#checkout-cvs-city").value !== city || $("#checkout-cvs-district").value !== district) return;
  setOptions(select, stores.map(([code, name]) => [code, `${name}（${code}）`]), district ? "請選擇取件門市" : "請先選擇鄉鎮區");
  stores.forEach(([, , address], index) => { select.options[index + 1].dataset.address = address || ""; });
  if (stores.length) select.insertAdjacentHTML("beforeend", `<option value="${MANUAL}">找不到門市，手動填寫</option>`);
  if (selectedCode && [...select.options].some((option) => option.value === selectedCode)) select.value = selectedCode;
  applyStoreChoice();
}

function setManualMode(manual) {
  $("#checkout-cvs-manual")?.classList.toggle("hidden", !manual);
}

function applyStoreChoice() {
  const select = $("#checkout-cvs-store");
  const choice = select.value;
  setManualMode(choice === MANUAL);
  const address = $("#checkout-cvs-store-address");
  const storeAddress = choice && choice !== MANUAL ? select.selectedOptions[0]?.dataset.address || "" : "";
  if (address) { address.textContent = storeAddress ? `門市地址：${storeAddress}` : ""; address.classList.toggle("hidden", !storeAddress); }
  if (choice === MANUAL || !choice) {
    if (!choice) { $("#checkout-cvs-store-name").value = ""; $("#checkout-cvs-store-code").value = ""; }
    return;
  }
  const label = select.selectedOptions[0]?.textContent || "";
  $("#checkout-cvs-store-name").value = label.slice(0, label.indexOf("（"));
  $("#checkout-cvs-store-code").value = choice;
}

function readLastStore() {
  try { return JSON.parse(localStorage.getItem(LAST_STORE_KEY) || "null"); } catch { return null; }
}

export function rememberCvsStore(store) {
  try { localStorage.setItem(LAST_STORE_KEY, JSON.stringify(store)); } catch { /* 無法保存時下次重新選擇 */ }
}

const field = (id, label, control) => `<label id="${id}-label">${label} ${control}<small id="${id}-error" class="field-error hidden" role="alert"></small></label>`;

async function restoreStores() {
  try {
    const index = await loadCityIndex();
    const last = readLastStore();
    setOptions($("#checkout-cvs-city"), index.map(([name]) => [name, name]), "請選擇縣市");
    if (!last?.city || !index.some(([name]) => name === last.city)) return fillDistricts();
    $("#checkout-cvs-city").value = last.city;
    await fillDistricts(last.district);
    const known = [...$("#checkout-cvs-store").options].some((option) => option.value === last.code);
    if (known) { $("#checkout-cvs-store").value = last.code; applyStoreChoice(); return; }
    if (last.name) {
      if ($("#checkout-cvs-district").value) $("#checkout-cvs-store").value = MANUAL;
      setManualMode(true);
      $("#checkout-cvs-store-name").value = last.name;
      $("#checkout-cvs-store-code").value = last.code || "";
    }
  } catch {
    showLoadError();
  }
}

/** 第一次進入第二步時插入欄位（放在宅配地址之前），載入縣市並帶入上次的門市。 */
export function ensureCvsStoreFields() {
  const anchor = $("#checkout-address-label");
  if (!anchor || $("#checkout-cvs-store-fieldset")) return;
  anchor.insertAdjacentHTML("beforebegin", `<fieldset id="checkout-cvs-store-fieldset" class="checkout-cvs-store hidden" data-checkout-detail aria-hidden="true"><legend>7-11 取件門市</legend><div class="checkout-cvs-grid">${field("checkout-cvs-city", "縣市", '<select id="checkout-cvs-city" aria-describedby="checkout-cvs-city-error" disabled><option value="">載入中…</option></select>')}${field("checkout-cvs-district", "鄉鎮區", '<select id="checkout-cvs-district" aria-describedby="checkout-cvs-district-error" disabled><option value="">請先選擇縣市</option></select>')}</div>${field("checkout-cvs-store", "取件門市", '<select id="checkout-cvs-store" aria-describedby="checkout-cvs-store-error" disabled><option value="">請先選擇鄉鎮區</option></select>')}<p id="checkout-cvs-store-address" class="checkout-cvs-help hidden"></p><p id="checkout-cvs-load-error" class="checkout-cvs-help hidden" role="status">門市清單暫時無法載入，請重新整理頁面後再試。</p><div id="checkout-cvs-manual" class="checkout-cvs-grid hidden">${field("checkout-cvs-store-name", "門市名稱", '<input id="checkout-cvs-store-name" maxlength="40" autocomplete="off" placeholder="例：民生門市" aria-describedby="checkout-cvs-store-name-error" />')}${field("checkout-cvs-store-code", "門市店號", '<input id="checkout-cvs-store-code" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="6 位數字" aria-describedby="checkout-cvs-store-code-error" />')}</div><p class="checkout-cvs-help">不確定門市？<a href="${CVS_STORE_LOOKUP_URL}" target="_blank" rel="noopener noreferrer">查詢 7-ELEVEN 門市</a></p></fieldset>`);
  $("#checkout-cvs-city").addEventListener("change", () => fillDistricts().catch(showLoadError));
  $("#checkout-cvs-district").addEventListener("change", () => fillStores().catch(showLoadError));
  $("#checkout-cvs-store").addEventListener("change", applyStoreChoice);
  restoreStores();
}

export function toggleCvsStoreFields(visible) {
  const fieldset = $("#checkout-cvs-store-fieldset");
  if (!fieldset) return;
  fieldset.classList.toggle("hidden", !visible);
  fieldset.setAttribute("aria-hidden", String(!visible));
}

export function cvsStoreDetails() {
  const value = (selector) => $(selector)?.value.trim() || "";
  return {
    city: value("#checkout-cvs-city"),
    district: value("#checkout-cvs-district"),
    name: value("#checkout-cvs-store-name"),
    code: value("#checkout-cvs-store-code").replace(/\s/g, "")
  };
}

/** 回傳第一個不合格的欄位與訊息；全部正確時回傳 null。 */
export function cvsStoreProblem(store) {
  const manual = !$("#checkout-cvs-manual") || !$("#checkout-cvs-manual").classList.contains("hidden");
  if (!store.city) return ["#checkout-cvs-city", "請選擇取件門市所在縣市"];
  if (!store.district) return ["#checkout-cvs-district", "請選擇取件門市所在鄉鎮區"];
  if (!manual && !store.code) return ["#checkout-cvs-store", "請選擇取件門市"];
  if (!store.name) return ["#checkout-cvs-store-name", "請填寫 7-11 門市名稱"];
  if (!/^\d{6}$/.test(store.code)) return ["#checkout-cvs-store-code", "7-11 門市店號必須是 6 位數字"];
  return null;
}
