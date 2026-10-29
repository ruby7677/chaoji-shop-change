// 會員訂單畫面：首頁「我的訂單」對話框與獨立訂單頁（orders.html）共用的訂單卡、付款明細與回報匯款末五碼。
import { escapeHtml, isPreorderItem, money } from "./product-format.js";
import { deliveryMethodLabels, formatDateTime, linkCustomerServiceText, orderIncludesPreorder, orderInventoryTypeLabel, orderStatusLabel } from "./app-core.js";
import { cvsPickupStoreText } from "./cvs-delivery.js";
import { awaitingStockHomeFee, homeFeeConfirmed, isStockHomeOrder, preorderCvsArrived, preorderCvsBalanceDue, preorderHomeBalanceDue } from "./home-fee-state.js";

const HOME_FEE_PENDING_TEXT = "訂單已建立，待小幫手確認運費後以 LINE 通知，商品＋運費再一併匯款。";

// 現貨宅配運費未確認：黃色區塊只放提醒，不給匯款帳號
function homeFeePendingCard() {
  return `<div class="transfer-account-card home-fee-pending-card"><div class="transfer-card-head"><div class="transfer-card-title"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg><span>等待小幫手確認運費</span></div></div><p class="home-fee-pending-text">${HOME_FEE_PENDING_TEXT}</p><div class="transfer-card-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>收到通知前請先不要匯款；之後可在「我的訂單」查看匯款帳號並回報末五碼。</span></div></div>`;
}

// 宅配運費列：現貨在小幫手確認前顯示待確認，確認後顯示金額或免運
function homeFeeText(order, stockHome) {
  if (Number(order.shipping_fee || 0)) return money(order.shipping_fee);
  if (stockHome) return homeFeeConfirmed(order) ? "免運" : "待小幫手確認運費";
  return "待客服通知";
}

// 7-11 店到店：運費文字、取件門市與寄件編號列（訂單卡與付款明細共用）
function cvsFeeText(order, hasPreorder) {
  const fee = Number(order.shipping_fee || 0);
  return fee ? `${money(fee)}${hasPreorder ? "（隨尾款收取）" : ""}` : "免運";
}

function cvsDetailRows(order) {
  const store = cvsPickupStoreText(order);
  const storeRow = store ? `<div class="payment-row payment-row-store"><span>取件門市</span><strong>${escapeHtml(store)}</strong></div>` : "";
  const trackingRow = order.shipment_tracking_number ? `<div class="payment-row"><span>寄件編號</span><strong>${escapeHtml(order.shipment_tracking_number)}</strong></div>` : "";
  return storeRow + trackingRow;
}

function bankAccountFromOrder(order) {
  return Array.isArray(order.bank_accounts) ? order.bank_accounts[0] : order.bank_accounts;
}

// 黃色匯款帳號卡片（付款明細與預購店到店到貨尾款共用）；total 省略時不顯示金額列
function transferAccountCardMarkup(account, { totalLabel, total, note }) {
  const accountNumber = String(account?.account_number || "");
  const totalRow = totalLabel ? `<div class="transfer-card-total"><span>${totalLabel}</span><strong>${money(total)}</strong></div>` : "";
  return `<div class="transfer-account-card"><div class="transfer-card-head"><div class="transfer-card-title"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="21" x2="21" y2="21"></line><line x1="3" y1="10" x2="21" y2="10"></line><polyline points="5 6 12 3 19 6"></polyline><line x1="4" y1="10" x2="4" y2="21"></line><line x1="20" y1="10" x2="20" y2="21"></line><line x1="8" y1="14" x2="8" y2="17"></line><line x1="12" y1="14" x2="12" y2="17"></line><line x1="16" y1="14" x2="16" y2="17"></line></svg><span>轉帳專用匯款帳號</span></div></div>${totalRow}<div class="transfer-account-inner"><div class="transfer-account-row"><span>收款銀行</span><strong>${escapeHtml(account?.bank_name || account?.label || "收款帳戶")}</strong></div><div class="transfer-account-row"><span>戶名</span><strong>${escapeHtml(account?.account_name || "-")}</strong></div><hr /><div class="transfer-account-number-label">匯款帳號</div><div class="transfer-account-number-line"><strong>${escapeHtml(accountNumber || "-")}</strong><button type="button" class="copy-account-button" data-copy-bank-account="${escapeHtml(accountNumber)}" aria-label="複製匯款帳號">複製<br />帳號</button></div><p class="transfer-card-warning">匯款請勿備注，避免無法核對後五碼</p></div><div class="transfer-card-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>${note}</span></div></div>`;
}

const ACCOUNT_UNAVAILABLE_TEXT = "匯款帳號暫時無法載入，請稍後重新整理，或私訊官方帳號確認後再匯款。";

// 付款明細 HTML 與付款表單模式：store（到店支付、賣貨便外部收款，不需回報末五碼）、
// awaiting_fee（現貨宅配待小幫手確認運費，不給帳號）、transfer（顯示匯款帳號並回報末五碼）
export function paymentOrderView(order) {
  const account = bankAccountFromOrder(order);
  const balance = Math.max(order.amount_due - order.deposit_due, 0);
  const deliveryMethod = order.delivery_method || "store_pickup";
  const storePayment = !order.bank_account_id;
  const sellerDelivery = deliveryMethod === "seller_delivery";
  const preorderSeller = sellerDelivery && !storePayment;
  const hasPreorder = (order.order_items || []).some(isPreorderItem);
  const cvsDelivery = deliveryMethod === "cvs_delivery";
  const cvsNotice = hasPreorder
    ? "運費於商品到貨後與尾款一併收取；到貨後小幫手會通知尾款及運費。"
    : `${Number(order.shipping_fee || 0) ? `本次應付已含運費 ${money(order.shipping_fee)}` : "已達免運門檻"}；確認入帳後安排出貨，出貨後請留意 7-11 到貨簡訊。`;
  const stockHome = isStockHomeOrder(order, hasPreorder);
  const awaitingFee = !storePayment && awaitingStockHomeFee(order, hasPreorder);
  // 預購宅配到貨、尾款與運費已確認：顯示尾款匯款帳號，末五碼回覆給小幫手（網站只能回報訂金末五碼）
  const balanceDue = !storePayment && preorderHomeBalanceDue(order, hasPreorder);
  const stockHomeNotice = !homeFeeConfirmed(order)
    ? "待小幫手確認運費後以 LINE 通知，運費併入尾款收取，確認入帳後安排寄出。"
    : Number(order.shipping_fee || 0)
      ? `運費 ${money(order.shipping_fee)} 已確認並併入應付金額，確認入帳後安排寄出。`
      : "運費已確認（免運），確認入帳後安排寄出。";
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運。" : cvsDelivery ? cvsNotice : preorderSeller ? "預購到貨後客服會通知並開立賣貨便；運費由 7-11 於取貨時向客戶收取。" : sellerDelivery ? "賣貨便運費由 7-11 於取貨時向客戶收取，不計入訂單；如有尾款，請依客服通知完成付款。" : awaitingFee ? "" : stockHome ? stockHomeNotice : balanceDue ? `尾款與運費已確認（運費${Number(order.shipping_fee || 0) ? ` ${money(order.shipping_fee)}` : "免運"}），請將尾款匯入下方帳號，匯款後請回覆末五碼給小幫手，確認入帳後安排寄出。` : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}；請將尾款與運費一併匯款，確認入帳後安排寄出。` : "到貨後由客服通知實際運費，請將尾款與運費一併匯款，確認入帳後安排寄出。";
  const paymentText = sellerDelivery ? (storePayment ? "賣貨便取貨付款（外部）" : "匯款／轉帳（預購訂金）") : storePayment ? "到店支付" : "匯款／轉帳";
  const bankDetail = sellerDelivery && storePayment
    ? "此訂單需在 7-ELEVEN 賣貨便完成付款，本站不收取賣貨便款項。"
    : storePayment
      ? "到店取貨時支付，不需回報匯款末五碼。"
      : awaitingFee
        ? homeFeePendingCard()
      : !account
        ? ACCOUNT_UNAVAILABLE_TEXT
        : transferAccountCardMarkup(account, { totalLabel: balanceDue ? "待付尾款（含運費）" : "本次應匯總額", total: balanceDue ? balance : order.deposit_due, note: balanceDue ? "轉帳手續費自理；匯款後請回覆末五碼給小幫手。" : "轉帳手續費自理；完成後請於下方立即填寫「帳號末五碼」。" });
  const shippingFeeRow = deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${sellerDelivery ? "賣貨便運費" : cvsDelivery ? "運費" : "實際運費"}</span><strong>${sellerDelivery ? "由 7-11 向客戶收取" : cvsDelivery ? cvsFeeText(order, hasPreorder) : homeFeeText(order, stockHome)}</strong></div>` : "";
  const balanceLabel = cvsDelivery ? "尾款（含運費）" : deliveryMethod === "store_pickup" || deliveryMethod === "home_delivery" || sellerDelivery ? "尾款" : "尾款／運費";
  const balanceRow = balance ? `<div class="payment-row"><span>${balanceLabel}</span><strong>${money(balance)}</strong></div>` : "";
  const amountDueRow = `<div class="payment-row amount${deliveryMethod === "store_pickup" ? " payment-store-pickup-due" : ""}"><span>本次應付</span><strong>${awaitingFee ? "待運費確認後通知" : money(balanceDue ? Math.max(order.amount_due - order.deposit_due, 0) : order.deposit_due)}</strong></div>`;
  // 運費列緊接在訂單總額下方，再接本次應付
  const paymentRows = `${amountDueRow}${balanceRow}`;
  const bankDetailClass = !storePayment && !sellerDelivery && (account || awaitingFee) ? " transfer-bank-detail" : "";
  // 現貨宅配是等小幫手通知，不再引導客人私訊，「小幫手」不加連結
  const deliveryNoticeHtml = deliveryNotice ? `<p class="dialog-copy">${stockHome ? escapeHtml(deliveryNotice) : linkCustomerServiceText(deliveryNotice)}</p>` : "";
  const deadlineText = balanceDue
    ? "尾款與運費確認入帳後安排寄出"
    : awaitingFee
    ? `保留期限：${formatDateTime(order.payment_deadline)}（運費確認後重新計算 24 小時付款期限）`
    : `付款／保留期限：${formatDateTime(order.payment_deadline)}`;
  const mode = storePayment ? "store" : awaitingFee ? "awaiting_fee" : balanceDue ? "balance" : "transfer";
  const html = `<div class="payment-order-card"><h3>${escapeHtml(order.order_number)}</h3><div class="payment-row"><span>取貨方式</span><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod] || "到店取貨")}</strong></div>${cvsDelivery ? cvsDetailRows(order) : ""}<div class="payment-row"><span>付款方式</span><strong>${paymentText}</strong></div><div class="payment-row"><span>商品原價</span><strong>${money(order.subtotal)}</strong></div>${order.coupon_discount ? `<div class="payment-row"><span>優惠券</span><strong>-${money(order.coupon_discount)}</strong></div>` : ""}${order.point_discount ? `<div class="payment-row"><span>點數折抵</span><strong>-${money(order.point_discount)}</strong></div>` : ""}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div>${shippingFeeRow}${paymentRows}${deliveryNoticeHtml}<div class="bank-detail${bankDetailClass}">${bankDetail}</div><p class="deadline">${deadlineText}</p></div>`;
  return { html, mode };
}

// 付款對話框依模式切換：末五碼欄位與送出鈕只給可匯款的訂單；待確認運費時改成「查看我的訂單」
export function applyPaymentFormMode(mode) {
  const transfer = mode === "transfer";
  const awaitingFee = mode === "awaiting_fee";
  document.querySelector("#payment-last-five-label")?.classList.toggle("hidden", !transfer);
  const lastFiveInput = document.querySelector("#payment-last-five");
  if (lastFiveInput) lastFiveInput.required = transfer;
  document.querySelector(".payment-submit")?.classList.toggle("hidden", !transfer);
  document.querySelector("[data-payment-later]")?.classList.toggle("hidden", awaitingFee || mode === "balance");
  document.querySelector("#payment-store-note")?.classList.toggle("hidden", mode !== "store");
  const form = document.querySelector("#payment-form");
  if (form && !form.querySelector("[data-payment-orders]")) form.insertAdjacentHTML("beforeend", '<button class="primary-button hidden" type="button" data-payment-orders>查看我的訂單</button>');
  form?.querySelector("[data-payment-orders]")?.classList.toggle("hidden", !awaitingFee);
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
  const cvsDelivery = deliveryMethod === "cvs_delivery";
  const hasPreorder = orderIncludesPreorder(order);
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運" : cvsDelivery ? cvsFeeText(order, hasPreorder) : deliveryMethod === "seller_delivery" ? "賣貨便運費由 7-11 於取貨時收取，不計入訂單" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}` : "運費到貨後由客服通知";
  const paymentNotice = order.bank_account_id ? "匯款／轉帳" : deliveryMethod === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付";
  const statusLabel = sellerPending ? "賣貨便待確認" : preorderSellerPending ? "預購待付訂" : expired ? "付款逾期" : escapeHtml(orderStatusLabel(order));
  const deliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryMethodLabels[deliveryMethod] || "到店取貨"}`;
  const stockHome = isStockHomeOrder(order, hasPreorder);
  const awaitingFee = awaitingStockHomeFee(order, hasPreorder);
  const balanceDue = preorderHomeBalanceDue(order, hasPreorder);
  // 預購店到店到貨：訂金已付，尾款＝訂單總額（含運費）－訂金，直接附上匯款帳號
  const cvsArrived = preorderCvsArrived(order, hasPreorder);
  const cvsBalanceDue = preorderCvsBalanceDue(order, hasPreorder);
  const homeBalanceNotice = order.final_payment_confirmed_at
    ? "已確認"
    : balanceDue || cvsBalanceDue
      ? money(Math.max(order.amount_due - order.deposit_due, 0))
    : hasPreorder
      ? "待小幫手通知確認"
      : homeFeeText(order, true);
  const deliveryFeeRow = deliveryMethod === "home_delivery" ? "" : `<div class="payment-row"><span>配送費用</span><strong>${deliveryNotice}</strong></div>`;
  const balanceNotice = deliveryMethod === "home_delivery" || cvsDelivery ? homeBalanceNotice : order.final_payment_confirmed_at ? "已確認" : "待客服通知或確認";
  const balanceLabel = deliveryMethod === "home_delivery" || cvsDelivery ? "尾款／運費" : "尾款";
  // 現貨店到店建單時已含運費，沒有尾款
  const showBalance = deliveryMethod !== "store_pickup" && !(cvsDelivery && !hasPreorder);
  const totalRow = `<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div>`;
  const amountDueRow = `<div class="payment-row"><span>${cvsArrived ? "已付訂金" : "本次應付"}</span><strong>${awaitingFee ? "待運費確認後通知" : money(balanceDue ? Math.max(order.amount_due - order.deposit_due, 0) : order.deposit_due)}</strong></div>`;
  const balanceRow = showBalance ? `<div class="payment-row${cvsBalanceDue ? " balance-due-row" : ""}"><span>${balanceLabel}</span><strong>${balanceNotice}</strong></div>` : "";
  const account = bankAccountFromOrder(order);
  const cvsBalanceAccount = !cvsBalanceDue ? "" : account
    ? `<div class="order-balance-account">${transferAccountCardMarkup(account, { note: "轉帳手續費自理；匯款後請回覆末五碼給小幫手，確認入帳後安排寄出。" })}</div>`
    : `<p class="seller-pending-notice">${ACCOUNT_UNAVAILABLE_TEXT}</p>`;
  // 現貨宅配依「訂單總額 → 尾款／運費 → 本次應付」排列；運費確認前不能回報匯款
  const amountRows = stockHome ? `${totalRow}${balanceRow}${amountDueRow}` : `${totalRow}${amountDueRow}${balanceRow}`;
  const canReport = order.bank_account_id && order.status === "pending_payment" && !expired && !awaitingFee;
  const reportButton = canReport
    ? `<button type="button" data-order-payment="${order.id}">${stockHome ? "查看匯款帳號並回報末五碼" : "回報匯款末五碼"}</button>`
    : balanceDue ? `<button type="button" data-order-payment="${order.id}">查看尾款匯款帳號</button>` : "";
  const homeFeeNotice = awaitingFee && !expired ? '<p class="seller-pending-notice"><strong>待小幫手確認運費</strong>：確認後會以 LINE 通知商品＋運費總額，收到通知再匯款。</p>' : "";
  return `<article class="order-card${sellerPending ? " seller-pending" : ""}${preorderSellerPending ? " preorder-seller-pending" : ""}"><div class="order-card-head"><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(deliveryLabel)}</small></div><span class="status-chip${sellerPending ? " status-seller-pending" : ""}">${statusLabel}</span></div>${sellerPending ? '<p class="seller-pending-notice"><strong>本站待管理員核對</strong>：請先完成賣貨便結帳；核對後會更新本站訂單狀態並通知你。</p>' : preorderSellerPending ? '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：請於訂單成立後 2 小時內完成匯款並回報末五碼；到貨後客服會通知開立賣貨便。</p>' : ""}${homeFeeNotice}<div class="order-items">${items}</div><div class="payment-row"><span>付款方式</span><strong>${paymentNotice}</strong></div>${deliveryFeeRow}${cvsDelivery ? cvsDetailRows(order) : ""}${amountRows}${cvsBalanceAccount}${reportButton}</article>`;
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
