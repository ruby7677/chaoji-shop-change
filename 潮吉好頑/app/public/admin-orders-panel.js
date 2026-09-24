// 後台訂單分頁：狀態篩選、訂單卡片、狀態轉換、退貨驗收與宅配尾款／運費。
import { escapeHtml, money } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { adminOrderStatusLabel, deliveryMethodLabels, formatDateTime, orderIncludesPreorder, orderInventoryTypeLabel, showToast } from "./app-core.js";
import { loadProducts, renderProducts } from "./storefront-catalog.js";
import { adminData, adminFetch, refreshAdminSections, relationOne, renderAdminPagination, switchAdminTab } from "./admin-app.js";

const adminOrderTransitions = {
  pending_payment: [{ value: "confirmed", label: "確認到店付款", storePaymentOnly: true }, { value: "cancelled", label: "取消未付款訂單" }],
  pending_review: [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }],
  confirmed: [{ value: "partially_ready", label: "標記預購商品部分到貨", splitOnly: true }, { value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  partially_ready: [{ value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  ready_for_pickup: [{ value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  completed: [{ value: "refund_pending", label: "進入退款處理" }],
  refund_pending: [{ value: "refunded", label: "確認已退款" }, { value: "completed", label: "取消退款，恢復已完成" }]
};

const adminOrderStatusFilterGroups = [
  { label: "待處理", options: [["seller_pending", "賣貨便待核對"], ["pending_payment", "待付款"], ["pending_review", "待確認款項"]] },
  { label: "處理中", options: [["confirmed", "已確認款項（依配送狀態）"], ["ready_for_pickup", "配送處理中（到貨／出貨／待尾款）"]] },
  { label: "結案／退款", options: [["completed", "已完成訂單"], ["cancelled", "已取消"], ["refund_pending", "退款處理中"], ["refunded", "已退款"]] }
];

export function renderAdminOrderStatusFilter() {
  const select = document.querySelector("#admin-order-status-filter");
  if (!select) return;
  const orders = Array.isArray(adminData?.orders) ? adminData.orders : [];
  const counts = Object.fromEntries(adminOrderStatusFilterGroups.flatMap((group) => group.options).map(([value]) => [value, 0]));
  orders.forEach((order) => {
    if (Object.prototype.hasOwnProperty.call(counts, order.status)) counts[order.status] += 1;
    if (order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id) counts.seller_pending += 1;
  });
  const previous = select.value;
  const countLabel = (value) => counts[value] ? `（${counts[value]}）` : "";
  select.innerHTML = `<option value="all">全部訂單${orders.length ? `（${orders.length}）` : ""}</option>` + adminOrderStatusFilterGroups.map((group) => `<optgroup label="${group.label}">${group.options.map(([value, label]) => `<option value="${value}">${label}${countLabel(value)}</option>`).join("")}</optgroup>`).join("");
  const available = new Set(["all", ...adminOrderStatusFilterGroups.flatMap((group) => group.options.map(([value]) => value))]);
  select.value = available.has(previous) ? previous : "all";
}

function adminOrderHistory(orderId) {
  return (adminData.orderHistory || []).filter((entry) => entry.order_id === orderId);
}

function adminReturnConfirmation(orderItemId) {
  return (adminData.returns || []).find((entry) => entry.order_item_id === orderItemId);
}

function renderAdminReturnPanel(order) {
  if (order.status !== "refunded") return "";
  const items = (order.order_items || []).filter((item) => item.id);
  if (!items.length) return "";
  const rows = items.map((item) => {
    const confirmation = adminReturnConfirmation(item.id);
    const itemLabel = `${item.product_name || "商品"}${item.variant_name && item.variant_name !== "單一規格" ? ` · ${item.variant_name}` : ""}`;
    if (confirmation) {
      return `<div class="admin-return-confirmed"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><small>已驗收 ${confirmation.received_quantity} 件：可再售 ${confirmation.restock_quantity} 件、報廢 ${confirmation.scrap_quantity} 件 · ${formatDateTime(confirmation.created_at)}</small>${confirmation.note ? `<small>備註：${escapeHtml(confirmation.note)}</small>` : ""}</div>`;
    }
    return `<form class="admin-return-form" data-admin-return-form="${escapeHtml(item.id)}" data-return-max="${Number(item.quantity) || 0}"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><p class="admin-order-note">收到退貨後才填寫。可再售數量才會回補庫存，報廢數量只留下稽核紀錄。</p><div class="form-grid"><label>收到數量<input name="received_quantity" type="number" min="1" max="${Number(item.quantity) || 0}" required /></label><label>可再售回補<input name="restock_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label>報廢數量<input name="scrap_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label class="wide">驗收備註<textarea name="note" rows="2" maxlength="1000" placeholder="例如：外盒損傷、配件缺少"></textarea></label></div><button class="secondary-button" type="submit">確認退貨驗收</button></form>`;
  }).join("");
  return `<section class="admin-return-panel"><h4>退貨驗收</h4><p class="admin-order-note">已退款訂單不會自動回補；逐項確認實際收到數量，再分為可再售或報廢。</p>${rows}</section>`;
}

function adminDiscountLabel(value) {
  const amount = Math.max(0, Number(value || 0));
  return amount > 0 ? `-${money(amount)}` : "未使用";
}

export function renderAdminOrders() {
  const container = document.querySelector("#admin-order-list");
  const keyword = document.querySelector("#admin-order-search").value.trim().toLowerCase();
  const status = document.querySelector("#admin-order-status-filter").value;
  const orders = (adminData.orders || []).filter((order) => {
    const member = relationOne(order.profiles);
    const searchable = `${order.order_number} ${member?.full_name || ""} ${member?.phone || ""} ${order.payment_last_five || ""}`.toLowerCase();
    const isSellerPending = order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const matchesStatus = status === "all" || (status === "seller_pending" ? isSellerPending : order.status === status);
    return matchesStatus && searchable.includes(keyword);
  }).sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的訂單。</div>';
    renderAdminPagination("orders");
    return;
  }
  container.innerHTML = orders.map((order) => {
    const member = relationOne(order.profiles);
    const account = relationOne(order.bank_accounts);
    const items = (order.order_items || []).map((item) => `<div><span>${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}</span><strong>${money(item.unit_price * item.quantity)}</strong></div>`).join("");
    const hasPreorder = orderIncludesPreorder(order);
    const preorderStorePickup = order.delivery_method === "store_pickup" && hasPreorder;
    const transitions = (adminOrderTransitions[order.status] || []).filter((item) =>
      (!item.splitOnly || order.pickup_plan === "split")
      && (!item.storePaymentOnly || !order.bank_account_id)
      && (item.value !== "partially_ready" || preorderStorePickup)
      && (item.value !== "ready_for_pickup" || preorderStorePickup || order.delivery_method === "seller_delivery" || (order.delivery_method === "home_delivery" && hasPreorder))
      && !(item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder)
      && !(item.value === "cancelled" && order.delivery_method === "seller_delivery" && order.status === "ready_for_pickup")
      && (item.value !== "completed" || order.delivery_method !== "home_delivery" || Boolean(order.final_payment_confirmed_at))
    );
    const options = transitions.map((item) => {
      const label = item.value === "confirmed" && order.delivery_method === "seller_delivery" && !order.bank_account_id
        ? "確認賣貨便訂單並扣除庫存"
        : item.value === "confirmed" && order.delivery_method === "seller_delivery"
          ? "確認預購訂金並扣除庫存"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder
          ? "確認已出貨並通知會員"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && hasPreorder
          ? "商品已到貨，通知會員開賣貨便"
        : item.value === "ready_for_pickup" && order.delivery_method === "home_delivery" && hasPreorder
          ? "預購商品已到貨，通知會員確認尾款／運費"
        : item.value === "ready_for_pickup" && preorderStorePickup
          ? "通知會員可到店取貨"
        : item.value === "completed" && order.delivery_method === "seller_delivery"
          ? "確認已出貨、通知會員並完成訂單"
        : item.value === "completed" && order.delivery_method === "home_delivery"
          ? "確認寄送完成並結束訂單"
        : item.label;
      return `<option value="${item.value}">${escapeHtml(label)}</option>`;
    }).join("");
    const history = adminOrderHistory(order.id).slice(0, 5).map((entry) => { const actor = relationOne(entry.profiles); return `<li><span>${escapeHtml(adminOrderStatusLabel(order, entry.from_status))} → ${escapeHtml(adminOrderStatusLabel(order, entry.to_status))}</span><small>${formatDateTime(entry.created_at)}${actor?.full_name ? ` · ${escapeHtml(actor.full_name)}` : ""}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small></li>`; }).join("");
    const balance = Math.max(order.amount_due - order.paid_amount, 0);
    const couponDiscount = Number(order.coupon_discount || 0);
    const pointDiscount = Number(order.point_discount || 0);
    const deliveryLabel = deliveryMethodLabels[order.delivery_method || "store_pickup"] || "到店取貨";
    const orderDeliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryLabel}`;
    const shippingInfo = order.delivery_method === "home_delivery" ? `<p class="admin-order-note">收件人：${escapeHtml(order.shipping_recipient_name || "未填寫")}<br />電話：${escapeHtml(order.shipping_phone || "未填寫")}<br />地址：${escapeHtml(order.shipping_address || "未填寫")}</p>` : "";
    return `<article class="admin-order-card"><header><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(orderDeliveryLabel)}${order.confirmed_at || order.payment_confirmed_at ? ` · 確認：${formatDateTime(order.confirmed_at || order.payment_confirmed_at)}` : ""}</small></div><span class="status-chip status-${order.status}">${escapeHtml(adminOrderStatusLabel(order))}</span></header><div class="admin-order-member"><strong>${escapeHtml(member?.full_name || "未填姓名")}</strong><span>${escapeHtml(member?.phone || "未填手機")}</span></div><div class="admin-order-items">${items}</div><div class="admin-order-payment"><span class="admin-order-total">總額 <b>${money(order.amount_due)}</b></span><span class="admin-order-payment-method">運費 <b>${order.shipping_fee ? money(order.shipping_fee) : "免運"}</b></span><span class="admin-order-deposit">訂金應付 <b>${money(order.deposit_due)}</b></span><span class="admin-order-paid">已確認 <b>${money(order.paid_amount || 0)}</b></span><span class="admin-order-balance">待收尾款 <b>${money(balance)}</b></span><span class="admin-order-discount admin-order-coupon">優惠券折抵 <b>${adminDiscountLabel(couponDiscount)}</b></span><span class="admin-order-discount admin-order-points">點數折抵 <b>${adminDiscountLabel(pointDiscount)}</b></span></div>${shippingInfo}<div class="admin-order-bank"><span>${escapeHtml(account?.label || account?.bank_name || "未指定帳戶")}</span><span>匯款末五碼：<b>${escapeHtml(order.payment_last_five || "尚未回報")}</b></span></div>${order.admin_note ? `<p class="admin-order-note">目前備註：${escapeHtml(order.admin_note)}</p>` : ""}${transitions.length ? `<form class="admin-order-action" data-admin-order-form="${order.id}"><label>下一步<select name="target_status">${options}</select></label><label>管理備註<textarea name="note" rows="2" maxlength="1000" placeholder="取消與退款相關操作必填；其他操作可選填"></textarea></label><button class="primary-button" type="submit">更新訂單</button></form>` : '<p class="admin-order-terminal">此訂單目前沒有可執行的下一步。</p>'}${renderAdminReturnPanel(order)}<details class="admin-order-history"><summary>狀態紀錄（${adminOrderHistory(order.id).length}）</summary>${history ? `<ol>${history}</ol>` : '<p>尚無管理異動紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("orders");
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const paymentNode = card.querySelector(".admin-order-payment-method");
    const order = orders[index];
    if (!paymentNode || !order) return;
    const hasPreorder = orderIncludesPreorder(order);
    paymentNode.innerHTML = `付款方式 <b>${order.bank_account_id ? "匯款／轉帳" : order.delivery_method === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付"}</b>`;
    const paymentGrid = card.querySelector(".admin-order-payment");
    const shippingFeeLabel = order.delivery_method === "store_pickup" ? "免運" : order.delivery_method === "seller_delivery" ? "由 7-11 收取" : order.shipping_fee ? money(order.shipping_fee) : "待客服通知";
    const balanceLabel = order.delivery_method === "store_pickup" ? "到店確認" : order.delivery_method === "seller_delivery" ? "依賣貨便訂單" : order.final_payment_confirmed_at ? "已確認" : "尚未確認";
    if (paymentGrid) paymentGrid.insertAdjacentHTML("beforeend", `<span>${order.delivery_method === "seller_delivery" ? "賣貨便運費" : "實際運費"} <b>${shippingFeeLabel}</b></span><span>尾款／運費 <b>${balanceLabel}</b></span>`);
    if (order.delivery_method === "home_delivery") {
      const currentStockHomePending = order.delivery_method === "home_delivery" && !hasPreorder && order.status === "pending_review";
      const canUpdateFulfillment = currentStockHomePending || ["partially_ready", "ready_for_pickup"].includes(order.status);
      const terminalStatuses = ["completed", "cancelled", "refund_pending", "refunded"];
      const insertBefore = card.querySelector(".admin-order-action") || card.querySelector(".admin-order-history");
      if (canUpdateFulfillment) {
        const form = document.createElement("form");
        form.className = "admin-fulfillment-form";
        form.dataset.adminFulfillmentForm = order.id;
        const fulfillmentTiming = currentStockHomePending ? "待確認款項階段填寫" : hasPreorder ? "預購商品到貨後" : "現貨備貨完成後";
        const shippingFeeField = `<label>實際運費<input name="shipping_fee" type="number" min="0" step="1" value="${Number(order.shipping_fee || 0)}" required /><small>${fulfillmentTiming}填寫，會加入待收金額。</small></label>`;
        const finalPaymentLabel = currentStockHomePending ? "已確認全額與運費入帳" : "已確認尾款與運費入帳";
        const lastFiveLabel = currentStockHomePending ? "匯款末五碼" : "尾款匯款末五碼";
        const submitLabel = currentStockHomePending ? "儲存運費／匯款末五碼" : "儲存尾款／運費";
        const notePlaceholder = currentStockHomePending ? "例如：客服確認運費金額、匯款確認日期" : "例如：宅配箱型、客服通知日期";
        form.innerHTML = `<div class="form-grid"><div>${shippingFeeField}</div><label>${lastFiveLabel}<input name="final_payment_last_five" maxlength="5" inputmode="numeric" pattern="[0-9]{5}" value="${escapeHtml(order.final_payment_last_five || "")}" placeholder="付款後填寫" /></label><label class="check-field"><input name="final_payment_confirmed" type="checkbox" ${order.final_payment_confirmed_at ? "checked" : ""} /> ${finalPaymentLabel}</label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="${notePlaceholder}">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="secondary-button" type="submit">${submitLabel}</button>`;
        card.insertBefore(form, insertBefore);
      } else if (!terminalStatuses.includes(order.status)) {
        const prompt = document.createElement("p");
        prompt.className = "admin-order-terminal";
        prompt.textContent = order.status === "confirmed"
          ? hasPreorder
            ? "預購宅配：請等商品實際到貨後，更新為「預購商品已到貨」；之後即可填寫尾款與運費。"
            : "現貨宅配：請在待確認款項階段填寫實際運費與匯款末五碼，再確認款項並扣除庫存。"
          : "請先完成訂金／付款確認；宅配進入備貨或到貨狀態後，才能填寫尾款與運費。";
        card.insertBefore(prompt, insertBefore);
      }
    }
  });
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const order = orders[index];
    const sellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const preorderSellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && Boolean(order.bank_account_id);
    if (!sellerPending && !preorderSellerPending) return;
    if (preorderSellerPending) {
      card.classList.add("preorder-seller-pending");
      const statusChip = card.querySelector(".status-chip");
      if (statusChip) statusChip.textContent = "預購待付訂";
      if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：會員須於 2 小時內回報末五碼；確認後保留庫存，商品到貨再由客服開立賣貨便。</p>');
      return;
    }
    card.classList.add("seller-pending");
    const statusChip = card.querySelector(".status-chip");
    if (statusChip) {
      statusChip.textContent = "賣貨便待確認";
      statusChip.classList.add("status-seller-pending");
    }
    if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>請先核對賣貨便訂單</strong>：確認外部訂單內容後，再更新狀態並扣除庫存。</p>');
  });
  container.querySelectorAll("[data-admin-order-form]").forEach((form) => {
    const target = form.querySelector("select[name='target_status']");
    const button = form.querySelector("button[type='submit']");
    if (!(target instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) return;
    const syncRiskState = () => {
      const dangerous = ["cancelled", "refund_pending", "refunded"].includes(target.value);
      button.classList.toggle("danger-button", dangerous);
      button.textContent = dangerous ? "確認高風險操作" : "更新訂單";
      button.setAttribute("aria-label", dangerous ? "確認取消或退款等高風險操作" : "更新訂單");
    };
    target.addEventListener("change", syncRiskState);
    syncRiskState();
  });
}

export async function submitAdminOrderTransition(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("訂單表單資料無法讀取");
  const targetStatusField = form.querySelector("select[name='target_status']");
  const noteField = form.querySelector("textarea[name='note']");
  if (!(targetStatusField instanceof HTMLSelectElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("訂單表單欄位不完整");
  const targetStatus = targetStatusField.value;
  const note = noteField.value.trim();
  if (["cancelled", "refund_pending", "refunded"].includes(targetStatus) && !note) throw new Error("取消或退款相關操作必須填寫原因");
  const currentOrder = (adminData.orders || []).find((order) => order.id === form.dataset.adminOrderForm);
  const warning = targetStatus === "confirmed"
    ? "確認款項後會正式扣除商品庫存。"
    : targetStatus === "completed"
      ? "完成訂單代表商品已取走且尾款已收訖。"
      : targetStatus === "cancelled" && ["pending_payment", "pending_review"].includes(currentOrder?.status)
        ? "此訂單尚未扣除實體庫存；取消後會釋放保留量。"
      : targetStatus === "cancelled"
        ? "此訂單已扣除庫存且尚未完成交付；取消後會由系統反轉原銷售異動，不能再手動重複回補。"
      : ["refund_pending", "refunded"].includes(targetStatus)
        ? "退款流程不會自動回補庫存；收到實物後，請在已退款訂單逐項驗收並分為可再售或報廢。"
        : "";
  if (!(await adminConfirm({ title: "確定更新此訂單狀態？", message: warning, confirmLabel: "確定更新", danger: ["cancelled", "refund_pending", "refunded"].includes(targetStatus), trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminOrderForm}/transition`, { method: "POST", body: JSON.stringify({ target_status: targetStatus, note }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("訂單狀態已更新", "success");
    await loadProducts();
    renderProducts();
  } finally {
    button.disabled = false;
  }
}

export async function submitAdminOrderReturn(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("退貨驗收表單資料無法讀取");
  const receivedField = form.elements.namedItem("received_quantity");
  const restockField = form.elements.namedItem("restock_quantity");
  const scrapField = form.elements.namedItem("scrap_quantity");
  const noteField = form.elements.namedItem("note");
  if (!(receivedField instanceof HTMLInputElement) || !(restockField instanceof HTMLInputElement) || !(scrapField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("退貨驗收表單欄位不完整");
  const received = Number(receivedField.value);
  const restock = Number(restockField.value);
  const scrap = Number(scrapField.value);
  const max = Number(form.dataset.returnMax || 0);
  if (![received, restock, scrap].every(Number.isInteger) || received <= 0 || received > max || restock < 0 || scrap < 0 || restock + scrap !== received) throw new Error("收到、可再售與報廢數量必須正確相等，且不可超過原購買數量");
  if (!(await adminConfirm({ title: "確認退貨驗收？", message: `收到 ${received} 件，其中可再售 ${restock} 件、報廢 ${scrap} 件。`, confirmLabel: "確認驗收", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/order-items/${form.dataset.adminReturnForm}/return`, { method: "POST", body: JSON.stringify({ received_quantity: received, restock_quantity: restock, scrap_quantity: scrap, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("退貨驗收已記錄", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

export async function submitAdminOrderFulfillment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("尾款與運費表單資料無法讀取");
  const shippingField = form.elements.namedItem("shipping_fee");
  const finalFiveField = form.elements.namedItem("final_payment_last_five");
  const confirmedField = form.elements.namedItem("final_payment_confirmed");
  const noteField = form.elements.namedItem("note");
  if (!(shippingField instanceof HTMLInputElement) || !(finalFiveField instanceof HTMLInputElement) || !(confirmedField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("尾款與運費表單欄位不完整");
  const shippingFee = Number(shippingField.value);
  const finalFive = finalFiveField.value.trim();
  const confirmed = confirmedField.checked;
  if (!Number.isInteger(shippingFee) || shippingFee < 0) throw new Error("實際運費必須是 0 或正整數");
  if (confirmed && !/^\d{5}$/.test(finalFive)) throw new Error("請填寫 5 位數尾款匯款末五碼");
  if (confirmed && !(await adminConfirm({ title: "確認尾款與運費已入帳？", message: "確認後即可完成寄送訂單。", confirmLabel: "確認已入帳", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminFulfillmentForm}/fulfillment`, { method: "PATCH", body: JSON.stringify({ shipping_fee: shippingFee, final_payment_confirmed: confirmed, final_payment_last_five: finalFive || null, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders", "overview"]);
    switchAdminTab("orders");
    showToast("尾款與實際運費已更新", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}
