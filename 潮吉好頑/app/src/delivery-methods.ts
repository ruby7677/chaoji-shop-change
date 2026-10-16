// 商品可用取貨方式（products.allowed_delivery_methods）：Worker 先驗證請求格式，資料庫再做最終檢查。
export const DELIVERY_METHODS = ["store_pickup", "cvs_delivery", "home_delivery"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** undefined／null → 沒有指定（null）；格式正確 → 去重後的陣列；其他（空陣列、未知值、非陣列）→ "invalid"。 */
export function parseDeliveryMethods(value: unknown): DeliveryMethod[] | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return "invalid";
  const methods = new Set<DeliveryMethod>();
  for (const entry of value) {
    if (!DELIVERY_METHODS.includes(entry as DeliveryMethod)) return "invalid";
    methods.add(entry as DeliveryMethod);
  }
  return [...methods];
}
