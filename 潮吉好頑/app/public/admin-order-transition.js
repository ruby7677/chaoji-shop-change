// 訂單「下一步」表單的純邏輯：高風險判斷、按鈕文字、次要入口文字與確認視窗內容。
// 不碰 DOM，方便測試；確認款項（confirmed）仍由 admin-order-payment.js 的 paymentConfirmation 處理。
import { money } from "./product-format.js";

const DANGEROUS_TARGETS = new Set(["cancelled", "refund_pending", "refunded"]);

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
export function transitionConfirmation(order, { targetStatus, optionLabel, memberName = "", note = "" }) {
  const danger = isDangerousTarget(targetStatus);
  const details = [["訂單", order?.order_number || "—"], ["會員", memberName || "未填姓名"]];
  const paid = Number(order?.paid_amount || 0);
  if (targetStatus === "refund_pending" || targetStatus === "refunded") details.push(["已收金額", money(paid)]);
  else details.push(["訂單總額", money(Number(order?.amount_due || 0))]);
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
