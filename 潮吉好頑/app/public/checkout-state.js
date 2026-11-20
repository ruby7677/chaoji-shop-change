// 結帳範圍（現貨／預購）與本次結帳商品快照。只由本模組改寫；流程層讀取 live binding。
// 從 checkout-flow.js 拆出，讓表單、優惠碼、登入回跳不必 import 結帳流程（避免循環 import）。
import { cartItemsForScope } from "./cart.js";

export let activeCheckoutScope = null;
export let activeCheckoutItems = null;

/** 選定要結帳的範圍（現貨／預購）並取出對應的購物車商品；未指定時沿用目前範圍。 */
export function selectCheckoutScope(scope) {
  activeCheckoutScope = scope || activeCheckoutScope;
  activeCheckoutItems = cartItemsForScope(activeCheckoutScope);
}

/** 開啟結帳時固定範圍與商品快照。 */
export function setCheckoutSnapshot(scope, items) {
  activeCheckoutScope = scope;
  activeCheckoutItems = items;
}

/** 建單完成後清除範圍與快照。 */
export function clearCheckoutSnapshot() {
  activeCheckoutScope = null;
  activeCheckoutItems = null;
}

/** 這次結帳的商品：已開啟結帳時用當時的快照，否則依目前範圍從購物車取。 */
export function checkoutCartItems() { return activeCheckoutItems || cartItemsForScope(activeCheckoutScope); }

export function showCheckoutError(message) {
  const errorNode = document.querySelector("#checkout-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}
