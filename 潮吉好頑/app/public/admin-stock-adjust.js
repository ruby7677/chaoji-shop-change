// 庫存調整共用滑出面板：商品表格「調整庫存」、概況「補貨」、庫存頁低庫存列與庫存異動頁選好規格後都開同一個面板。
// 取代原本 #admin-inventory-form 的簽名數量輸入，改用入庫／扣除切換＋正整數數量，並在送出前用 adminConfirm 二次確認，
// 避免像「重複輸入 −10」這類手誤（見庫存異動歷史紀錄）。
import { adminData, adminFetch, invalidateAdminManagementOptions, refreshAdminSections } from "./admin-app.js";
import { showToast } from "./app-core.js";
import { adminConfirm } from "./admin-confirm.js";
import { createAdminSheet } from "./admin-sheets.js";
import { escapeHtml } from "./product-format.js";
import { stockAdjustment } from "./admin-stock-math.js";

const REASON_CHIPS = ["到貨入庫", "盤點修正", "損壞報廢"];

let sheet = null;
let current = null; // { variantId, productName, variantName, sku, stock, safety }

function findInProductList(list, variantId) {
  for (const product of list || []) {
    const variant = (product.product_variants || []).find((item) => item.id === variantId);
    if (variant) return { productName: product.name, variantName: variant.name, sku: variant.sku || "", stock: Number(variant.stock_on_hand), safety: Number(variant.safety_stock) };
  }
  return null;
}

function findInLowStock(variantId) {
  const item = (adminData?.overview?.lowStock || []).find((entry) => entry.id === variantId);
  if (!item) return null;
  return { productName: item.product_name, variantName: item.name, sku: "", stock: Number(item.stock_on_hand), safety: Number(item.safety_stock) };
}

// 依序查：目前分頁完整載入的商品清單 → 管理表單選項（新增規格／庫存頁選單共用的精簡清單）→ 概況頁的低庫存清單
function resolveVariant(variantId) {
  return findInProductList(adminData?.products, variantId)
    || findInProductList(adminData?.managementOptions?.products, variantId)
    || findInProductList(adminData?.productOptions, variantId)
    || findInLowStock(variantId);
}

const directionLabel = (direction) => (direction === "out" ? "扣除" : "入庫");

function readForm(form) {
  return {
    direction: form.elements["stock-direction"]?.value || "in",
    quantity: form.elements.quantity?.value,
    reason: form.elements.reason?.value.trim() || ""
  };
}

function syncSegmentedUI(body) {
  body.querySelectorAll(".admin-stock-segment").forEach((label) => {
    label.classList.toggle("is-selected", label.querySelector("input")?.checked === true);
  });
}

function syncPreview() {
  if (!sheet || !current) return null;
  const form = sheet.body.querySelector("#admin-stock-form");
  const preview = sheet.body.querySelector("#admin-stock-preview");
  const submit = sheet.body.querySelector("#admin-stock-submit");
  if (!form || !preview || !submit) return null;
  syncSegmentedUI(sheet.body);
  const { direction, quantity, reason } = readForm(form);
  // 尚未輸入數量時只顯示中性提示，不要一開啟面板就出現錯誤
  if (!String(quantity ?? "").trim()) {
    preview.textContent = `目前 ${current.stock} 件，輸入數量後顯示調整後庫存`;
    preview.classList.remove("is-error");
    submit.disabled = true;
    return null;
  }
  const result = stockAdjustment({ current: current.stock, direction, quantity });
  if (result.error) {
    preview.textContent = result.error;
    preview.classList.add("is-error");
    submit.disabled = true;
    return null;
  }
  preview.textContent = `目前 ${current.stock} → 調整後 ${result.next}`;
  preview.classList.remove("is-error");
  submit.disabled = !reason;
  return result;
}

function sheetMarkup() {
  return `<form id="admin-stock-form" class="admin-form">`
    + `<p class="admin-stock-current">目前庫存 <strong>${current.stock}</strong> 件・安全庫存 <strong>${current.safety}</strong> 件</p>`
    + '<div class="admin-stock-segmented" role="radiogroup" aria-label="調整方向">'
    + '<label class="admin-stock-segment is-selected"><input type="radio" name="stock-direction" value="in" checked /> 入庫</label>'
    + '<label class="admin-stock-segment"><input type="radio" name="stock-direction" value="out" /> 扣除</label>'
    + '</div><div class="form-grid">'
    + '<label class="wide">數量<input id="admin-stock-quantity" name="quantity" type="number" min="1" step="1" inputmode="numeric" required /></label>'
    + '<label class="wide">原因<input id="admin-stock-reason" name="reason" type="text" maxlength="200" required placeholder="例如：到貨入庫、盤點修正" /></label>'
    + '</div><div class="admin-stock-chips">'
    + REASON_CHIPS.map((label) => `<button type="button" class="admin-stock-chip" data-stock-reason-chip="${escapeHtml(label)}">${escapeHtml(label)}</button>`).join("")
    + '</div><p id="admin-stock-preview" class="admin-stock-preview" role="status" aria-live="polite"></p>'
    + '<button id="admin-stock-submit" class="primary-button" type="submit" disabled>確認調整</button></form>';
}

// 面板內容每次開啟都重繪，事件委派只在面板第一次建立時綁定一次（body 節點本身不會被換掉）
function bindSheetEvents(body) {
  body.addEventListener("input", (event) => {
    if (event.target.matches("#admin-stock-quantity, #admin-stock-reason")) syncPreview();
  });
  body.addEventListener("change", (event) => {
    if (event.target.matches("input[name='stock-direction']")) syncPreview();
  });
  body.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-stock-reason-chip]");
    if (!chip) return;
    const reasonInput = body.querySelector("#admin-stock-reason");
    if (!reasonInput) return;
    reasonInput.value = chip.dataset.stockReasonChip;
    reasonInput.focus();
    syncPreview();
  });
}

function ensureSheet() {
  if (sheet) return sheet;
  sheet = createAdminSheet(document.querySelector("#admin-dialog"), "調整庫存");
  bindSheetEvents(sheet.body);
  return sheet;
}

// trigger：關閉後焦點回到的按鈕（各入口自己的觸發元素）
export function openStockAdjust(variantId, trigger = null) {
  const resolved = resolveVariant(variantId);
  if (!resolved) {
    showToast("找不到這個規格，請重新整理後再試", "error");
    return;
  }
  current = { variantId, ...resolved };
  ensureSheet();
  sheet.setTitle(`調整庫存｜${resolved.productName} · ${resolved.variantName}`);
  sheet.body.innerHTML = sheetMarkup();
  syncPreview();
  sheet.open(trigger);
}

// 由 admin-loader.js 的 submit 委派呼叫；沿用既有模式：錯誤直接往上丟，由呼叫端 catch 後 showToast。
export async function submitStockAdjust(event) {
  event.preventDefault();
  if (!current) return;
  const form = event.target;
  const { direction, quantity, reason } = readForm(form);
  const result = stockAdjustment({ current: current.stock, direction, quantity });
  if (result.error || !reason) return; // 按鈕已依驗證停用，正常不會走到這裡
  const label = `${current.productName}・${current.variantName}`;
  const submitButton = form.querySelector("#admin-stock-submit");
  const confirmed = await adminConfirm({
    title: `確認${directionLabel(direction)} ${Math.abs(result.delta)} 件？`,
    details: [
      ["規格", label],
      ["目前庫存", `${current.stock} 件`],
      ["調整", `${result.delta > 0 ? "+" : ""}${result.delta} 件`],
      ["調整後", `${result.next} 件`],
      ["原因", reason]
    ],
    confirmLabel: "確認調整",
    trigger: submitButton
  });
  if (!confirmed) return;
  submitButton.disabled = true;
  submitButton.textContent = "更新中…";
  let apiResult;
  try {
    apiResult = await adminFetch(`/api/admin/variants/${current.variantId}/inventory`, { method: "POST", body: JSON.stringify({ quantity_delta: result.delta, reason }) });
  } catch (error) {
    // 只有調整請求本身失敗才開放重送
    submitButton.disabled = false;
    submitButton.textContent = "確認調整";
    throw error;
  }
  // 調整已寫入：先關閉面板並回報，之後畫面重新整理失敗也不能讓人重送，避免重複調整
  current = null;
  sheet.close();
  showToast(`庫存已更新：${label} ${Number(apiResult?.stock_on_hand ?? result.next)} 件`, "success");
  invalidateAdminManagementOptions();
  try {
    await refreshAdminSections(["inventory", "products", "overview"]);
  } catch {
    showToast("庫存已更新，但畫面重新整理失敗，請按右上角重新整理", "warning");
  }
}
