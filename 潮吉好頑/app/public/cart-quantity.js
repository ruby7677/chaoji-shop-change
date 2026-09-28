// 購物車數量規則（純函式，不讀寫狀態）：加入購物車與「直接購買」共用同一套庫存／限購上限。
// 伺服器建單時仍會重新驗證，這裡只負責前端提示。

export function variantMaxQuantity(variant) {
  const stock = Math.max(Number(variant?.stock || 0), 0);
  const limit = Number(variant?.purchase_limit);
  return Number.isInteger(limit) && limit > 0 ? Math.min(stock, limit) : stock;
}

function quantityRangeError(max) {
  return { ok: false, message: `數量需介於 1 至 ${Math.max(max, 1)} 件` };
}

// 「直接購買」：買家在商品頁選好的數量就是要結帳的數量。
// 購物車沒有這個規格就加入；已有則改成所選數量（不累加，避免連點或回上一頁再按變成兩倍）。
export function planBuyNowQuantity({ existingQuantity = 0, requested, max }) {
  if (!Number.isInteger(requested) || requested < 1 || requested > max) return quantityRangeError(max);
  if (!existingQuantity) return { ok: true, quantity: requested, changed: true, message: "" };
  if (existingQuantity === requested) return { ok: true, quantity: requested, changed: false, message: "" };
  return { ok: true, quantity: requested, changed: true, message: `購物車數量已改為 ${requested} 件` };
}
