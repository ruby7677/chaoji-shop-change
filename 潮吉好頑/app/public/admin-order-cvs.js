// 後台訂單卡的 7-11店到店(交貨便)：下一步文字、取件人／門市／寄件編號資訊、出貨時填寫寄件編號，
// 以及預購到貨後的尾款確認表單（運費固定，不能修改）。
import { escapeHtml, money } from "./product-format.js";
import { cvsPickupStoreText } from "./cvs-delivery.js";
import { adminFinalPaymentLastFive } from "./home-fee-state.js";

export const isCvsOrder = (order) => order?.delivery_method === "cvs_delivery";

/** 店到店的下一步文字；不適用時回傳 null，沿用一般文字。 */
export function cvsTransitionLabel(order, target, hasPreorder) {
  if (!isCvsOrder(order)) return null;
  if (target === "ready_for_pickup" && hasPreorder) return "預購商品已到貨，通知會員確認尾款及運費";
  if (target === "completed") return "已寄出：填寫寄件編號並通知會員";
  return null;
}

export function cvsShippingInfo(order) {
  if (!isCvsOrder(order)) return "";
  const tracking = order.shipment_tracking_number ? `<br />寄件編號：${escapeHtml(order.shipment_tracking_number)}` : "";
  return `<p class="admin-order-note">取件人：${escapeHtml(order.shipping_recipient_name || "未填寫")}<br />電話：${escapeHtml(order.shipping_phone || "未填寫")}<br />取件門市：${escapeHtml(cvsPickupStoreText(order) || "未填寫")}${tracking}</p>`;
}

export function cvsBalanceLabel(order, hasPreorder) {
  if (!hasPreorder) return "已含於應付";
  return order.final_payment_confirmed_at ? "已確認" : "到貨後確認";
}

/** 選「已寄出」時顯示寄件編號欄位（選填）；回傳同步函式給下拉選單 change 使用。 */
export function mountTrackingField(form, order) {
  if (!isCvsOrder(order)) return () => {};
  form.querySelector(".admin-order-note-row")?.insertAdjacentHTML("beforebegin", `<label class="admin-order-tracking" hidden>寄件編號（選填，只顯示在後台與我的訂單）<input name="shipment_tracking_number" maxlength="40" autocomplete="off" value="${escapeHtml(order.shipment_tracking_number || "")}" placeholder="交貨便寄件代碼" /></label>`);
  const label = form.querySelector(".admin-order-tracking");
  return (target) => { if (label) label.hidden = target !== "completed"; };
}

/** 送出狀態轉換時讀取寄件編號；格式錯誤丟出帶 field 的錯誤。 */
export function readTrackingNumber(form, targetStatus) {
  const input = form.querySelector("input[name='shipment_tracking_number']");
  if (targetStatus !== "completed" || !(input instanceof HTMLInputElement)) return null;
  const value = input.value.replace(/\s/g, "");
  if (value && !/^[A-Za-z0-9-]{1,40}$/.test(value)) throw Object.assign(new Error("寄件編號只能包含英數字與連字號，最多 40 字"), { field: "shipment_tracking_number" });
  return value || null;
}

/** 預購店到店到貨後：確認尾款（含固定運費）入帳。現貨建單時已含運費，不顯示表單。 */
export function mountCvsFulfillment(card, order, hasPreorder, insertBefore) {
  if (!isCvsOrder(order) || !hasPreorder || ["completed", "cancelled"].includes(order.status)) return;
  if (order.status !== "ready_for_pickup") {
    const prompt = document.createElement("p");
    prompt.className = "admin-order-terminal";
    prompt.textContent = order.status === "confirmed"
      ? "預購店到店：商品實際到貨後，更新為「預購商品已到貨」；之後確認尾款及運費再寄出。"
      : "請先完成訂金確認；商品到貨後再確認尾款及運費。";
    card.insertBefore(prompt, insertBefore);
    return;
  }
  const balance = Math.max(Number(order.amount_due || 0) - Number(order.paid_amount || 0), 0);
  const form = document.createElement("form");
  form.className = "admin-fulfillment-form";
  form.dataset.adminFulfillmentForm = order.id;
  form.innerHTML = `<div class="form-grid"><div><input name="shipping_fee" type="hidden" value="${Number(order.shipping_fee || 0)}" /><p class="admin-order-note">待收尾款（含運費 ${order.shipping_fee ? money(order.shipping_fee) : "免運"}）：<b>${money(balance)}</b></p></div><label>尾款匯款末五碼<input name="final_payment_last_five" maxlength="5" inputmode="numeric" pattern="[0-9]{5}" value="${escapeHtml(adminFinalPaymentLastFive(order))}" placeholder="付款後填寫" /></label><label class="check-field"><input name="final_payment_confirmed" type="checkbox" ${order.final_payment_confirmed_at ? "checked" : ""} /> 已確認尾款與運費入帳</label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="例如：客服通知日期">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="secondary-button" type="submit">儲存尾款確認</button>`;
  card.insertBefore(form, insertBefore);
}
