// 結帳流程：選定結帳範圍（現貨／預購）、開啟結帳視窗與送出訂單；結帳範圍與商品只由本模組改寫。
import { auth, closeDialog, showDialog, showToast } from "./app-core.js";
import { cart, cartGroups, cartItemsForScope, checkoutCartItems, renderCart, saveCart, selectedCartDeliveryMethod, syncMemberCartNow, toggleCart } from "./cart.js";
import { clearCheckoutFieldErrors, ensurePaymentMethodUI, loadBankAccounts, renderCheckoutBenefits, renderCheckoutSummary, setCheckoutStage, syncCheckoutSellerOption, syncDeliveryFields, validateCheckoutDetails } from "./checkout-form.js";
import { loadPoints, requireLineFriendshipForCheckout } from "./member-benefits.js";
import { showPaymentDialog } from "./member-orders.js";
import { beginLineLogin, profileIsComplete, saveProfile, showProfileDialog } from "./member-profile.js";

export let activeCheckoutScope = null;
export let activeCheckoutItems = null;

/** 選定要結帳的範圍（現貨／預購）並取出對應的購物車商品；未指定時沿用目前範圍。 */
export function selectCheckoutScope(scope) {
  activeCheckoutScope = scope || activeCheckoutScope;
  activeCheckoutItems = cartItemsForScope(activeCheckoutScope);
}

export async function openCheckout(scope = null) {
  const groups = cartGroups();
  const resolvedScope = scope || activeCheckoutScope || (groups.preorder.length ? "preorder" : "in_stock");
  const scopedItems = cartItemsForScope(resolvedScope);
  if (!scopedItems.length) return showToast("請先加入商品");
  activeCheckoutScope = resolvedScope;
  activeCheckoutItems = scopedItems.slice();
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const cartMethod = selectedCartDeliveryMethod(resolvedScope);
  syncCheckoutSellerOption();
  const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${cartMethod}']`);
  if (deliveryInput) deliveryInput.checked = true;
  try { await loadPoints(); } catch { /* 結帳仍可不使用優惠 */ }
  if (document.querySelector("#cart-drawer").classList.contains("open")) toggleCart();
  ensurePaymentMethodUI();
  renderCheckoutBenefits();
  const couponInput = document.querySelector("#checkout-coupon-code");
  const pointsInput = document.querySelector("#checkout-points");
  if (couponInput) couponInput.value = "";
  if (pointsInput) pointsInput.value = "0";
  syncDeliveryFields();
  renderCheckoutSummary();
  setCheckoutStage("details", { focus: false });
  clearCheckoutFieldErrors();
  document.querySelector("#checkout-error").classList.add("hidden");
  showDialog(document.querySelector("#checkout-dialog"));
  await loadBankAccounts();
}

export function showCheckoutError(message) {
  const errorNode = document.querySelector("#checkout-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

export async function submitOrder() {
  if (!auth.config?.authEnabled) return showToast("目前為靜態預覽，尚未連接訂單資料庫");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const details = validateCheckoutDetails();
  const itemsForOrder = checkoutCartItems().slice();
  const pickupPlan = "together";
  await saveProfile({ full_name: details.fullName, phone: details.normalizedPhone, birthday: auth.profile?.birthday || null, address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : (auth.profile?.address || null) });
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: itemsForOrder.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, delivery_method: details.deliveryMethod, payment_method: details.paymentMethod, shipping_address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : null, shipping_recipient_name: details.deliveryMethod === "home_delivery" ? details.shippingRecipientName : null, shipping_phone: details.deliveryMethod === "home_delivery" ? details.normalizedShippingPhone : null, bank_account_id: details.bankAccountId, coupon_code: document.querySelector("#checkout-coupon-code")?.value.trim() || null, points_to_redeem: Number(document.querySelector("#checkout-points")?.value || 0) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  await loadPoints({ force: true }).catch(() => {});
  cart.splice(0, cart.length, ...cart.filter((item) => !itemsForOrder.includes(item)));
  saveCart(); await syncMemberCartNow(); renderCart(); activeCheckoutItems = null; activeCheckoutScope = null; closeDialog(document.querySelector("#checkout-dialog"));
  showPaymentDialog(result.order);
}
