// 結帳流程：選定結帳範圍（現貨／預購）、開啟結帳視窗與送出訂單；結帳範圍與商品只由本模組改寫。
import { auth, closeDialog, showDialog, showToast } from "./app-core.js";
import { cart, cartGroups, cartItemsForScope, checkoutCartItems, renderCart, saveCart, selectedCartDeliveryMethod, settleMemberCart, syncMemberCartNow, toggleCart } from "./cart.js";
import { clearCheckoutFieldErrors, ensurePaymentMethodUI, loadBankAccounts, renderCheckoutBenefits, renderCheckoutSummary, setCheckoutStage, syncDeliveryFields, validateCheckoutDetails } from "./checkout-form.js";
import { loadPoints, requireLineFriendshipForCheckout } from "./member-benefits.js";
import { openOrders, showPaymentDialog } from "./member-orders.js";
import { rememberCvsStore } from "./checkout-cvs-store.js";
import { checkoutRequestKey, clearCheckoutRequestKey, markCheckoutRequestCompleted, recentCompletedCheckout } from "./checkout-request-key.js";
import { ensureCheckoutCouponApplied, resetCheckoutCoupon } from "./checkout-coupon.js";
import { whenAuthReady } from "./auth-ready.js";
import { beginLineLogin, loadMember, profileIsComplete, saveProfile, showProfileDialog } from "./member-profile.js";

export let activeCheckoutScope = null;
export let activeCheckoutItems = null;

/** 選定要結帳的範圍（現貨／預購）並取出對應的購物車商品；未指定時沿用目前範圍。 */
export function selectCheckoutScope(scope) {
  activeCheckoutScope = scope || activeCheckoutScope;
  activeCheckoutItems = cartItemsForScope(activeCheckoutScope);
}

export async function openCheckout(scope = null) {
  // 先等背景登入與會員購物車合併完成，再依合併後的購物車建立結帳快照（loadMemberCart 會換掉 cart 內的物件）
  await whenAuthReady();
  const memberCartSettled = await settleMemberCart();
  const groups = cartGroups();
  const resolvedScope = scope || activeCheckoutScope || (groups.preorder.length ? "preorder" : "in_stock");
  const scopedItems = cartItemsForScope(resolvedScope);
  if (!scopedItems.length) return showToast("請先加入商品");
  activeCheckoutScope = resolvedScope;
  activeCheckoutItems = scopedItems.slice();
  // 開機時會員資料暫時載入失敗（登入仍保留）：結帳前再載入一次，不直接導去 LINE 登入
  if (auth.accessToken && !auth.user) {
    await loadMember();
    // 仍是暫時故障（登入保留、會員資料未載入）：留在原頁，確定被拒時 loadMember 會清除登入再走下一行
    if (auth.accessToken && !auth.user) return showToast("會員資料暫時無法載入，請稍後再試", "warning");
  }
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  // 會員購物車沒合併成功（網路中斷或逾時）就不結帳，避免事後合併把已購商品加回購物車；再按一次會重試
  if (!memberCartSettled) return showToast("購物車還在與會員資料同步，請稍後再按一次結帳；持續失敗請重新整理頁面", "warning");
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const cartMethod = selectedCartDeliveryMethod(resolvedScope);
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
  resetCheckoutCoupon();
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
  const couponReady = await ensureCheckoutCouponApplied();
  renderCheckoutSummary();
  if (!couponReady) throw new Error("優惠碼無法使用，請修正或移除後再建立訂單");
  const itemsForOrder = checkoutCartItems().slice();
  const pickupPlan = "together";
  const needsRecipient = ["home_delivery", "cvs_delivery"].includes(details.deliveryMethod);
  const store = details.pickupStore;
  await saveProfile({ full_name: details.fullName, phone: details.normalizedPhone, birthday: auth.profile?.birthday || null, address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : (auth.profile?.address || null) });
  const orderRequest = JSON.stringify({ items:itemsForOrder.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, delivery_method: details.deliveryMethod, payment_method: details.paymentMethod, shipping_address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : null, shipping_recipient_name: needsRecipient ? details.shippingRecipientName : null, shipping_phone: needsRecipient ? details.normalizedShippingPhone : null, pickup_store_city: store?.city ?? null, pickup_store_district: store?.district ?? null, pickup_store_name: store?.name ?? null, pickup_store_code: store?.code ?? null, bank_account_id: details.bankAccountId, coupon_code: document.querySelector("#checkout-coupon-code")?.value.trim() || null, points_to_redeem: Number(document.querySelector("#checkout-points")?.value || 0) });
  // 剛建單成功但購物車來不及清除（中途重新整理）：先確認，避免以為失敗而重複下單
  if (recentCompletedCheckout(orderRequest) && !window.confirm("剛才已建立相同內容的訂單，要再下一筆嗎？")) {
    closeDialog(document.querySelector("#checkout-dialog"));
    return openOrders();
  }
  // 同一份內容的重送沿用同一個 key：上一次其實已建單時，資料庫會回傳原訂單
  const clientRequestId = checkoutRequestKey(orderRequest);
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...JSON.parse(orderRequest), client_request_id: clientRequestId })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  // 已建單：key 立即標記完成，之後相同內容的購買不會再拿回這筆訂單
  markCheckoutRequestCompleted();
  // 先把已購商品移出購物車並保存（本機與會員雲端），之後才清除 key：
  // 中途重新整理時購物車仍有這些商品，再次結帳會帶同一個 key 拿回原訂單，不會重複建單
  cart.splice(0, cart.length, ...cart.filter((item) => !itemsForOrder.includes(item)));
  saveCart();
  await syncMemberCartNow();
  clearCheckoutRequestKey();
  if (store) rememberCvsStore(store);
  renderCart(); activeCheckoutItems = null; activeCheckoutScope = null; closeDialog(document.querySelector("#checkout-dialog"));
  await loadPoints({ force: true }).catch(() => {});
  // 訂單已建立但明細暫時讀不到：改開我的訂單，不讓客人以為失敗而重新下單
  if (!result.order) {
    showToast("訂單已建立，請在我的訂單查看匯款資訊", "success");
    return openOrders();
  }
  showPaymentDialog(result.order);
}
