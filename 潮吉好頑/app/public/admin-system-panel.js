// 後台系統分頁：稽核紀錄、通知紀錄（失敗重排）與收款帳戶。
import { escapeHtml } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { formatDateTime, showToast } from "./app-core.js";
import { invalidateBankAccounts } from "./checkout-form.js";
import { adminData, adminFetch, loadAdminSection, refreshAdminSections, relationOne, switchAdminTab } from "./admin-app.js";
import { auditChanges, auditTargetName } from "./admin-audit-diff.js";

function auditMaskedValue(value) {
  const text = String(value ?? "");
  return text.length > 4 ? `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : "****";
}

function auditJsonSummary(value) {
  if (value == null) return "—";
  let text = "";
  try {
    text = JSON.stringify(value, (key, child) => /account_number|channel_access_token|bot_token|secret|password/i.test(key) ? auditMaskedValue(child) : child);
  } catch {
    text = String(value);
  }
  if (text.length > 320) text = `${text.slice(0, 317)}…`;
  return escapeHtml(text);
}

export function renderAdminAudit() {
  const container = document.querySelector("#admin-audit-list");
  if (!container) return;
  const actionLabels = { create: "新增", update: "更新", adjust: "調整", upload: "上傳", delete: "刪除" };
  const resourceLabels = { product: "商品", product_variant: "規格", category: "分類", bank_account: "收款帳戶", coupon: "優惠券", birthday_coupon_settings: "生日券設定", point_settings: "點數設定", member_points: "會員點數", product_image: "商品圖片" };
  const logs = Array.isArray(adminData?.auditLogs) ? adminData.auditLogs : [];
  // 稽核分頁不一定載入過商品；有商品資料時才補上規格所屬的商品名稱
  const productNames = new Map((adminData?.products || []).map((product) => [product.id, product.name]));
  const memberNames = new Map((adminData?.members || []).map((member) => [member.id, member.full_name || member.phone]));
  container.innerHTML = logs.length ? logs.map((entry) => {
    const actor = relationOne(entry.profiles);
    const changes = auditChanges(entry.before_data, entry.after_data);
    const changeList = changes.length
      ? `<ul class="audit-changes">${changes.map((change) => `<li><span>${escapeHtml(change.label)}</span>${entry.before_data ? `<del>${escapeHtml(change.before)}</del> → ` : ""}<ins>${escapeHtml(change.after)}</ins></li>`).join("")}</ul>`
      : '<p class="audit-changes-empty">沒有欄位變動</p>';
    return `<article class="admin-card audit-log-card"><div><strong>${escapeHtml(actionLabels[entry.action] || entry.action)} · ${escapeHtml(resourceLabels[entry.resource] || entry.resource)}</strong><small>${formatDateTime(entry.created_at)} · 操作人：${escapeHtml(actor?.full_name || entry.actor_id || "未知")}</small><small>目標：${escapeHtml(auditTargetName(entry, (id) => productNames.get(id) || "", (id) => memberNames.get(id) || ""))}</small>${changeList}<details class="audit-raw"><summary>原始資料</summary><small>前：<code>${auditJsonSummary(entry.before_data)}</code></small><small>後：<code>${auditJsonSummary(entry.after_data)}</code></small></details></div></article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的稽核紀錄。</div>';
}

function notificationStatusLabel(status) {
  return { pending: "待處理", processing: "發送中", sent: "已送出", failed: "失敗" }[status] || status || "未知";
}

export function renderAdminNotifications() {
  const container = document.querySelector("#admin-notification-list");
  if (!container) return;
  const channelLabels = { line: "LINE", telegram: "Telegram" };
  const logs = Array.isArray(adminData?.notificationDeliveries) ? adminData.notificationDeliveries : [];
  container.innerHTML = logs.length ? logs.map((entry) => {
    const failed = entry.status === "failed";
    const retryButton = failed ? `<button class="secondary-button" type="button" data-admin-notification-requeue="${escapeHtml(entry.channel)}:${escapeHtml(entry.id)}">重新排入</button>` : "";
    const retryAt = entry.next_retry_at ? `下次重試：${formatDateTime(entry.next_retry_at)}` : "無排程重試";
    const error = entry.error_message ? `錯誤：${escapeHtml(entry.error_message)}` : "無錯誤訊息";
    return `<article class="admin-card notification-delivery-card"><div><strong>${escapeHtml(channelLabels[entry.channel] || entry.channel)} · ${escapeHtml(notificationStatusLabel(entry.status))}</strong><small>${formatDateTime(entry.updated_at || entry.created_at)} · 事件 ${escapeHtml(entry.event_type || "—")}</small><small>收件人：${escapeHtml(entry.recipient_name || entry.recipient_hint || "已遮罩")} · 訂單：${escapeHtml(entry.order_number || "—")}</small><small>嘗試 ${Number(entry.attempt_count || 0)} 次 · ${escapeHtml(retryAt)}</small><small>${error}</small></div>${retryButton}</article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的通知紀錄。</div>';
}

export async function requeueAdminNotification(button) {
  const [channel, id] = String(button.dataset.adminNotificationRequeue || "").split(":");
  if (!["line", "telegram"].includes(channel) || !/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("通知紀錄資料不正確");
  if (!(await adminConfirm({ title: "重新排入這筆失敗通知？", message: "會在下一次排程重試時發送，現在不會立即發送。", confirmLabel: "重新排入", trigger: button }))) return;
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/notification-deliveries/${channel}/${id}/requeue`, { method: "POST", body: JSON.stringify({}) });
    await loadAdminSection("notifications", { force: true });
    showToast("通知已排入下一次重試", "success");
  } finally {
    button.disabled = false;
  }
}

export function renderAdminAccounts() {
  const container = document.querySelector("#admin-account-list");
  const accounts = adminData.accounts || [];
  container.innerHTML = accounts.length ? accounts.map((account) => `<div class="admin-card"><div><strong>${escapeHtml(account.label)} ${account.is_active ? "" : "（已停用）"}</strong><small>${escapeHtml(account.bank_name)} · ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></div><button type="button" data-account-edit="${account.id}">編輯</button></div>`).join("") : '<div class="empty-state">尚未設定收款帳戶；新增後前台才可建立訂單。</div>';
}

export function resetAccountForm() {
  document.querySelector("#admin-account-form").reset();
  document.querySelector("#admin-account-id").value = "";
  document.querySelector("#admin-account-order").value = "0";
  document.querySelector("#admin-account-active").checked = true;
  document.querySelector("[data-account-form-title]").textContent = "新增收款帳戶";
  document.querySelector("[data-account-cancel]").classList.add("hidden");
}

export function editAccount(accountId) {
  const account = (adminData.accounts || []).find((item) => item.id === accountId);
  if (!account) return;
  document.querySelector("#admin-account-id").value = account.id;
  document.querySelector("#admin-account-label").value = account.label;
  document.querySelector("#admin-bank-name").value = account.bank_name;
  document.querySelector("#admin-account-name").value = account.account_name;
  document.querySelector("#admin-account-number").value = account.account_number;
  document.querySelector("#admin-account-order").value = account.display_order;
  document.querySelector("#admin-account-active").checked = account.is_active;
  document.querySelector("[data-account-form-title]").textContent = "編輯收款帳戶";
  document.querySelector("[data-account-cancel]").classList.remove("hidden");
  document.querySelector("#admin-account-label").focus();
}

export async function submitAdminAccount(event) {
  event.preventDefault();
  const id = document.querySelector("#admin-account-id").value;
  const body = {
    label: document.querySelector("#admin-account-label").value,
    bank_name: document.querySelector("#admin-bank-name").value,
    account_name: document.querySelector("#admin-account-name").value,
    account_number: document.querySelector("#admin-account-number").value,
    display_order: Number(document.querySelector("#admin-account-order").value || 0),
    is_active: document.querySelector("#admin-account-active").checked
  };
  await adminFetch(id ? `/api/admin/bank-accounts/${id}` : "/api/admin/bank-accounts", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
  resetAccountForm();
  invalidateBankAccounts();
  await refreshAdminSections(["settings"]);
  switchAdminTab("accounts");
  showToast("收款帳戶已儲存", "success");
}
