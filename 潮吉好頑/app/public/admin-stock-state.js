// 低庫存清單的庫存文字（概況與庫存異動共用）：清單含庫存 ≤ 安全庫存的規格；
// 庫存歸零時直接標「已售完」，不顯示「庫存 0／安全庫存 0」這種看起來不算偏低的數字。
export const isSoldOut = (variant) => Number(variant.stock_on_hand) <= 0;

export function stockStateText(variant) {
  if (isSoldOut(variant)) return `已售完（安全庫存 ${variant.safety_stock}）`;
  return `庫存 ${variant.stock_on_hand}／安全庫存 ${variant.safety_stock}`;
}
