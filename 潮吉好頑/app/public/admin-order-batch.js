// 訂單批次完成取貨（BATCH_OPERATIONS_PLAN.md Stage 2）：勾選框、底部批次列、逐筆送出與結果彙整。
// 每筆仍呼叫既有單筆 API（POST /api/admin/orders/:id/transition），驗證、歷程、點數與通知與單筆相同。
import { money } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { showToast } from "./app-core.js";
import { adminData, adminFetch, refreshAdminSections, relationOne } from "./admin-app.js";
import { batchSelectionError, canBatchComplete, completionBatchConfirmation, outstandingBalance, summarizeBatchResults } from "./admin-batch.js";

// 只在「處理中」的這些篩選下提供勾選（完成取貨發生在這些狀態）
const BATCH_FILTERS = new Set(["confirmed", "ready_for_pickup"]);

const selected = new Set();
let bar = null;
let running = false;
let lastFailures = "";

const statusFilter = () => document.querySelector("#admin-order-status-filter")?.value || "all";
const ordersById = () => new Map((adminData?.orders || []).map((order) => [order.id, order]));

export function isOrderBatchMode() {
  return BATCH_FILTERS.has(statusFilter());
}

// 訂單卡標題前的勾選框；只給可完成的訂單
export function orderSelectMarkup(order) {
  if (!isOrderBatchMode() || !canBatchComplete(order)) return "";
  const checked = selected.has(order.id) ? " checked" : "";
  return `<label class="admin-order-select"><input type="checkbox" data-admin-order-select="${order.id}"${checked} aria-label="選取訂單 ${order.order_number}" /></label>`;
}

function ensureBar() {
  if (bar?.isConnected) return bar;
  const panel = document.querySelector('[data-admin-panel="orders"]');
  if (!panel) throw new Error("訂單分頁不存在");
  bar = document.createElement("div");
  bar.className = "admin-batch-bar";
  bar.hidden = true;
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "批次操作");
  bar.innerHTML = '<p class="admin-batch-status" role="status" aria-live="polite"></p><div class="admin-batch-actions"><button class="secondary-button" type="button" data-admin-batch-clear>取消選取</button><button class="primary-button" type="button" data-admin-batch-complete>批次完成取貨</button></div>';
  panel.append(bar);
  return bar;
}

function renderBar(progress = "") {
  const node = ensureBar();
  const orders = [...selected].map((id) => ordersById().get(id)).filter(Boolean);
  const total = orders.reduce((sum, order) => sum + outstandingBalance(order), 0);
  node.hidden = !orders.length && !running && !lastFailures;
  const summary = orders.length ? `已選 ${orders.length} 筆・待收尾款合計 ${money(total)}` : "";
  const limit = batchSelectionError(orders.length);
  node.querySelector(".admin-batch-status").textContent = progress || [summary, orders.length > 1 && limit ? limit : "", lastFailures].filter(Boolean).join("　");
  node.querySelector("[data-admin-batch-complete]").disabled = running || Boolean(limit);
  node.querySelector("[data-admin-batch-clear]").disabled = running;
  document.querySelectorAll("[data-admin-order-select]").forEach((box) => { box.disabled = running; });
}

// 訂單清單重新渲染後呼叫：移除已不在清單或不可完成的選取，並更新批次列
export function syncOrderBatch() {
  const orders = ordersById();
  if (!isOrderBatchMode()) selected.clear();
  [...selected].forEach((id) => { if (!canBatchComplete(orders.get(id))) selected.delete(id); });
  renderBar();
}

async function runBatchComplete(trigger) {
  const orders = [...selected].map((id) => ordersById().get(id)).filter(Boolean);
  const memberNameOf = (order) => relationOne(order.profiles)?.full_name || "";
  const { title, details, message, confirmLabel } = completionBatchConfirmation(orders, memberNameOf);
  if (!await adminConfirm({ title, details, message, confirmLabel, trigger })) return;
  running = true;
  lastFailures = "";
  const results = [];
  try {
    // 依序送出：避免同一規格同時異動，也讓進度可見
    for (const [index, order] of orders.entries()) {
      renderBar(`處理中 ${index + 1}／${orders.length}：${order.order_number}`);
      try {
        await adminFetch(`/api/admin/orders/${order.id}/transition`, { method: "POST", body: JSON.stringify({ target_status: "completed", note: "批次完成取貨" }) });
        results.push({ id: order.id, label: order.order_number, ok: true });
        selected.delete(order.id);
      } catch (error) {
        results.push({ id: order.id, label: order.order_number, ok: false, error: error.message });
      }
    }
  } finally {
    running = false;
  }
  const summary = summarizeBatchResults(results);
  // 失敗項目保留勾選與原因，方便處理後重試
  lastFailures = summary.allOk ? "" : summary.message;
  showToast(summary.message, summary.allOk ? "success" : "error");
  try {
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
  } catch (error) {
    showToast(`訂單已送出，但畫面更新失敗：${error.message}`, "error");
  }
  syncOrderBatch();
}

let bound = false;
export function initOrderBatch() {
  if (bound) return;
  bound = true;
  document.addEventListener("change", (event) => {
    const box = event.target.closest?.("[data-admin-order-select]");
    if (box) {
      if (box.checked) selected.add(box.dataset.adminOrderSelect);
      else selected.delete(box.dataset.adminOrderSelect);
      lastFailures = "";
      renderBar();
      return;
    }
    // 切換狀態篩選時清除選取（避免帶著看不到的訂單送出）
    if (event.target.matches?.("#admin-order-status-filter") && !running) {
      selected.clear();
      lastFailures = "";
      renderBar();
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-admin-batch-clear]")) {
      selected.clear();
      lastFailures = "";
      document.querySelectorAll("[data-admin-order-select]").forEach((box) => { box.checked = false; });
      renderBar();
      return;
    }
    const complete = event.target.closest("[data-admin-batch-complete]");
    if (complete && !running) runBatchComplete(complete).catch((error) => showToast(error.message, "error"));
  });
}
