// 7-11 店到店（交貨便）運費規則與文案；金額必須與資料庫 private.cvs_shipping_fee 一致（tests/frontend/cvs-delivery.test.mjs 檢查）。
import { money } from "./product-format.js";

export const CVS_SHIPPING_FEE = 60;
export const CVS_FREE_SHIPPING_THRESHOLD = 6000;
export const CVS_STORE_LOOKUP_URL = "https://emap.pcsc.com.tw/";

/** 依折扣前的商品小計計算交貨便運費。 */
export function cvsShippingFee(subtotal) {
  return Number(subtotal) >= CVS_FREE_SHIPPING_THRESHOLD ? 0 : CVS_SHIPPING_FEE;
}

export const cvsFeeRule = `運費 ${money(CVS_SHIPPING_FEE)}，單筆商品滿 ${money(CVS_FREE_SHIPPING_THRESHOLD)} 免運`;

/** 購物車與結帳提示：現貨運費併入本次匯款；預購運費到貨後與尾款一起收。 */
export function cvsFeeHint(subtotal, preorder) {
  const fee = cvsShippingFee(subtotal);
  if (preorder) return `${fee ? `運費 ${money(fee)}` : "已達免運"}，到貨後與尾款一併收取。`;
  if (!fee) return "已達免運門檻，本次免運費。";
  return `運費 ${money(fee)} 併入本次匯款；再買 ${money(CVS_FREE_SHIPPING_THRESHOLD - Number(subtotal || 0))} 即可免運。`;
}

/** 訂單上的取件門市文字，例如「台南市中西區 民生門市（123456）」。 */
export function cvsPickupStoreText(order) {
  if (!order?.pickup_store_name) return "";
  return `${order.pickup_store_city || ""}${order.pickup_store_district || ""} ${order.pickup_store_name}（${order.pickup_store_code || "-"}）`.trim();
}
