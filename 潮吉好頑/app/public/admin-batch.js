// 後台批次操作的純邏輯（docs/history/BATCH_OPERATIONS_PLAN.md Stage 1）：可批次判斷、上限、確認內容與結果彙整。
// 實際送出由 UI 逐筆呼叫既有單筆 API；這裡不碰 DOM 也不發請求。
import { money } from "./product-format.js";
import { availableTransitions } from "./admin-order-transition.js";

export const BATCH_LIMIT = 10;
// 只有「取貨／交付」階段的完成可批次
const PICKUP_STATUSES = new Set(["confirmed", "partially_ready", "ready_for_pickup"]);

// 選取數量檢查：回傳錯誤訊息，通過時回傳空字串
export function batchSelectionError(count) {
  if (!Number.isInteger(count) || count <= 0) return "請先勾選要處理的項目";
  if (count > BATCH_LIMIT) return `一次最多處理 ${BATCH_LIMIT} 筆，目前選了 ${count} 筆`;
  return "";
}

export function canBatchComplete(order) {
  return Boolean(order) && PICKUP_STATUSES.has(order.status) && availableTransitions(order).some((item) => item.value === "completed");
}

export function outstandingBalance(order) {
  return Math.max(Number(order?.amount_due || 0) - Number(order?.paid_amount || 0), 0);
}

// 完成取貨在 SQL 會把已收金額設為訂單總額（視為尾款已收）並入帳點數：確認視窗必須逐筆列出尾款
export function completionBatchConfirmation(orders, memberNameOf = () => "") {
  const error = batchSelectionError(orders.length);
  if (error) throw new Error(error);
  const ineligible = orders.filter((order) => !canBatchComplete(order));
  if (ineligible.length) throw new Error(`${ineligible.map((order) => order.order_number).join("、")} 目前不能直接完成，請取消勾選後再試`);
  const rows = orders.map((order) => {
    const balance = outstandingBalance(order);
    return [`${order.order_number}・${memberNameOf(order) || "未填姓名"}`, balance ? `待收尾款 ${money(balance)}` : "已收齊"];
  });
  const totalBalance = orders.reduce((sum, order) => sum + outstandingBalance(order), 0);
  const withBalance = orders.filter((order) => outstandingBalance(order) > 0).length;
  const message = ["完成訂單代表商品已交付；到店取貨訂單完成時會把尾款視為已收，並入帳會員點數。"];
  if (withBalance) message.push(`其中 ${withBalance} 筆仍有待收尾款，合計 ${money(totalBalance)}；請確認已實際收到。`);
  return {
    title: `完成 ${orders.length} 筆訂單？`,
    details: [...rows, ["待收尾款合計", money(totalBalance)]],
    message,
    confirmLabel: `完成 ${orders.length} 筆訂單`,
    totalBalance
  };
}

// items：[{ productName, variantName, productPublished }]；next：true 上架、false 下架
export function publishBatchConfirmation(items, next) {
  const error = batchSelectionError(items.length);
  if (error) throw new Error(error);
  const action = next ? "上架" : "下架";
  const hiddenProducts = next ? items.filter((item) => !item.productPublished).length : 0;
  const message = [next ? "上架後前台會顯示這些規格，顧客可加入購物車。" : "下架後前台不再顯示這些規格，顧客無法再加入購物車。"];
  if (hiddenProducts) message.push(`其中 ${hiddenProducts} 個規格所屬商品尚未上架，前台仍不會顯示；需在「編輯」中勾選「上架商品」。`);
  return {
    title: `${action} ${items.length} 個規格？`,
    details: items.map((item) => [item.productName, item.variantName]),
    message,
    confirmLabel: `${action} ${items.length} 個規格`,
    danger: !next
  };
}

// results：[{ label, ok, error? }] → 摘要文字與失敗清單（失敗項目保留勾選以便重試）
export function summarizeBatchResults(results) {
  const failed = results.filter((result) => !result.ok).map((result) => ({ label: result.label, error: result.error || "未知錯誤" }));
  const succeeded = results.length - failed.length;
  const message = failed.length
    ? `完成 ${succeeded} 筆，${failed.length} 筆失敗：${failed.map((item) => `${item.label}（${item.error}）`).join("；")}`
    : `已完成 ${succeeded} 筆`;
  return { succeeded, failed, message, allOk: failed.length === 0 };
}
