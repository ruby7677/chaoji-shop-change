// 後台會員與行銷：會員列表與點數帳本、點數規則、會員點數調整、優惠券與生日券。
import { escapeHtml, money } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { formatDateTime, orderStatusLabel, showToast } from "./app-core.js";
import { products } from "./storefront-catalog.js";
import { adminData, adminFetch, localDateTime, refreshAdminSections, relationOne, renderAdminPagination, switchAdminTab } from "./admin-app.js";

export function ensureDiscountAdminUI() {
  if (!document.querySelector("[data-admin-tab='discounts']") || !document.querySelector("[data-admin-panel='discounts']")) return;
  resetCouponForm();
}

export function resetCouponForm() {
  document.querySelector("#admin-coupon-form").reset();
  document.querySelector("#coupon-id").value = "";
  document.querySelector("#coupon-active").checked = true;
  document.querySelector("#coupon-member-limit").value = "1";
  document.querySelector("#coupon-valid-from").value = localDateTime();
  document.querySelector("#coupon-valid-until").value = localDateTime(Date.now() + 30 * 86400000);
}

export function renderAdminDiscounts() {
  renderAdminDiscountOptionBoxes({ preserveSelection: true });
  const birthday = adminData.birthdaySettings;
  if (birthday) {
    document.querySelector("#birthday-amount").value = birthday.discount_amount;
    document.querySelector("#birthday-before").value = birthday.issue_days_before;
    document.querySelector("#birthday-valid-days").value = birthday.valid_days;
    document.querySelector("#birthday-combinable").checked = birthday.combinable_with_points;
    document.querySelector("#birthday-enabled").checked = birthday.enabled;
  }
  const list = document.querySelector("#admin-coupon-list");
  list.innerHTML = (adminData.coupons || []).map((coupon) => `<div class="admin-card coupon-card"><div><strong>${escapeHtml(coupon.code)} · ${escapeHtml(coupon.name)}</strong><small>折 ${money(coupon.discount_amount)} · ${coupon.combinable_with_points ? "可" : "不可"}與點數併用 · 已用 ${(coupon.coupon_redemptions || []).length}${coupon.total_usage_limit ? `/${coupon.total_usage_limit}` : ""} · ${coupon.is_active ? "啟用" : "停用"}<br />${new Date(coupon.valid_from).toLocaleString("zh-TW")} 至 ${new Date(coupon.valid_until).toLocaleString("zh-TW")}${coupon.is_birthday ? " · 生日券" : ""}</small></div>${coupon.is_birthday ? "" : `<button type="button" data-coupon-edit="${coupon.id}">編輯</button>`}</div>`).join("") || '<div class="empty-state">尚未建立優惠券。</div>';
}

export function renderAdminDiscountOptionBoxes({ preserveSelection = false } = {}) {
  const productBox = document.querySelector("#coupon-product-options");
  const memberBox = document.querySelector("#coupon-member-options");
  const products = adminData.discountProducts || adminData.products || [];
  const members = adminData.discountMembers || adminData.members || [];
  const checkedProducts = preserveSelection ? new Set([...productBox.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value)) : new Set();
  const checkedMembers = preserveSelection ? new Set([...memberBox.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)) : new Set();
  productBox.innerHTML = products.map((product) => `<label><input type="checkbox" name="coupon_product" value="${escapeHtml(product.id)}" ${checkedProducts.has(product.id) ? "checked" : ""} /> ${escapeHtml(product.name)}</label>`).join("") || "<small>尚無商品</small>";
  memberBox.innerHTML = members.map((member) => `<label><input type="checkbox" name="coupon_member" value="${escapeHtml(member.id)}" ${checkedMembers.has(member.id) ? "checked" : ""} /> ${escapeHtml(member.full_name || member.phone || "未命名會員")}</label>`).join("") || "<small>尚無會員</small>";
}

function renderPointSettings() {
  const settings = adminData.pointSettings;
  if (!settings) return;
  document.querySelector("#point-earn-amount").value = settings.earn_amount_per_point;
  document.querySelector("#point-value").value = settings.point_value;
  document.querySelector("#point-min-redeem").value = settings.min_redeem_points;
  document.querySelector("#point-max-mode").value = settings.max_redeem_mode;
  document.querySelector("#point-max-value").value = settings.max_redeem_value;
  syncPointMaxHint();
}

function memberPointEntries(memberId) {
  return (adminData.pointEntries || []).filter((entry) => entry.member_id === memberId);
}

export function renderAdminMembers() {
  renderPointSettings();
  const container = document.querySelector("#admin-member-list");
  const keyword = document.querySelector("#admin-member-search").value.trim().toLowerCase();
  const members = (adminData.members || []).filter((member) => `${member.full_name || ""} ${member.phone || ""}`.toLowerCase().includes(keyword));
  if (!members.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的會員。</div>';
    renderAdminPagination("members");
    return;
  }
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  container.innerHTML = members.map((member) => {
    const entries = memberPointEntries(member.id).slice(0, 8);
    const history = entries.map((entry) => { const order = relationOne(entry.orders); const actor = relationOne(entry.actor); return `<li><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)}${order?.order_number ? ` · ${escapeHtml(order.order_number)}` : ""}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong><small>${formatDateTime(entry.created_at)} · ${escapeHtml(entry.reason)}${actor?.full_name ? ` · 操作：${escapeHtml(actor.full_name)}` : ""}</small></li>`; }).join("");
    const memberOrders = (adminData.orders || []).filter((order) => order.member_id === member.id).slice(0, 8);
    const orderHistory = memberOrders.map((order) => `<li><span>${escapeHtml(order.order_number)} · ${escapeHtml(orderStatusLabel(order))}</span><strong>${money(order.amount_due)}</strong><small>${formatDateTime(order.created_at)} · ${order.delivery_method === "store_pickup" ? "到店取貨" : order.delivery_method === "seller_delivery" ? "賣貨便" : "宅配"}</small></li>`).join("");
    return `<article class="admin-member-card"><header><div><h3>${escapeHtml(member.full_name || "尚未填寫姓名")}${member.is_admin ? " · 管理員" : ""}</h3><small>${escapeHtml(member.phone || "尚未填寫手機")} · 加入於 ${formatDateTime(member.created_at)}</small></div><div class="member-metrics"><span>點數<b>${member.point_balance}</b></span><span>累積消費<b>${money(member.lifetime_spend)}</b></span><span>訂單<b>${member.order_count}</b></span></div></header><div class="member-extra"><span>生日：${escapeHtml(member.birthday || "未填")}</span><span>地址：${escapeHtml(member.address || "未填")}</span></div><form class="admin-point-adjust" data-admin-points-form="${member.id}"><label>異動點數<input name="points" required type="number" step="1" placeholder="增加填正數、扣除填負數" /></label><label>原因<input name="reason" required maxlength="200" placeholder="例如：活動贈點、人工更正" /></label><button class="secondary-button" type="submit">調整點數</button></form><details class="admin-order-history"><summary>消費紀錄（${member.order_count || 0}）</summary>${orderHistory ? `<ol class="member-ledger">${orderHistory}</ol>` : '<p>尚無消費紀錄。</p>'}</details><details class="admin-order-history"><summary>點數紀錄（${memberPointEntries(member.id).length}）</summary>${history ? `<ol class="member-ledger">${history}</ol>` : '<p>尚無點數紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("members");
}

export function syncPointMaxHint() {
  const mode = document.querySelector("#point-max-mode").value;
  const input = document.querySelector("#point-max-value");
  input.max = mode === "percent" ? "100" : "";
  document.querySelector("#point-max-hint").textContent = mode === "percent" ? "百分比請填 0–100" : "固定折抵金額（元）";
}

export async function submitPointSettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/point-settings", { method: "PUT", body: JSON.stringify({
    earn_amount_per_point: Number(document.querySelector("#point-earn-amount").value),
    point_value: Number(document.querySelector("#point-value").value),
    min_redeem_points: Number(document.querySelector("#point-min-redeem").value),
    max_redeem_mode: document.querySelector("#point-max-mode").value,
    max_redeem_value: Number(document.querySelector("#point-max-value").value)
  }) });
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("點數規則已儲存", "success");
}

export function editCoupon(couponId) {
  const coupon = (adminData.coupons || []).find((item) => item.id === couponId);
  if (!coupon) return;
  document.querySelector("#coupon-id").value = coupon.id;
  document.querySelector("#coupon-code").value = coupon.code;
  document.querySelector("#coupon-name").value = coupon.name;
  document.querySelector("#coupon-amount").value = coupon.discount_amount;
  document.querySelector("#coupon-member-limit").value = coupon.per_member_limit;
  document.querySelector("#coupon-valid-from").value = localDateTime(coupon.valid_from);
  document.querySelector("#coupon-valid-until").value = localDateTime(coupon.valid_until);
  document.querySelector("#coupon-total-limit").value = coupon.total_usage_limit || "";
  document.querySelector("#coupon-combinable").checked = coupon.combinable_with_points;
  document.querySelector("#coupon-active").checked = coupon.is_active;
  const productIds = new Set((coupon.coupon_products || []).map((item) => item.product_id));
  const memberIds = new Set((coupon.coupon_members || []).map((item) => item.member_id));
  document.querySelectorAll("[name='coupon_product']").forEach((input) => { input.checked = productIds.has(input.value); });
  document.querySelectorAll("[name='coupon_member']").forEach((input) => { input.checked = memberIds.has(input.value); });
  // 表單在滑出面板內時由 admin-sheets.js 開啟並捲回頂端；對 fixed 面板呼叫 scrollIntoView 會讓 iOS Safari 捲動整頁、點擊錯位
  const couponForm = document.querySelector("#admin-coupon-form");
  if (!couponForm.closest(".admin-sheet-panel")) couponForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

export async function submitCoupon(event) {
  event.preventDefault();
  const id = document.querySelector("#coupon-id").value;
  const totalLimit = document.querySelector("#coupon-total-limit").value;
  const body = {
    code: document.querySelector("#coupon-code").value.toUpperCase(), name: document.querySelector("#coupon-name").value,
    discount_amount: Number(document.querySelector("#coupon-amount").value), per_member_limit: Number(document.querySelector("#coupon-member-limit").value),
    valid_from: new Date(document.querySelector("#coupon-valid-from").value).toISOString(), valid_until: new Date(document.querySelector("#coupon-valid-until").value).toISOString(),
    total_usage_limit: totalLimit ? Number(totalLimit) : null, combinable_with_points: document.querySelector("#coupon-combinable").checked,
    is_active: document.querySelector("#coupon-active").checked,
    product_ids: [...document.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value),
    member_ids: [...document.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)
  };
  await adminFetch(id ? `/api/admin/coupons/${id}` : "/api/admin/coupons", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
  await refreshAdminSections(["discounts"]); resetCouponForm(); switchAdminTab("discounts"); showToast("優惠券已儲存", "success");
}

export async function submitBirthdaySettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/birthday-coupon-settings", { method: "PUT", body: JSON.stringify({ enabled: document.querySelector("#birthday-enabled").checked, discount_amount: Number(document.querySelector("#birthday-amount").value), issue_days_before: Number(document.querySelector("#birthday-before").value), valid_days: Number(document.querySelector("#birthday-valid-days").value), combinable_with_points: document.querySelector("#birthday-combinable").checked }) });
  await refreshAdminSections(["discounts"]); switchAdminTab("discounts"); showToast("生日券規則已儲存", "success");
}

export async function issueBirthdayCouponsNow() {
  if (!(await adminConfirm({ title: "立即執行生日券發送？", message: "已發送過的會員不會重複取得。", confirmLabel: "立即發送" }))) return;
  const result = await adminFetch("/api/admin/birthday-coupons/issue", { method: "POST" });
  await refreshAdminSections(["discounts"]);
  switchAdminTab("discounts");
  showToast(`生日券發送完成（新增 ${result.issued || 0} 張）`, "success");
}

export async function submitMemberPointAdjustment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("會員點數表單資料無法讀取");
  const pointsField = form.querySelector("[name='points']");
  const reasonField = form.querySelector("[name='reason']");
  if (!(pointsField instanceof HTMLInputElement) || !(reasonField instanceof HTMLInputElement)) throw new Error("會員點數表單欄位不完整");
  const points = Number(pointsField.value);
  const reason = reasonField.value.trim();
  if (!Number.isInteger(points) || points === 0 || !reason) throw new Error("請填寫非 0 點數與異動原因");
  if (!(await adminConfirm({ title: `確定要${points > 0 ? "增加" : "扣除"} ${Math.abs(points)} 點？`, message: `異動原因：${reason}`, confirmLabel: points > 0 ? "確定增加" : "確定扣除", danger: points < 0, trigger: event.submitter }))) return;
  await adminFetch(`/api/admin/members/${form.dataset.adminPointsForm}/points`, { method: "POST", body: JSON.stringify({ points, reason }) });
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("會員點數已調整", "success");
}
