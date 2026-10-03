// 訂單狀態分頁的兩層分組（純資料＋函式）：第一列「全部／待處理／處理中／結案」，第二列只列該組狀態。
// 篩選仍是單一狀態（沿用 #admin-order-status-filter），分組只決定畫面怎麼排。
// count 取自 admin_dashboard_stats，只有需要人工處理的狀態有數字。
export const ORDER_STATUS_GROUPS = [
  { key: "todo", label: "待處理", statuses: [
    ["pending_review", "待確認款項", (s) => s.pendingReview],
    ["seller_pending", "賣貨便待核對", (s) => s.sellerPending],
    ["pending_payment", "待付款"]
  ] },
  { key: "active", label: "處理中", statuses: [
    ["confirmed", "已確認"],
    ["ready_for_pickup", "配送處理中", (s) => s.readyForPickup]
  ] },
  { key: "closed", label: "結案", statuses: [
    ["completed", "已完成"],
    ["cancelled", "已取消"]
  ] }
];

export function groupOfStatus(status) {
  return ORDER_STATUS_GROUPS.find((group) => group.statuses.some(([value]) => value === status)) || null;
}

export function statusCount(entry, stats) {
  const count = entry[2];
  return count ? Math.max(0, Number(count(stats || {}) || 0)) : 0;
}

export function groupCount(group, stats) {
  return group.statuses.reduce((sum, entry) => sum + statusCount(entry, stats), 0);
}

// 點分組時先開啟組內第一個有待辦的狀態；都沒有就開第一個
export function defaultStatusOfGroup(group, stats) {
  return (group.statuses.find((entry) => statusCount(entry, stats) > 0) || group.statuses[0])[0];
}
