// 後台會員儲值金：會員卡內的餘額、加值／退款／調整表單與紀錄（含沖正）。
// 每次送出帶 requestId，網路逾時後重送同一筆不會重複入帳；成功後才換新的 requestId。
import { escapeHtml, money } from "./product-format.js";
import { adminConfirm } from "./admin-confirm.js";
import { formatDateTime, showToast } from "./app-core.js";
import { adminData, adminFetch, refreshAdminSections, relationOne, switchAdminTab } from "./admin-app.js";

const WALLET_KIND_LABELS = { topup: "儲值加值", adjust: "人工調整", refund: "退款", reversal: "沖正", draw: "抽獎扣款", shipping: "獎品運費" };
const REVERSIBLE_KINDS = new Set(["topup", "adjust", "refund"]);
const WALLET_HISTORY_LIMIT = 10;

function newRequestId() {
  return crypto.randomUUID();
}

function walletBalance(memberId) {
  return (adminData.walletAccounts || []).find((account) => account.member_id === memberId)?.balance || 0;
}

function walletEntries(memberId) {
  return (adminData.walletEntries || []).filter((entry) => entry.member_id === memberId);
}

function signedMoney(amount) {
  return `${amount > 0 ? "+" : "-"}${money(Math.abs(amount))}`;
}

function walletEntryItem(entry, reversedIds) {
  const actor = relationOne(entry.actor);
  const reversed = reversedIds.has(entry.id);
  // 沖正原因用就地表單輸入：window.prompt 在部分內嵌 WebView 會被略過（同 admin-confirm.js）
  const reverseForm = REVERSIBLE_KINDS.has(entry.kind) && !reversed
    ? `<details class="admin-wallet-reverse"><summary>沖正</summary><form class="admin-point-adjust" data-admin-wallet-reverse-form="${escapeHtml(entry.id)}" data-amount="${entry.amount}" data-request-id="${newRequestId()}"><label>沖正原因（會員看得到）<input name="reason" required maxlength="200" placeholder="例：重複加值" /></label><button class="secondary-button" type="submit">確認沖正</button></form></details>`
    : "";
  const details = [
    formatDateTime(entry.created_at),
    escapeHtml(entry.reason),
    entry.transfer_ref ? `匯款：${escapeHtml(entry.transfer_ref)}` : "",
    actor?.full_name ? `操作：${escapeHtml(actor.full_name)}` : "",
    `餘額 ${money(entry.balance_after)}`,
    reversed ? "已沖正" : ""
  ].filter(Boolean).join(" · ");
  return `<li><span>${escapeHtml(WALLET_KIND_LABELS[entry.kind] || entry.kind)}</span><strong class="${entry.amount > 0 ? "movement-positive" : "movement-negative"}">${signedMoney(entry.amount)}</strong><small>${details}</small>${reverseForm}</li>`;
}

// 會員卡內的儲值金區塊（餘額、異動表單與最近紀錄）。
export function memberWalletSection(member) {
  const entries = walletEntries(member.id);
  const reversedIds = new Set(entries.map((entry) => entry.reversal_of).filter(Boolean));
  const history = entries.slice(0, WALLET_HISTORY_LIMIT).map((entry) => walletEntryItem(entry, reversedIds)).join("");
  const form = `<form class="admin-point-adjust admin-wallet-form" data-admin-wallet-form="${escapeHtml(member.id)}" data-request-id="${newRequestId()}">`
    + `<label>異動類型<select name="kind" required><option value="topup">加值（確認匯款入帳）</option><option value="refund">退款（從餘額扣除）</option><option value="adjust">調整（正數增加、負數扣除）</option></select></label>`
    + `<label>金額（元）<input name="amount" required type="number" step="1" inputmode="numeric" placeholder="加值與退款填正數" /></label>`
    + `<label>原因（會員看得到）<input name="reason" required maxlength="200" placeholder="例：10/12 匯款儲值" /></label>`
    + `<label>匯款參照（選填）<input name="transfer_ref" maxlength="60" placeholder="例：末五碼 12345" /></label>`
    + `<button class="secondary-button" type="submit">確認異動</button></form>`;
  return `<details class="admin-order-history admin-point-adjust-toggle"><summary>儲值金（餘額 ${money(walletBalance(member.id))}）</summary>${form}${history ? `<ol class="member-ledger">${history}</ol>` : "<p>尚無儲值金紀錄。</p>"}</details>`;
}

export function memberWalletBalance(memberId) {
  return walletBalance(memberId);
}

function walletAmountFromForm(kind, rawValue) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value === 0) return null;
  if (kind === "adjust") return value;
  // 加值與退款一律填正數，送出時依類型決定正負號
  if (value < 0) return null;
  return kind === "refund" ? -value : value;
}

export async function submitMemberWalletAdjustment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("儲值金表單資料無法讀取");
  const kind = form.elements.kind?.value || "";
  const amount = walletAmountFromForm(kind, form.elements.amount?.value);
  const reason = (form.elements.reason?.value || "").trim();
  const transferRef = (form.elements.transfer_ref?.value || "").trim();
  if (!WALLET_KIND_LABELS[kind] || !REVERSIBLE_KINDS.has(kind)) throw Object.assign(new Error("請選擇異動類型"), { field: "kind" });
  if (amount === null) throw Object.assign(new Error(kind === "adjust" ? "請填寫非 0 的整數金額" : "加值與退款請填正整數金額"), { field: "amount" });
  if (!reason) throw Object.assign(new Error("請填寫異動原因"), { field: "reason" });
  const memberId = form.dataset.adminWalletForm;
  const title = kind === "topup" ? `確定為會員加值 ${money(amount)}？` : kind === "refund" ? `確定從會員儲值金退款 ${money(-amount)}？` : `確定${amount > 0 ? "增加" : "扣除"}會員儲值金 ${money(Math.abs(amount))}？`;
  const message = `目前餘額 ${money(walletBalance(memberId))}，異動後 ${money(walletBalance(memberId) + amount)}。原因：${reason}`;
  if (!(await adminConfirm({ title, message, confirmLabel: "確定異動", danger: amount < 0, trigger: event.submitter }))) return;
  const submitButton = form.querySelector("[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    const result = await adminFetch(`/api/admin/members/${memberId}/wallet`, {
      method: "POST",
      body: JSON.stringify({ kind, amount, reason, requestId: form.dataset.requestId, transferRef: transferRef || null })
    });
    form.dataset.requestId = newRequestId();
    await refreshAdminSections(["members"]);
    switchAdminTab("members");
    showToast(result.replayed ? "這筆異動先前已完成，未重複入帳" : `儲值金已更新，目前餘額 ${money(result.balance)}`, "success");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

export async function submitMemberWalletReversal(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("沖正表單資料無法讀取");
  const entryId = form.dataset.adminWalletReverseForm || "";
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) throw new Error("儲值金紀錄資料不正確");
  const amount = Number(form.dataset.amount);
  const reason = (form.elements.reason?.value || "").trim();
  if (!reason) throw Object.assign(new Error("請填寫沖正原因"), { field: "reason" });
  if (!(await adminConfirm({ title: `確定沖正 ${signedMoney(amount)}？`, message: `會新增一筆 ${signedMoney(-amount)} 的沖正紀錄，原紀錄保留。原因：${reason}`, confirmLabel: "確定沖正", danger: amount > 0, trigger: event.submitter }))) return;
  const submitButton = form.querySelector("[type='submit']");
  if (submitButton) submitButton.disabled = true;
  try {
    const result = await adminFetch(`/api/admin/wallet-entries/${entryId}/reverse`, { method: "POST", body: JSON.stringify({ reason, requestId: form.dataset.requestId }) });
    await refreshAdminSections(["members"]);
    switchAdminTab("members");
    showToast(`已沖正，目前餘額 ${money(result.balance)}`, "success");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}
