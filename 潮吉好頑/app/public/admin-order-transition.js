// 訂單「下一步」表單的純邏輯：高風險判斷、按鈕文字、次要入口文字與確認視窗內容。
// 不碰 DOM，方便測試（訂單卡與批次操作共用）；確認款項（confirmed）仍由 admin-order-payment.js 的 paymentConfirmation 處理。
import { money } from "./product-format.js";
import { orderIncludesPreorder } from "./app-core.js";

// 各狀態可前往的下一步（與 SQL admin_transition_order 的允許轉換對應；最終仍以 SQL 檢查為準）
const ORDER_TRANSITIONS = {
  pending_payment: [{ value: "confirmed", label: "確認到店付款", storePaymentOnly: true }, { value: "cancelled", label: "取消未付款訂單" }],
  pending_review: [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }],
  confirmed: [{ value: "partially_ready", label: "標記預購商品部分到貨", splitOnly: true }, { value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  partially_ready: [{ value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  ready_for_pickup: [{ value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  completed: [{ value: "refund_pending", label: "進入退款處理" }],
  refund_pending: [{ value: "refunded", label: "確認已退款" }, { value: "completed", label: "取消退款，恢復已完成" }]
};

// 依訂單配送方式、預購與付款狀態過濾：訂單卡「下一步」與批次操作共用同一套規則
export function availableTransitions(order) {
  const hasPreorder = orderIncludesPreorder(order);
  const preorderStorePickup = order.delivery_method === "store_pickup" && hasPreorder;
  return (ORDER_TRANSITIONS[order.status] || []).filter((item) =>
    (!item.splitOnly || order.pickup_plan === "split")
    && (!item.storePaymentOnly || !order.bank_account_id)
    && (item.value !== "partially_ready" || preorderStorePickup)
    && (item.value !== "ready_for_pickup" || preorderStorePickup || order.delivery_method === "seller_delivery" || (order.delivery_method === "home_delivery" && hasPreorder))
    && !(item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder)
    && !(item.value === "cancelled" && order.delivery_method === "seller_delivery" && order.status === "ready_for_pickup")
    && (item.value !== "completed" || order.delivery_method !== "home_delivery" || Boolean(order.final_payment_confirmed_at))
  );
}

const DANGEROUS_TARGETS = new Set(["cancelled", "refund_pending", "refunded"]);
// 需要填寫實際退款金額的動作（與 SQL admin_transition_order 一致）
const REFUND_TARGETS = new Set(["cancelled", "refunded"]);

// 退款金額欄位：取消已付款／已回報的訂單、確認已退款時顯示；未付款取消固定 0 不顯示。
// 預設帶已收金額，上限為應付總額加實際運費（最終仍由 SQL 檢查）
export function refundFieldFor(order, targetStatus) {
  if (!REFUND_TARGETS.has(targetStatus) || order?.status === "pending_payment") return null;
  const max = Number(order?.amount_due || 0) + Number(order?.shipping_fee || 0);
  return { defaultAmount: Math.min(Number(order?.paid_amount || 0), max), max };
}

// 送出前檢查退款金額；回傳整數或丟出帶 field 的錯誤（交給 admin-form-errors.js 標示欄位）
export function parseRefundAmount(raw, max) {
  const text = String(raw ?? "").trim();
  const value = Number(text);
  if (text === "" || !Number.isInteger(value) || value < 0) throw Object.assign(new Error("請填寫退款金額（0 或正整數，沒有退款請填 0）"), { field: "refund_amount" });
  if (value > max) throw Object.assign(new Error(`退款金額不可超過 ${money(max)}（應付總額加運費）`), { field: "refund_amount" });
  return value;
}

export function isDangerousTarget(targetStatus) {
  return DANGEROUS_TARGETS.has(targetStatus);
}

// 未選擇前不給可送出的動作；選擇後按鈕直接寫出要做的事，不用含糊的「確認高風險操作」
export function transitionSubmitLabel(targetStatus, optionLabel) {
  if (!targetStatus) return "請先選擇下一步";
  return optionLabel || "更新訂單";
}

// 所有可執行動作都是取消／退款時（例如已完成訂單只剩退款），整個表單收進次要入口，避免成為卡片上最顯眼的操作
export function riskOnlyEntryLabel(transitions) {
  if (!transitions.length || !transitions.every((item) => isDangerousTarget(item.value))) return null;
  const values = new Set(transitions.map((item) => item.value));
  const hasRefund = values.has("refund_pending") || values.has("refunded");
  if (hasRefund && values.has("cancelled")) return "退款或取消訂單…";
  return hasRefund ? "申請退款…" : "取消訂單…";
}

function warningFor(order, targetStatus) {
  if (targetStatus === "completed") return "完成訂單代表商品已取走且尾款已收訖。";
  if (targetStatus === "cancelled" && ["pending_payment", "pending_review"].includes(order?.status)) return "此訂單尚未扣除實體庫存；取消後會釋放保留量。";
  if (targetStatus === "cancelled") return "此訂單已扣除庫存且尚未完成交付；取消後會由系統反轉原銷售異動，不能再手動重複回補。";
  if (targetStatus === "refund_pending" || targetStatus === "refunded") return "退款流程不會自動回補庫存；收到實物後，請在已退款訂單逐項驗收並分為可再售或報廢。";
  return "";
}

// 非確認款項的狀態更新：標題寫出動作，明細列出訂單、會員與相關金額，高風險時附上原因
export function transitionConfirmation(order, { targetStatus, optionLabel, memberName = "", note = "", refundAmount = null }) {
  const danger = isDangerousTarget(targetStatus);
  const details = [["訂單", order?.order_number || "—"], ["會員", memberName || "未填姓名"]];
  const paid = Number(order?.paid_amount || 0);
  if (targetStatus === "refund_pending" || targetStatus === "refunded") details.push(["已收金額", money(paid)]);
  else details.push(["訂單總額", money(Number(order?.amount_due || 0))]);
  if (refundAmount !== null) details.push(["退款金額", money(refundAmount)]);
  if (danger && note) details.push(["原因", note]);
  const action = optionLabel || "更新訂單狀態";
  return {
    title: `${action}？`,
    details,
    message: warningFor(order, targetStatus),
    confirmLabel: action,
    danger
  };
}
