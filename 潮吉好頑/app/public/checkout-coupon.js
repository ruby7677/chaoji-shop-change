// 結帳第三步優惠碼「套用」：向伺服器試算折抵、記住已套用的優惠券，以及本次累積點數試算。
// 已套用狀態只由本模組改寫；建單時資料庫仍會重新驗證並核銷。
import { auth } from "./app-core.js";
import { money } from "./product-format.js";
import { checkoutCartItems } from "./cart.js";

let appliedCoupon = null;
let applying = null;

function itemsKey(items) {
  return items.map((item) => `${item.id}:${item.quantity}`).sort().join(",");
}

function couponInput() { return document.querySelector("#checkout-coupon-code"); }
function pointsInput() { return document.querySelector("#checkout-points"); }

/** 目前結帳商品仍有效的已套用優惠券；商品或數量變動後視為失效，需重新套用。 */
export function currentAppliedCoupon() {
  if (!appliedCoupon) return null;
  return appliedCoupon.itemsKey === itemsKey(checkoutCartItems()) ? appliedCoupon : null;
}

function setStatus(message, tone = "") {
  const status = document.querySelector("#checkout-coupon-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", tone === "error");
  status.classList.toggle("is-success", tone === "success");
}

export function syncCouponControls() {
  const coupon = currentAppliedCoupon();
  if (appliedCoupon && !coupon) {
    appliedCoupon = null;
    setStatus("結帳商品已變更，請重新套用優惠碼", "error");
  }
  const button = document.querySelector("[data-checkout-coupon-apply]");
  const points = pointsInput();
  const lockPoints = Boolean(coupon && !coupon.combinable_with_points);
  if (points) {
    if (lockPoints) points.value = "0";
    points.disabled = lockPoints;
  }
  if (button) {
    button.textContent = coupon ? "移除" : "套用";
    button.dataset.action = coupon ? "remove" : "apply";
    button.disabled = Boolean(applying);
  }
  if (coupon) {
    setStatus(`已套用「${coupon.name}」，折抵 ${money(coupon.discount_amount)}${lockPoints ? "；此優惠券不可與點數併用，已取消點數折抵" : ""}`, "success");
  }
}

/** 開啟結帳時清空已套用的優惠券與提示。 */
export function resetCheckoutCoupon() {
  appliedCoupon = null;
  setStatus("");
  syncCouponControls();
}

/** 輸入框內容改變：與已套用的代碼不同時取消套用，點數欄恢復可填。 */
export function handleCouponInputChange() {
  const code = couponInput()?.value.trim().toUpperCase() || "";
  if (appliedCoupon && appliedCoupon.code !== code) {
    appliedCoupon = null;
    setStatus("");
  }
  syncCouponControls();
}

export function removeCheckoutCoupon() {
  appliedCoupon = null;
  const input = couponInput();
  if (input) input.value = "";
  setStatus("");
  syncCouponControls();
}

/** 向伺服器試算優惠碼；成功回傳 true，失敗在欄位下方顯示原因並回傳 false。 */
export async function applyCheckoutCoupon() {
  const input = couponInput();
  const code = input?.value.trim() || "";
  if (!code) { setStatus("請輸入優惠碼", "error"); return false; }
  const items = checkoutCartItems().slice();
  const key = itemsKey(items);
  if (applying) return applying;
  applying = (async () => {
    syncCouponControls();
    setStatus("確認優惠碼中…");
    try {
      const response = await fetch("/api/checkout/coupon-preview", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ items: items.map((item) => ({ variant_id: item.id, quantity: item.quantity })), coupon_code: code })
      });
      const result = await response.json().catch(() => ({}));
      // 等待期間輸入框已改成別的代碼時，丟棄這次結果
      if ((couponInput()?.value.trim() || "") !== code) return false;
      if (!response.ok || !result.coupon) {
        appliedCoupon = null;
        setStatus(result.error || "優惠碼暫時無法確認，請稍後再試", "error");
        return false;
      }
      appliedCoupon = { ...result.coupon, itemsKey: key };
      return true;
    } catch {
      appliedCoupon = null;
      setStatus("優惠碼暫時無法確認，請稍後再試", "error");
      return false;
    } finally {
      applying = null;
      syncCouponControls();
    }
  })();
  return applying;
}

/** 建單前：輸入了代碼但尚未套用（或商品已變動）時自動套用；無效時回傳 false 擋下送出。 */
export async function ensureCheckoutCouponApplied() {
  const code = couponInput()?.value.trim() || "";
  if (!code) return true;
  if (currentAppliedCoupon()?.code === code.toUpperCase()) return true;
  return applyCheckoutCoupon();
}
