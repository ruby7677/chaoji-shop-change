// 規格批次上架／下架（BATCH_OPERATIONS_PLAN.md Stage 3）：列勾選框、底部批次列、逐筆送出與結果彙整。
// 每筆沿用單筆開關的 PATCH /api/admin/variants/:id 與 variantPayload；依賴由 admin-products-table.js 注入。
import { batchSelectionError, publishBatchConfirmation, summarizeBatchResults } from "./admin-batch.js";

const selected = new Set();
let deps = null;
let bar = null;
let running = false;
let lastFailures = "";

const labelOf = ({ product, variant }) => `${product.name}／${variant.name}`;

// 規格欄最前面的勾選框
export function variantSelectMarkup(product, variant, escapeHtml) {
  const checked = selected.has(variant.id) ? " checked" : "";
  return `<label class="admin-row-select"><input type="checkbox" data-admin-variant-select="${escapeHtml(variant.id)}"${checked} aria-label="選取「${escapeHtml(labelOf({ product, variant }))}」" /></label>`;
}

function selectedItems() {
  return [...selected].map((id) => deps.findVariant(id)).filter(Boolean);
}

function ensureBar() {
  if (bar?.isConnected) return bar;
  const panel = document.querySelector('[data-admin-panel="products"]');
  if (!panel) throw new Error("商品分頁不存在");
  bar = document.createElement("div");
  bar.className = "admin-batch-bar";
  bar.hidden = true;
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "規格批次操作");
  bar.innerHTML = '<p class="admin-batch-status" role="status" aria-live="polite"></p><div class="admin-batch-actions"><button class="secondary-button" type="button" data-admin-variant-batch="clear">取消選取</button><button class="secondary-button" type="button" data-admin-variant-batch="unpublish">下架</button><button class="primary-button" type="button" data-admin-variant-batch="publish">上架</button></div>';
  panel.append(bar);
  return bar;
}

function renderBar(progress = "") {
  const node = ensureBar();
  const items = selectedItems();
  node.hidden = !items.length && !running && !lastFailures;
  const limit = batchSelectionError(items.length);
  const summary = items.length ? `已選 ${items.length} 個規格` : "";
  node.querySelector(".admin-batch-status").textContent = progress || [summary, items.length > 1 && limit ? limit : "", lastFailures].filter(Boolean).join("　");
  node.querySelectorAll("[data-admin-variant-batch]").forEach((button) => {
    button.disabled = running || (button.dataset.adminVariantBatch !== "clear" && Boolean(limit));
  });
  document.querySelectorAll("[data-admin-variant-select]").forEach((box) => { box.disabled = running; });
}

// 表格重繪後呼叫：只保留目前畫面上看得到的規格（篩選後隱藏的不帶著送出）
export function syncVariantBatch() {
  if (!deps) return;
  const visible = new Set([...document.querySelectorAll("[data-admin-variant-select]")].map((box) => box.dataset.adminVariantSelect));
  [...selected].forEach((id) => { if (!visible.has(id) || !deps.findVariant(id)) selected.delete(id); });
  renderBar();
}

async function runBatchPublish(next, trigger) {
  const chosen = selectedItems();
  // 已經是目標狀態的規格不重送
  const items = chosen.filter(({ variant }) => variant.is_published !== next);
  if (!items.length) {
    deps.showToast(`所選規格都已是${next ? "上架" : "下架"}狀態`, "neutral");
    return;
  }
  const confirmation = publishBatchConfirmation(items.map(({ product, variant }) => ({ productName: product.name, variantName: variant.name, productPublished: product.is_published })), next);
  if (!await deps.adminConfirm({ ...confirmation, trigger })) return;
  running = true;
  lastFailures = "";
  const results = [];
  try {
    for (const [index, item] of items.entries()) {
      renderBar(`處理中 ${index + 1}／${items.length}：${labelOf(item)}`);
      try {
        const result = await deps.adminFetch(`/api/admin/variants/${item.variant.id}`, { method: "PATCH", body: JSON.stringify(deps.variantPayload(item.variant, next)) });
        const saved = result?.variant && !Array.isArray(result.variant) ? result.variant : null;
        item.variant.is_published = typeof saved?.is_published === "boolean" ? saved.is_published : next;
        if (saved?.updated_at) item.variant.updated_at = saved.updated_at;
        results.push({ label: labelOf(item), ok: true });
        selected.delete(item.variant.id);
      } catch (error) {
        results.push({ label: labelOf(item), ok: false, error: error.message });
      }
    }
  } finally {
    running = false;
  }
  // 已是目標狀態、不需送出的規格也一併取消勾選
  chosen.forEach(({ variant }) => { if (variant.is_published === next) selected.delete(variant.id); });
  const summary = summarizeBatchResults(results);
  lastFailures = summary.allOk ? "" : summary.message;
  deps.showToast(summary.allOk ? `已${next ? "上架" : "下架"} ${summary.succeeded} 個規格` : summary.message, summary.allOk ? "success" : "error");
  if (summary.succeeded) deps.onCatalogChanged();
  deps.redraw();
}

export function initVariantBatch(dependencies) {
  if (deps) return;
  const required = ["findVariant", "variantPayload", "adminFetch", "adminConfirm", "onCatalogChanged", "redraw", "showToast"];
  const missing = required.filter((key) => typeof dependencies?.[key] !== "function");
  if (missing.length) throw new Error(`initVariantBatch 缺少依賴：${missing.join(", ")}`);
  deps = dependencies;
  document.addEventListener("change", (event) => {
    const box = event.target.closest?.("[data-admin-variant-select]");
    if (!box) return;
    if (box.checked) selected.add(box.dataset.adminVariantSelect);
    else selected.delete(box.dataset.adminVariantSelect);
    lastFailures = "";
    renderBar();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-admin-variant-batch]");
    if (!button || running) return;
    const action = button.dataset.adminVariantBatch;
    if (action === "clear") {
      selected.clear();
      lastFailures = "";
      document.querySelectorAll("[data-admin-variant-select]").forEach((box) => { box.checked = false; });
      renderBar();
      return;
    }
    runBatchPublish(action === "publish", button).catch((error) => deps.showToast(error.message, "error"));
  });
}
