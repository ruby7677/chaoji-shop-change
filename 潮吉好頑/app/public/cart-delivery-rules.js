// 商品可用取貨方式（products.allowed_delivery_methods）的前台規則：購物車一組商品只能選每項商品都允許的方式。
// 純函式、不碰 DOM；缺少或格式不明的欄位一律視為三種全開（舊快取型錄仍可用，真正的限制在資料庫建單時檢查）。
export const ALL_DELIVERY_METHODS = ["store_pickup", "cvs_delivery", "home_delivery"];
const SHORT_LABELS = { store_pickup: "到店取貨", cvs_delivery: "7-11店到店", home_delivery: "宅配" };

/** 單一商品允許的取貨方式（依固定順序）；欄位缺少、不是陣列或沒有任何有效值時視為全部允許。 */
export function itemDeliveryMethods(item) {
  const raw = item?.allowed_delivery_methods;
  if (!Array.isArray(raw)) return ALL_DELIVERY_METHODS;
  const valid = ALL_DELIVERY_METHODS.filter((method) => raw.includes(method));
  return valid.length ? valid : ALL_DELIVERY_METHODS;
}

/** 一組商品共同允許的取貨方式；沒有共同方式時回傳空陣列，空購物車回傳全部。 */
export function allowedDeliveryMethods(items) {
  return (items || []).reduce((common, item) => common.filter((method) => itemDeliveryMethods(item).includes(method)), ALL_DELIVERY_METHODS);
}

/** 目前選擇仍可用就保留，否則改選第一個可用的；沒有任何可用方式時維持原選擇（由結帳鈕另外擋下）。 */
export function resolveDeliveryMethod(current, allowed) {
  if (!allowed.length || allowed.includes(current)) return current;
  return allowed[0];
}

export function deliveryMethodsLabel(methods) {
  return methods.map((method) => SHORT_LABELS[method] || method).join("、");
}

/** 商品有限制時的標籤文字（例如「僅限 到店取貨、宅配」），全開時回傳空字串。 */
export function deliveryRestrictionLabel(item) {
  const methods = itemDeliveryMethods(item);
  return methods.length === ALL_DELIVERY_METHODS.length ? "" : `僅限 ${deliveryMethodsLabel(methods)}`;
}

/** 一組商品沒有共同取貨方式時的提示；有共同方式時回傳空字串。 */
export function deliveryConflictMessage(items) {
  if (allowedDeliveryMethods(items).length) return "";
  const seen = new Set();
  const lines = [];
  for (const item of items) {
    const label = deliveryRestrictionLabel(item);
    const name = item.product_name || item.name || "商品";
    if (!label || seen.has(name)) continue;
    seen.add(name);
    lines.push(`「${name}」${label}`);
  }
  return `${lines.slice(0, 3).join("；")}，沒有共同的取貨方式，請移除其中一項後分開購買。`;
}

/** 所選取貨方式不被某項商品允許時回傳提示（結帳送出前的友善檢查，資料庫仍會最終驗證）；可用則回傳空字串。 */
export function deliveryMethodError(items, method) {
  const blocked = (items || []).find((item) => !itemDeliveryMethods(item).includes(method));
  if (!blocked) return "";
  return `「${blocked.product_name || blocked.name || "商品"}」${deliveryRestrictionLabel(blocked)}，請重新選擇取貨方式。`;
}
