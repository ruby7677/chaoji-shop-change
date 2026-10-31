// 後台商品「可用取貨方式」欄位：新增商品表單（動態插入）與編輯商品表單共用；至少要勾選一種。
// 資料庫與 Worker 會再次驗證（INVALID_DELIVERY_METHODS），這裡只負責即時提示。
import { ALL_DELIVERY_METHODS, itemDeliveryMethods } from "./cart-delivery-rules.js";
import { deliveryMethodLabels } from "./app-core.js";

const FIELD_NAME = "delivery_methods";
export const DELIVERY_METHODS_REQUIRED = "請至少選擇一種可用的取貨方式";

/** selected：商品目前允許的方式（未提供時三種全勾）。 */
export function deliveryMethodsFieldHtml(selected) {
  const current = itemDeliveryMethods({ allowed_delivery_methods: selected });
  const boxes = ALL_DELIVERY_METHODS.map((method) => `<label class="check-field"><input type="checkbox" name="${FIELD_NAME}" value="${method}" ${current.includes(method) ? "checked" : ""} /> ${deliveryMethodLabels[method]}</label>`).join("");
  return `<fieldset class="admin-delivery-methods wide" data-delivery-methods><legend>可用的取貨方式</legend><div class="admin-delivery-methods-options">${boxes}</div><small>取消勾選後，客人結帳時就不能選該取貨方式（例如商品太大不能用 7-11 店到店）。至少保留一種；已成立的訂單不受影響。</small></fieldset>`;
}

/** 讀取容器內已勾選的方式；沒有勾選任何一種時丟出錯誤。 */
export function readDeliveryMethods(container) {
  const methods = [...container.querySelectorAll(`input[name='${FIELD_NAME}']:checked`)].map((input) => input.value);
  if (!methods.length) throw new Error(DELIVERY_METHODS_REQUIRED);
  return methods;
}

/** 新增商品表單：把欄位插在「不可累積會員點數」之後，只插入一次。 */
export function ensureAdminDeliveryMethodsUI() {
  if (document.querySelector("#admin-delivery-methods-create")) return;
  const anchor = document.querySelector("#admin-points-excluded")?.closest("label");
  if (!anchor) return;
  anchor.insertAdjacentHTML("afterend", `<div id="admin-delivery-methods-create">${deliveryMethodsFieldHtml(null)}</div>`);
}

/** 新增商品表單目前勾選的方式（欄位尚未插入時回傳 undefined，由資料庫預設三種全開）。 */
export function adminCreateDeliveryMethods() {
  const container = document.querySelector("#admin-delivery-methods-create");
  return container ? readDeliveryMethods(container) : undefined;
}
