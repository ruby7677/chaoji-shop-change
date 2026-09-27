// 庫存調整的純計算：供 admin-stock-adjust.js 面板與 tests/frontend 共用；不得有 DOM 存取或其他模組匯入，方便單元測試。
export function stockAdjustment({ current, direction, quantity }) {
  const currentStock = Number(current);
  const qty = Number(quantity);
  if (direction !== "in" && direction !== "out") return { delta: 0, next: currentStock, error: "請選擇入庫或扣除" };
  if (!Number.isInteger(qty) || qty <= 0) return { delta: 0, next: currentStock, error: "請輸入大於 0 的整數數量" };
  const delta = direction === "in" ? qty : -qty;
  const next = currentStock + delta;
  if (direction === "out" && next < 0) return { delta, next, error: `扣除後庫存不可小於 0（目前 ${currentStock} 件）` };
  return { delta, next, error: null };
}

// keyword 為空字串時視為全部符合；比對商品名稱、規格名稱（含 SKU）與異動原因，不分大小寫。
export function movementMatches(movement, keyword, productName, variantName) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return true;
  const haystack = [productName, variantName, movement?.reason].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(kw);
}
