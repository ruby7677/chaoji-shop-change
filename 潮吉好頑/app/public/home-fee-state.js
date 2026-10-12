// 現貨宅配的運費確認狀態（前台訂單畫面與後台共用，不碰 DOM）：
// 建單後由小幫手在後台確認運費並以 LINE 通知客人，確認後才顯示匯款帳號與回報末五碼。

export function isStockHomeOrder(order, hasPreorder) {
  return order?.delivery_method === "home_delivery" && !hasPreorder;
}

/** 運費已確認：後台儲存過運費（含 0 元免運時記錄的確認時間），或已有運費金額 */
export function homeFeeConfirmed(order) {
  return Boolean(order?.shipping_fee_notified_at) || Number(order?.shipping_fee || 0) > 0;
}

/** 預購宅配到貨、小幫手已確認尾款與運費但還沒入帳：可查看尾款匯款帳號（末五碼回覆給小幫手） */
export function preorderHomeBalanceDue(order, hasPreorder) {
  return order?.delivery_method === "home_delivery" && hasPreorder && Boolean(order.bank_account_id)
    && ["partially_ready", "ready_for_pickup"].includes(order.status) && homeFeeConfirmed(order) && !order.final_payment_confirmed_at;
}

/** 現貨宅配待付款、運費還沒確認：不給匯款帳號，也不能回報末五碼 */
export function awaitingStockHomeFee(order, hasPreorder) {
  return isStockHomeOrder(order, hasPreorder) && order.status === "pending_payment" && !homeFeeConfirmed(order);
}
