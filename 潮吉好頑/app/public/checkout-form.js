// 結帳表單：摘要、取貨／付款方式欄位、收件資料驗證、點數與優惠券、收款帳戶。
import { escapeHtml, isPreorderItem, money } from "./product-format.js";
import { auth, customerServiceLineUrl, deliveryMethodLabels, deliveryMethodNotes } from "./app-core.js";
import { checkoutCartItems, selectedDeliveryMethod, selectedPaymentMethod } from "./cart.js";
import { activeCheckoutScope, showCheckoutError } from "./app.js";

export let bankAccounts = [];

export function renderCheckoutSummary() {
  const checkoutItems = checkoutCartItems();
  const total = checkoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const preorderCheckout = checkoutItems.length > 0 && (activeCheckoutScope === "preorder" || checkoutItems.every(isPreorderItem));
  const depositTotal = preorderCheckout
    ? checkoutItems.reduce((sum, item) => {
      const configuredRate = Number(item.deposit_rate);
      const depositRate = Number.isFinite(configuredRate) && configuredRate > 0 ? Math.min(configuredRate, 1) : 0.5;
      return sum + Math.round(item.price * item.quantity * depositRate);
    }, 0)
    : total;
  const deliveryMethod = selectedDeliveryMethod();
  const points = Math.max(0, Number(document.querySelector("#checkout-points")?.value || 0));
  const couponCode = document.querySelector("#checkout-coupon-code")?.value.trim() || "";
  const settings = auth.points?.settings;
  const pointDiscount = settings ? Math.min(points * settings.point_value, preorderCheckout ? depositTotal : total) : 0;
  const estimatedTotal = Math.max(depositTotal - pointDiscount, 0);
  const couponRow = `<div class="checkout-summary-row"><span>優惠券</span><strong>${couponCode ? "待系統確認" : "未使用"}</strong></div>`;
  const couponNote = couponCode ? `<p class="checkout-summary-note checkout-coupon-note"><strong>優惠碼已輸入</strong>：${escapeHtml(couponCode)} 的折抵會依商品、會員資格、有效期限與併用規則於建立訂單時驗證；預估總額尚未先扣除。</p>` : "";
  const deliveryNote = deliveryMethod === "seller_delivery" && checkoutItems.every(isPreorderItem)
    ? "預購先建立本站訂單並支付訂金；到貨後客服通知，再開立賣貨便供尾款取貨。運費由 7-11 於取貨時收取。"
    : deliveryMethodNotes[deliveryMethod];
  const itemRows = checkoutItems.map((item) => `<div class="checkout-summary-row checkout-summary-item"><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${money(item.price * item.quantity)}</strong></div>`).join("");
  const depositRow = preorderCheckout ? `<div class="checkout-summary-row"><span>預購訂金 50%</span><strong>${money(depositTotal)}</strong></div>` : "";
  const pointRow = `<div class="checkout-summary-row checkout-summary-discount"><span>點數預估折抵</span><strong>${pointDiscount ? `-${money(pointDiscount)}` : money(0)}</strong></div>`;
  document.querySelector("#checkout-order-summary").innerHTML = `<div class="checkout-summary-head"><span aria-hidden="true">金額</span><div><h4>結算金額</h4><p>建立訂單後，系統回傳最終優惠與付款金額。</p></div></div><div class="checkout-summary-lines">${itemRows}<div class="checkout-summary-row"><span>商品總額</span><strong>${money(total)}</strong></div>${depositRow}${couponRow}${pointRow}<div class="checkout-summary-row checkout-summary-payable"><span>本次預估應付</span><strong>${money(estimatedTotal)}</strong></div></div>${couponNote}<p class="checkout-summary-note"><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod])}</strong>：${escapeHtml(deliveryNote)}</p>`;
  const payable = document.querySelector("#checkout-review-payable");
  if (payable) payable.textContent = money(estimatedTotal);
  const totalNote = document.querySelector("#checkout-review-total-note");
  if (totalNote) totalNote.textContent = couponCode ? "預估應付・優惠券待確認" : "本次預估應付";
}

function ensureShippingRecipientFields() {
  const addressLabel = document.querySelector("#checkout-address-label");
  if (!addressLabel || document.querySelector("#checkout-recipient-name-label")) return;
  addressLabel.insertAdjacentHTML("beforebegin", '<label id="checkout-recipient-name-label" class="hidden" data-checkout-detail>宅配收件人姓名 <input id="checkout-recipient-name" maxlength="60" autocomplete="name" placeholder="請填寫收件人姓名" /></label><label id="checkout-recipient-phone-label" class="hidden" data-checkout-detail>宅配收件人電話 <input id="checkout-recipient-phone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="09xx-xxx-xxx" /></label>');
  if (auth.profile?.full_name) document.querySelector("#checkout-recipient-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-recipient-phone").value = auth.profile.phone;
}

function ensureCheckoutFieldErrors() {
  const fields = [
    ["#checkout-name", "checkout-name-error"],
    ["#checkout-phone", "checkout-phone-error"],
    ["#checkout-recipient-name", "checkout-recipient-name-error"],
    ["#checkout-recipient-phone", "checkout-recipient-phone-error"],
    ["#checkout-address", "checkout-address-error"]
  ];
  fields.forEach(([selector, errorId]) => {
    const input = document.querySelector(selector);
    if (!input) return;
    if (!document.querySelector(`#${errorId}`)) input.insertAdjacentHTML("afterend", `<small id="${errorId}" class="field-error hidden" role="alert"></small>`);
    const describedBy = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    describedBy.add(errorId);
    input.setAttribute("aria-describedby", [...describedBy].join(" "));
  });
  const bankFieldset = document.querySelector("#checkout-bank-fieldset");
  if (bankFieldset) {
    if (!document.querySelector("#checkout-bank-error")) bankFieldset.insertAdjacentHTML("afterend", '<p id="checkout-bank-error" class="field-error hidden" role="alert"></p>');
    bankFieldset.setAttribute("aria-describedby", "checkout-bank-error");
  }
  const paymentFieldset = document.querySelector("#payment-method-fieldset");
  if (paymentFieldset) {
    if (!document.querySelector("#checkout-payment-method-error")) paymentFieldset.insertAdjacentHTML("afterend", '<p id="checkout-payment-method-error" class="field-error hidden" role="alert"></p>');
    paymentFieldset.setAttribute("aria-describedby", "checkout-payment-method-error");
  }
}

export function clearCheckoutFieldErrors() {
  document.querySelectorAll("#checkout-form .field-error").forEach((node) => { node.textContent = ""; node.classList.add("hidden"); });
  document.querySelectorAll("#checkout-form [aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
}

export function clearCheckoutFieldErrorFor(target) {
  const localError = target.parentElement?.querySelector(".field-error");
  if (localError) { localError.textContent = ""; localError.classList.add("hidden"); target.removeAttribute("aria-invalid"); }
  const group = target.closest("fieldset");
  const groupErrorId = group?.id === "checkout-bank-fieldset" ? "checkout-bank-error" : group?.id === "payment-method-fieldset" ? "checkout-payment-method-error" : null;
  if (groupErrorId) { document.querySelector(`#${groupErrorId}`)?.classList.add("hidden"); document.querySelector(`#${groupErrorId}`)?.replaceChildren(); group.removeAttribute("aria-invalid"); }
}

function checkoutValidationError(selector, message) {
  const field = document.querySelector(selector);
  const errorId = field?.id === "checkout-bank-fieldset" ? "checkout-bank-error" : field?.id === "payment-method-fieldset" ? "checkout-payment-method-error" : null;
  const error = errorId ? document.querySelector(`#${errorId}`) : field?.nextElementSibling;
  if (field) field.setAttribute("aria-invalid", "true");
  if (error?.classList.contains("field-error")) { error.textContent = message; error.classList.remove("hidden"); }
  const focusTarget = field?.matches("input,select,textarea") ? field : field?.querySelector("input,select,textarea");
  focusTarget?.focus({ preventScroll: true });
  throw new Error(message);
}

function checkoutDetails() {
  const fullName = document.querySelector("#checkout-name").value.trim();
  const phone = document.querySelector("#checkout-phone").value.trim();
  const deliveryMethod = selectedDeliveryMethod();
  const paymentMethod = selectedPaymentMethod();
  const shippingAddress = document.querySelector("#checkout-address").value.trim();
  const shippingRecipientName = document.querySelector("#checkout-recipient-name")?.value.trim() || "";
  const shippingPhone = document.querySelector("#checkout-recipient-phone")?.value.trim() || "";
  const bankAccountId = paymentMethod === "bank_transfer" ? document.querySelector("input[name='bank_account']:checked")?.value : null;
  return {
    fullName,
    phone,
    normalizedPhone: phone.replace(/[\s-]/g, ""),
    deliveryMethod,
    paymentMethod,
    shippingAddress,
    shippingRecipientName,
    shippingPhone,
    normalizedShippingPhone: shippingPhone.replace(/[\s-]/g, ""),
    bankAccountId
  };
}

export function validateCheckoutDetails() {
  ensureShippingRecipientFields();
  ensureCheckoutFieldErrors();
  clearCheckoutFieldErrors();
  const details = checkoutDetails();
  if (!details.fullName) checkoutValidationError("#checkout-name", "請填寫姓名");
  if (!/^09\d{8}$/.test(details.normalizedPhone)) checkoutValidationError("#checkout-phone", "請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  if (details.paymentMethod === "store_payment") checkoutValidationError("#payment-method-fieldset", "本站到店取貨與宅配訂單僅接受匯款／轉帳");
  if (details.paymentMethod === "bank_transfer" && !details.bankAccountId) checkoutValidationError("#checkout-bank-fieldset", "請選擇收款帳戶");
  if (details.deliveryMethod === "home_delivery" && !details.shippingAddress) checkoutValidationError("#checkout-address", "宅配請填寫收件地址");
  if (details.deliveryMethod === "home_delivery" && !details.shippingRecipientName) checkoutValidationError("#checkout-recipient-name", "宅配請填寫收件人姓名");
  if (details.deliveryMethod === "home_delivery" && !/^09\d{8}$/.test(details.normalizedShippingPhone)) checkoutValidationError("#checkout-recipient-phone", "宅配請填寫有效的收件人手機號碼");
  return details;
}

export function setCheckoutStage(stage, { focus = true } = {}) {
  const form = document.querySelector("#checkout-form");
  if (!form) return;
  const review = stage === "review";
  form.dataset.checkoutStage = review ? "review" : "details";
  form.querySelectorAll("[data-checkout-detail]").forEach((node) => {
    node.classList.toggle("hidden", review);
    node.setAttribute("aria-hidden", String(review));
  });
  form.querySelectorAll("[data-checkout-review]").forEach((node) => {
    node.classList.toggle("hidden", !review);
    node.setAttribute("aria-hidden", String(!review));
  });
  const reviewStep = document.querySelector("#checkout-review-step");
  if (reviewStep) {
    reviewStep.classList.toggle("hidden", !review);
    reviewStep.setAttribute("aria-hidden", String(!review));
  }
  form.querySelectorAll("[data-checkout-step-indicator]").forEach((node) => {
    const current = node.dataset.checkoutStepIndicator === (review ? "review" : "details");
    const complete = node.dataset.checkoutStepIndicator === "cart" || (review && node.dataset.checkoutStepIndicator === "details");
    node.classList.toggle("is-complete", complete);
    node.classList.toggle("is-current", current);
    if (current) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  });
  if (review) {
    renderCheckoutBenefits();
    renderCheckoutSummary();
  } else {
    syncDeliveryFields();
  }
  if (focus) window.requestAnimationFrame(() => (review ? document.querySelector("#checkout-review-title") : document.querySelector("#checkout-name"))?.focus({ preventScroll: false }));
}

export function openCheckoutReview() {
  document.querySelector("#checkout-error")?.classList.add("hidden");
  try {
    validateCheckoutDetails();
    setCheckoutStage("review");
  } catch (error) {
    showCheckoutError(error.message);
  }
}

export function ensurePaymentMethodUI() {
  const bankAccounts = document.querySelector("#checkout-bank-accounts");
  const bankFieldset = bankAccounts?.closest("fieldset");
  if (bankFieldset) {
    bankFieldset.id = "checkout-bank-fieldset";
  }
  if (bankFieldset && !document.querySelector("#payment-method-fieldset")) {
    bankFieldset.insertAdjacentHTML("beforebegin", '<fieldset id="payment-method-fieldset" data-checkout-detail><legend>付款方式</legend><label class="radio"><input checked type="radio" name="payment_method" value="bank_transfer" /> <span><strong>匯款／轉帳</strong><small>建單後取得專用匯款資訊；匯款完成再回報帳號末五碼。</small></span></label></fieldset>');
  }
  const paymentFieldset = document.querySelector("#payment-method-fieldset");
  document.querySelector("#checkout-payment-note")?.remove();
  const lastFive = document.querySelector("#payment-last-five");
  const lastFiveLabel = lastFive?.closest("label");
  if (lastFiveLabel) lastFiveLabel.id = "payment-last-five-label";
  const paymentForm = document.querySelector("#payment-form");
  if (paymentForm && !document.querySelector("#payment-store-note")) paymentForm.insertAdjacentHTML("beforeend", '<p id="payment-store-note" class="dialog-copy hidden">此訂單選擇到店支付，不需要回報匯款末五碼；請依通知時間到店付款取貨。</p>');
}

export function syncCheckoutSellerOption() {
  const fieldset = document.querySelector("#checkout-form .delivery-methods");
  if (!fieldset) return;
  let option = document.querySelector("#checkout-seller-delivery-option");
  if (!option) {
    fieldset.insertAdjacentHTML("beforeend", '<label id="checkout-seller-delivery-option" class="radio delivery-option hidden"><input type="radio" name="delivery_method" value="seller_delivery" /> <span><strong>賣貨便</strong><small>預購商品先建立本站訂單；到貨後由客服通知並開立賣貨便，運費由 7-11 取貨時收取。</small></span></label>');
    option = document.querySelector("#checkout-seller-delivery-option");
  }
  option?.classList.toggle("hidden", activeCheckoutScope !== "preorder");
}

export function syncDeliveryFields() {
  ensureShippingRecipientFields();
  ensureCheckoutFieldErrors();
  syncCheckoutSellerOption();
  const method = selectedDeliveryMethod();
  const deliveryName = document.querySelector("#checkout-delivery-name");
  const deliveryNote = document.querySelector("#checkout-delivery-note");
  if (deliveryName) deliveryName.textContent = deliveryMethodLabels[method] || deliveryMethodLabels.store_pickup;
  if (deliveryNote) {
    if (method === "home_delivery") {
      deliveryNote.innerHTML = `現貨宅配匯款時<a class="helper-contact-link checkout-home-fee-link" href="${customerServiceLineUrl}" target="_blank" rel="noopener noreferrer">先私訊小幫手確認運費再連同商品一併匯款</a>即可；預購商品到貨後通知，尾款與運費確認入帳後安排寄出。`;
    } else {
      deliveryNote.textContent = deliveryMethodNotes[method] || deliveryMethodNotes.store_pickup;
    }
  }
  const addressLabel = document.querySelector("#checkout-address-label");
  const addressInput = document.querySelector("#checkout-address");
  const recipientLabel = document.querySelector("#checkout-recipient-name-label");
  const recipientInput = document.querySelector("#checkout-recipient-name");
  const recipientPhoneLabel = document.querySelector("#checkout-recipient-phone-label");
  const recipientPhoneInput = document.querySelector("#checkout-recipient-phone");
  const isHome = method === "home_delivery";
  if (addressLabel) {
    addressLabel.classList.toggle("hidden", !isHome);
    addressLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (addressInput) addressInput.required = isHome;
  if (recipientLabel) {
    recipientLabel.classList.toggle("hidden", !isHome);
    recipientLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (recipientInput) recipientInput.required = isHome;
  if (recipientPhoneLabel) {
    recipientPhoneLabel.classList.toggle("hidden", !isHome);
    recipientPhoneLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (recipientPhoneInput) recipientPhoneInput.required = isHome;
  syncPaymentFields();
  renderCheckoutSummary();
}

export function syncPaymentFields() {
  const method = selectedDeliveryMethod();
  const paymentMethodError = document.querySelector("#checkout-payment-method-error");
  if (paymentMethodError) { paymentMethodError.textContent = ""; paymentMethodError.classList.add("hidden"); document.querySelector("#payment-method-fieldset")?.removeAttribute("aria-invalid"); }
  const bankFieldset = document.querySelector("#checkout-bank-fieldset");
  if (bankFieldset) {
    // 收款帳戶在訂單建立後的付款資訊視窗顯示；第二步只保留隱藏的預設帳戶供建單使用。
    bankFieldset.classList.add("hidden");
    bankFieldset.setAttribute("aria-hidden", "true");
  }
  document.querySelector("#checkout-payment-note")?.remove();
  const submitButton = document.querySelector(".checkout-submit");
  if (submitButton) submitButton.textContent = "建立訂單並取得匯款資訊";
}

function ensureCheckoutBenefits() {
  if (document.querySelector("#checkout-coupon-code")) return;
  document.querySelector("#checkout-order-summary").insertAdjacentHTML("beforebegin", '<section class="checkout-benefits" data-checkout-review aria-hidden="true" aria-labelledby="checkout-benefits-title"><div class="checkout-benefits-head"><div><h4 id="checkout-benefits-title">優惠折抵</h4><p>可選擇使用，不影響商品保留流程。</p></div><span>OPTIONAL</span></div><div class="checkout-benefits-grid"><label>優惠碼<input id="checkout-coupon-code" maxlength="32" autocomplete="off" placeholder="輸入優惠碼（選填）" list="member-coupon-options" /><datalist id="member-coupon-options"></datalist></label><label>使用點數<input id="checkout-points" type="number" min="0" step="1" value="0" inputmode="numeric" aria-describedby="checkout-point-help" /><small id="checkout-point-help">未使用點數</small></label></div><p class="checkout-benefits-note">優惠資格、有效期限、使用次數及併用規則，會在建立訂單時由系統確認。</p></section>');
}

export function renderCheckoutBenefits() {
  ensureCheckoutBenefits();
  const balance = auth.points?.balance || 0;
  const settings = auth.points?.settings;
  const pointsInput = document.querySelector("#checkout-points");
  pointsInput.max = String(balance);
  document.querySelector("#checkout-point-help").textContent = settings ? `可用 ${balance} 點；最低 ${settings.min_redeem_points} 點，每點折 ${money(settings.point_value)}` : "點數資料載入中";
  document.querySelector("#member-coupon-options").innerHTML = (auth.points?.coupons || []).map((coupon) => `<option value="${escapeHtml(coupon.code)}">${escapeHtml(coupon.name)} · 折 ${money(coupon.discount_amount)} · 至 ${new Date(coupon.valid_until).toLocaleDateString("zh-TW")}</option>`).join("");
}

// 後台修改收款帳戶後清空快取，下次結帳重新讀取（後台模組不能直接重新指定這個 let）
export function invalidateBankAccounts() {
  bankAccounts = [];
}

export async function loadBankAccounts(force = false) {
  const container = document.querySelector("#checkout-bank-accounts");
  const submitButton = document.querySelector(".checkout-submit");
  const nextButton = document.querySelector("[data-checkout-review-next]");
  if (bankAccounts.length && !force) return renderBankAccounts();
  container.innerHTML = '<p class="dialog-copy">載入收款帳戶中…</p>';
  submitButton.disabled = true;
  if (nextButton) nextButton.disabled = true;
  try {
    const response = await fetch("/api/bank-accounts", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "收款帳戶載入失敗");
    bankAccounts = Array.isArray(result.accounts) ? result.accounts : [];
    renderBankAccounts();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    submitButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
  }
}

function renderBankAccounts() {
  const container = document.querySelector("#checkout-bank-accounts");
  const submitButton = document.querySelector(".checkout-submit");
  const nextButton = document.querySelector("[data-checkout-review-next]");
  if (!bankAccounts.length) {
    container.innerHTML = '<p class="form-error">商店尚未設定收款帳戶，目前無法建立訂單，請聯繫 LINE 客服。</p>';
    submitButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
    return;
  }
  container.innerHTML = bankAccounts.map((account, index) => `<label class="bank-option"><input type="radio" name="bank_account" value="${escapeHtml(account.id)}" ${index === 0 ? "checked" : ""} /><span><strong>${escapeHtml(account.label || account.bank_name)}</strong><small>${escapeHtml(account.bank_name)} ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></span></label>`).join("");
  submitButton.disabled = false;
  if (nextButton) nextButton.disabled = false;
  syncPaymentFields();
}
