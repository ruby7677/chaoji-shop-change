// 後台訂單分類（ORDER_STAGE_FILTER_PLAN.md，純資料＋函式）：單排分頁的順序、名稱與徽章。
// adminOrderStage 鏡像 SQL private.admin_order_stage（伺服器依它篩選與計數），兩邊要一起改；
// 前台只用它在已載入的清單上做相同的篩選，避免伺服器找到的訂單在畫面上被濾掉。
// 徽章只給需要店長處理的分類，數字取自 admin_dashboard_stats。
export const ORDER_STAGES = [
  ["pending_payment", "待付訂"],
  ["pending_review", "待訂金對帳", (stats) => stats.stageCounts?.pending_review],
  ["awaiting_arrival", "待到貨"],
  // 已發到貨通知、尾款未確認（含會員已回報末五碼）；徽章只算已回報、等店長對帳的筆數
  ["awaiting_balance", "已通知待尾款確認", (stats) => stats.balanceReported],
  ["ready_to_ship", "待出貨／取貨", (stats) => stats.stageCounts?.ready_to_ship],
  ["completed", "已完成"],
  ["cancelled", "失效訂單"]
];

const STAGE_VALUES = new Set(ORDER_STAGES.map(([value]) => value));

export const isOrderStage = (value) => STAGE_VALUES.has(value);

const hasPreorder = (order) => (order?.order_items || []).some((item) => item.kind === "preorder");

export function adminOrderStage(order) {
  const status = order?.status;
  if (["pending_payment", "pending_review", "completed"].includes(status)) return status;
  if (["cancelled", "refund_pending", "refunded"].includes(status)) return "cancelled";
  if (!hasPreorder(order)) return "ready_to_ship";
  if (status === "confirmed") return "awaiting_arrival";
  // 預購到貨：交貨便／宅配要收尾款；尾款已確認，或已收齊（交貨便運費固定、宅配運費已確認）就待出貨
  const collectsBalance = ["cvs_delivery", "home_delivery"].includes(order.delivery_method);
  const paidInFull = Number(order.paid_amount || 0) >= Number(order.amount_due || 0)
    && (order.delivery_method === "cvs_delivery" || Boolean(order.shipping_fee_notified_at));
  return collectsBalance && !order.final_payment_confirmed_at && !paidInFull ? "awaiting_balance" : "ready_to_ship";
}

/** 分頁徽章數字；不顯示徽章的分類回傳 0 */
export function stageCount(stage, stats) {
  const count = ORDER_STAGES.find(([value]) => value === stage)?.[2];
  return count ? Math.max(0, Number(count(stats || {}) || 0)) : 0;
}

/** 未結案分類的訂單筆數（admin_dashboard_stats.stageCounts，不含已完成與失效）；分頁上以一般數字顯示，與待處理徽章區分 */
export function stageOpenCount(stage, stats) {
  return Math.max(0, Number(stats?.stageCounts?.[stage] || 0));
}

/** 篩選值是否符合訂單：分類值比對 adminOrderStage，其他（舊的狀態值）直接比對狀態 */
export function orderMatchesFilter(order, filter) {
  if (filter === "all") return true;
  return isOrderStage(filter) ? adminOrderStage(order) === filter : order.status === filter;
}
