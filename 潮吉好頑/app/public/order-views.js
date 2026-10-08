// 會員訂單畫面：首頁「我的訂單」對話框與獨立訂單頁（orders.html）共用的訂單卡、付款明細與回報匯款末五碼。
import { escapeHtml, isPreorderItem, money } from "./product-format.js";
import { deliveryMethodLabels, formatDateTime, linkCustomerServiceText, orderIncludesPreorder, orderInventoryTypeLabel, orderStatusLabel } from "./app-core.js";

function bankAccountFromOrder(order) {
  return Array.isArray(order.bank_accounts) ? order.bank_accounts[0] : order.bank_accounts;
}

// 付款明細 HTML；storePayment 為 true 時（到店支付、賣貨便外部收款）不需回報末五碼
export function paymentOrderView(order) {
  const account = bankAccountFromOrder(order);
  const balance = Math.max(order.amount_due - order.deposit_due, 0);
  const deliveryMethod = order.delivery_method || "store_pickup";
  const storePayment = !order.bank_account_id;
  const sellerDelivery = deliveryMethod === "seller_delivery";
  const preorderSeller = sellerDelivery && !storePayment;
  const hasPreorder = (order.order_items || []).some(isPreorderItem);
  const awaitingInStockHomeDeliveryFee = deliveryMethod === "home_delivery" && !hasPreorder && !Number(order.shipping_fee || 0);
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運。" : preorderSeller ? "預購到貨後客服會通知並開立賣貨便；運費由 7-11 於取貨時向客戶收取。" : sellerDelivery ? "賣貨便運費由 7-11 於取貨時向客戶收取，不計入訂單；如有尾款，請依客服通知完成付款。" : awaitingInStockHomeDeliveryFee ? "私訊小幫手確認運費後，與商品金額一併轉帳／匯款，確認入帳後安排寄出。" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}；請將尾款與運費一併匯款，確認入帳後安排寄出。` : "到貨後由客服通知實際運費，請將尾款與運費一併匯款，確認入帳後安排寄出。";
  const paymentText = sellerDelivery ? (storePayment ? "賣貨便取貨付款（外部）" : "匯款／轉帳（預購訂金）") : storePayment ? "到店支付" : "匯款／轉帳";
  const accountNumber = String(account?.account_number || "");
  const bankDetail = sellerDelivery && storePayment
    ? "此訂單需在 7-ELEVEN 賣貨便完成付款，本站不收取賣貨便款項。"
    : storePayment
      ? "到店取貨時支付，不需回報匯款末五碼。"
      : !account
        ? "匯款帳號暫時無法載入，請稍後重新整理，或私訊官方帳號確認後再匯款。"
        : `<div class="transfer-account-card"><div class="transfer-card-head"><div class="transfer-card-title"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="21" x2="21" y2="21"></line><line x1="3" y1="10" x2="21" y2="10"></line><polyline points="5 6 12 3 19 6"></polyline><line x1="4" y1="10" x2="4" y2="21"></line><line x1="20" y1="10" x2="20" y2="21"></line><line x1="8" y1="14" x2="8" y2="17"></line><line x1="12" y1="14" x2="12" y2="17"></line><line x1="16" y1="14" x2="16" y2="17"></line></svg><span>轉帳專用匯款帳號</span></div></div><div class="transfer-card-total"><span>本次應匯總額</span><strong>${money(order.deposit_due)}</strong></div><div class="transfer-account-inner"><div class="transfer-account-row"><span>收款銀行</span><strong>${escapeHtml(account?.bank_name || account?.label || "收款帳戶")}</strong></div><div class="transfer-account-row"><span>戶名</span><strong>${escapeHtml(account?.account_name || "-")}</strong></div><hr /><div class="transfer-account-number-label">匯款帳號</div><div class="transfer-account-number-line"><strong>${escapeHtml(accountNumber || "-")}</strong><button type="button" class="copy-account-button" data-copy-bank-account="${escapeHtml(accountNumber)}" aria-label="複製匯款帳號">複製<br />帳號</button></div></div><div class="transfer-card-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>轉帳手續費自理；完成後請於下方立即填寫「帳號末五碼」。</span></div></div>`;
  const shippingFeeRow = deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${sellerDelivery ? "賣貨便運費" : "實際運費"}</span><strong>${sellerDelivery ? "由 7-11 向客戶收取" : order.shipping_fee ? money(order.shipping_fee) : awaitingInStockHomeDeliveryFee ? linkCustomerServiceText("請先私訊小幫手確認") : "待客服通知"}</strong></div>` : "";
  const balanceLabel = deliveryMethod === "store_pickup" || deliveryMethod === "home_delivery" || sellerDelivery ? "尾款" : "尾款／運費";
  const balanceRow = balance ? `<div class="payment-row"><span>${balanceLabel}</span><strong>${money(balance)}</strong></div>` : "";
  const amountDueRow = `<div class="payment-row amount${deliveryMethod === "store_pickup" ? " payment-store-pickup-due" : ""}"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>`;
  const paymentRows = deliveryMethod === "store_pickup" ? `${amountDueRow}${balanceRow}` : `${amountDueRow}${balanceRow}${shippingFeeRow}`;
  const deliveryNoticeClass = awaitingInStockHomeDeliveryFee ? "dialog-copy payment-delivery-notice" : "dialog-copy";
  const bankDetailClass = !storePayment && !sellerDelivery && account ?" transfer-bank-detail" : "";
  const html = `<div class="payment-order-card"><h3>${escapeHtml(order.order_number)}</h3><div class="payment-row"><span>取貨方式</span><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod] || "到店取貨")}</strong></div><div class="payment-row"><span>付款方式</span><strong>${paymentText}</strong></div><div class="payment-row"><span>商品原價</span><strong>${money(order.subtotal)}</strong></div>${order.coupon_discount ? `<div class="payment-row"><span>優惠券</span><strong>-${money(order.coupon_discount)}</strong></div>` : ""}${order.point_discount ? `<div class="payment-row"><span>點數折抵</span><strong>-${money(order.point_discount)}</strong></div>` : ""}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div>${paymentRows}<p class="${deliveryNoticeClass}">${linkCustomerServiceText(deliveryNotice)}</p><div class="bank-detail${bankDetailClass}">${bankDetail}</div><p class="deadline">付款／保留期限：${formatDateTime(order.payment_deadline)}</p></div>`;
  return { html, storePayment };
}

// 付款對話框依付款方式切換：末五碼欄位與送出鈕只給匯款訂單
export function applyPaymentFormMode(storePayment) {
  document.querySelector("#payment-last-five-label")?.classList.toggle("hidden", storePayment);
  const lastFiveInput = document.querySelector("#payment-last-five");
  if (lastFiveInput) lastFiveInput.required = !storePayment;
  document.querySelector(".payment-submit")?.classList.toggle("hidden", storePayment);
  document.querySelector("#payment-store-note")?.classList.toggle("hidden", !storePayment);
}

export function ordersEmptyMarkup() {
  return '<div class="orders-empty"><strong>目前還沒有訂單</strong><p>先挑一件喜歡的玩具，加入選物盒後就能在這裡追蹤付款與到貨進度。</p><button class="secondary-button" type="button" data-orders-shop>前往商品區</button></div>';
}

export function orderCardMarkup(order) {
  const items = (order.order_items || []).map((item) => `${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}`).join("<br />");
  const deliveryMethod = order.delivery_method || "store_pickup";
  const sellerPending = deliveryMethod === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
  const preorderSellerPending = deliveryMethod === "seller_delivery" && order.status === "pending_payment" && Boolean(order.bank_account_id);
  const expired = !sellerPending && order.status === "pending_payment" && new Date(order.payment_deadline) <= new Date();
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運" : deliveryMethod === "seller_delivery" ? "賣貨便運費由 7-11 於取貨時收取，不計入訂單" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}` : "運費到貨後由客服通知";
  const paymentNotice = order.bank_account_id ? "匯款／轉帳" : deliveryMethod === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付";
  const statusLabel = sellerPending ? "賣貨便待確認" : preorderSellerPending ? "預購待付訂" : expired ? "付款逾期" : escapeHtml(orderStatusLabel(order));
  const deliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryMethodLabels[deliveryMethod] || "到店取貨"}`;
  const homeBalanceNotice = order.final_payment_confirmed_at
    ? "已確認"
    : orderIncludesPreorder(order)
      ? linkCustomerServiceText("待小幫手通知確認")
      : linkCustomerServiceText("私訊小幫手確認");
  const deliveryFeeRow = deliveryMethod === "home_delivery" ? "" : `<div class="payment-row"><span>配送費用</span><strong>${deliveryNotice}</strong></div>`;
  const balanceNotice = deliveryMethod === "home_delivery" ? homeBalanceNotice : order.final_payment_confirmed_at ? "已確認" : "待客服通知或確認";
  const balanceLabel = deliveryMethod === "home_delivery" ? "尾款／運費" : "尾款";
  return `<article class="order-card${sellerPending ? " seller-pending" : ""}${preorderSellerPending ? " preorder-seller-pending" : ""}"><div class="order-card-head"><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(deliveryLabel)}</small></div><span class="status-chip${sellerPending ? " status-seller-pending" : ""}">${statusLabel}</span></div>${sellerPending ? '<p class="seller-pending-notice"><strong>本站待管理員核對</strong>：請先完成賣貨便結帳；核對後會更新本站訂單狀態並通知你。</p>' : preorderSellerPending ? '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：請於訂單成立後 2 小時內完成匯款並回報末五碼；到貨後客服會通知開立賣貨便。</p>' : ""}<div class="order-items">${items}</div><div class="payment-row"><span>付款方式</span><strong>${paymentNotice}</strong></div>${deliveryFeeRow}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div><div class="payment-row"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>${deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${balanceLabel}</span><strong>${balanceNotice}</strong></div>` : ""}${order.bank_account_id && order.status === "pending_payment" && !expired ? `<button type="button" data-order-payment="${order.id}">回報匯款末五碼</button>` : ""}</article>`;
}

// 送出匯款末五碼，成功回傳更新後的訂單；失敗丟出含伺服器訊息的錯誤
export async function reportPayment(order, lastFive, accessToken) {
  const response = await fetch(`/api/orders/${order.id}/payment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ bank_account_id: order.bank_account_id, payment_last_five: lastFive })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "付款回報失敗");
  return result.order;
}
