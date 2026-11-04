// 會員點數與優惠券資料、LINE 好友狀態檢查（結帳前需加入官方帳號）。
import { liffState, canRequestLineFriendship, requestLineFriendship } from "./liff-auth.js";
import { escapeHtml, money } from "./product-format.js";
import { auth, closeDialog, formatDate, showDialog } from "./app-core.js";
import { resetMemberCartSyncState } from "./cart.js";
import { activeCheckoutScope, openCheckout } from "./checkout-flow.js";
import { liffSessionMatches } from "./liff-session.js";
import { handleSessionExpired } from "./auth-expiry.js";
import { FRIENDSHIP_LINE_RELOGIN, FRIENDSHIP_SESSION_EXPIRED, lineFriendshipFailureKind } from "./line-friendship-failure.js";

const MEMBER_POINTS_TTL_MS = 12 * 60 * 1000;
const LINE_FRIENDSHIP_TTL_MS = 15 * 60 * 1000;

export let memberPointsCache = { userId: null, value: null, expiresAt: 0 };
let memberPointsInFlight = null;
export let lineFriendshipCache = { userId: null, value: null, expiresAt: 0 };
let lineFriendshipInFlight = null;

export function clearMemberStateCache() {
  memberPointsCache = { userId: null, value: null, expiresAt: 0 };
  memberPointsInFlight = null;
  lineFriendshipCache = { userId: null, value: null, expiresAt: 0 };
  lineFriendshipInFlight = null;
  auth.points = null;
  auth.lineFriendFlag = null;
  resetMemberCartSyncState();
  renderMemberPoints();
}

export async function loadPoints({ force = false } = {}) {
  const userId = auth.user?.id;
  const accessToken = auth.accessToken;
  if (!userId || !accessToken) return null;
  if (!force && memberPointsCache.userId === userId && memberPointsCache.expiresAt > Date.now() && memberPointsCache.value) {
    auth.points = memberPointsCache.value;
    renderMemberPoints();
    return auth.points;
  }
  if (memberPointsInFlight?.userId === userId && memberPointsInFlight?.accessToken === accessToken) return memberPointsInFlight.promise;
  const promise = (async () => {
    const response = await fetch("/api/member/points", { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "點數資料讀取失敗");
    // A response from a previous session must not populate the current
    // member's cache after logout or a subsequent LINE Login callback.
    if (auth.user?.id === userId && auth.accessToken === accessToken) {
      memberPointsCache = { userId, value: result, expiresAt: Date.now() + MEMBER_POINTS_TTL_MS };
      auth.points = result;
      renderMemberPoints();
    }
    return result;
  })();
  memberPointsInFlight = { userId, accessToken, promise };
  try {
    return await promise;
  } finally {
    if (memberPointsInFlight?.promise === promise) memberPointsInFlight = null;
  }
}

export function renderMemberPoints() {
  const summary = document.querySelector("#member-points-summary");
  if (!auth.points) return summary.classList.add("hidden");
  summary.classList.remove("hidden");
  document.querySelector("[data-member-point-balance]").textContent = `${auth.points.balance || 0} 點`;
  const settings = auth.points.settings;
  document.querySelector("[data-member-point-rule]").textContent = settings
    ? `每消費 ${money(settings.earn_amount_per_point)} 累積 1 點；每點可折抵 ${money(settings.point_value)}，點數永不到期。`
    : "完成訂單後累積點數，點數永不到期。";
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  const entries = (auth.points.ledger || []).slice(0, 10);
  document.querySelector("#member-point-history").innerHTML = entries.length
    ? entries.map((entry) => `<div class="member-point-entry"><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)} · ${escapeHtml(entry.reason)}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong></div>`).join("")
    : '<p class="dialog-copy">目前沒有點數紀錄。</p>';
  let couponList = document.querySelector("#member-coupon-list");
  if (!couponList) {
    summary.insertAdjacentHTML("beforeend", '<details><summary>我的優惠券</summary><div id="member-coupon-list"></div></details>');
    couponList = document.querySelector("#member-coupon-list");
  }
  const coupons = auth.points.coupons || [];
  couponList.innerHTML = coupons.length ? coupons.map((coupon) => `<div class="member-point-entry"><span><b>${escapeHtml(coupon.code)}</b> · ${escapeHtml(coupon.name)}<br /><small>至 ${formatDate(coupon.valid_until)}</small></span><strong>-${money(coupon.discount_amount)}</strong></div>`).join("") : '<p class="dialog-copy">目前沒有已發送的優惠券。</p>';
}

const FRIEND_DIALOG_TITLE = "請先加入官方 LINE";
const FRIEND_DIALOG_COPY = "為了讓你收到訂單建立、付款確認、到貨與取貨通知，請先加入「潮吉好頑」官方 LINE。加入後按下重新檢查即可繼續結帳。";
const RELOGIN_DIALOG_TITLE = "請重新以 LINE 登入";
const RELOGIN_DIALOG_COPY = "登入狀態已過期，暫時無法確認官方 LINE 好友狀態。重新以 LINE 登入後會回到原本的頁面，再繼續結帳。";

// 同一個對話框有兩種用途：加好友（預設）與重新 LINE 登入；切換標題、說明與按鈕
function setLineFriendDialogMode(relogin) {
  const dialog = document.querySelector("#line-friend-dialog");
  if (!dialog) return null;
  const title = dialog.querySelector("#line-friend-dialog-title");
  const copy = dialog.querySelector("[data-line-friend-copy]");
  if (title) title.textContent = relogin ? RELOGIN_DIALOG_TITLE : FRIEND_DIALOG_TITLE;
  if (copy) copy.textContent = relogin ? RELOGIN_DIALOG_COPY : FRIEND_DIALOG_COPY;
  dialog.querySelector("[data-line-friend-request]")?.classList.toggle("hidden", relogin);
  dialog.querySelector("[data-line-friend-check]")?.classList.toggle("hidden", relogin);
  dialog.querySelector("[data-line-relogin]")?.classList.toggle("hidden", !relogin);
  return dialog;
}

function showFriendDialogMessage(dialog, message) {
  const error = document.querySelector("#line-friend-error");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
  showDialog(dialog);
}

export function showLineFriendDialog(message = "請先加入潮吉好頑官方 LINE，才能建立訂單並收到訂單狀態通知。") {
  showFriendDialogMessage(setLineFriendDialogMode(false), message);
}

export function showLineReloginDialog(message) {
  showFriendDialogMessage(setLineFriendDialogMode(true), message);
}

export async function handleLineFriendRequest(button) {
  if (!canRequestLineFriendship()) return false;
  button.setAttribute("aria-disabled", "true");
  try {
    await requestLineFriendship();
  } catch (error) {
    showLineFriendDialog(error.message || "LINE 好友狀態暫時無法確認");
    button.removeAttribute("aria-disabled");
    return true;
  }
  try {
    if (!await ensureLineFriendship({ force: true, notFriendMessage: "尚未偵測到好友狀態，請完成加入後再重新檢查。" })) return true;
    closeDialog(document.querySelector("#line-friend-dialog"));
    await openCheckout(activeCheckoutScope);
    return true;
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

class LineFriendshipError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

async function friendOrPrompt({ force, notFriendMessage }) {
  if (await checkLineFriendship({ force })) return true;
  showLineFriendDialog(notFriendMessage);
  return false;
}

// 確認是官方 LINE 好友；不是好友或無法確認時依原因顯示加好友、重新登入或錯誤提示，回傳 false
export async function ensureLineFriendship({ force = false, notFriendMessage } = {}) {
  try {
    return await friendOrPrompt({ force, notFriendMessage });
  } catch (firstError) {
    let error = firstError;
    if (error.kind === FRIENDSHIP_SESSION_EXPIRED) {
      // 換發成功換上新 token 再查一次；換發失敗會登出並把頁首恢復成「LINE 登入」
      await handleSessionExpired();
      if (!auth.accessToken || !auth.user) {
        showLineReloginDialog("登入已過期，請重新以 LINE 登入。");
        return false;
      }
      try { return await friendOrPrompt({ force: true, notFriendMessage }); }
      catch (retryError) { error = retryError; }
    }
    if (error.kind === FRIENDSHIP_SESSION_EXPIRED || error.kind === FRIENDSHIP_LINE_RELOGIN) showLineReloginDialog(error.message);
    else showLineFriendDialog(error.message || "LINE 好友狀態暫時無法確認");
    return false;
  }
}

export async function checkLineFriendship({ force = false } = {}) {
  const userId = auth.user?.id;
  const accessToken = auth.accessToken;
  if (!userId || !accessToken) return false;
  if (!force && lineFriendshipCache.userId === userId && lineFriendshipCache.expiresAt > Date.now() && typeof lineFriendshipCache.value === "boolean") {
    auth.lineFriendFlag = lineFriendshipCache.value;
    return auth.lineFriendFlag;
  }
  if (lineFriendshipInFlight?.userId === userId && lineFriendshipInFlight?.accessToken === accessToken) return lineFriendshipInFlight.promise;
  const promise = (async () => {
    const lineAccessToken = liffSessionMatches && liffState.accessToken ? liffState.accessToken : auth.lineProviderToken;
    const response = await fetch("/api/member/line-friendship", { headers: { Authorization: `Bearer ${accessToken}`, ...(lineAccessToken ? { "X-LINE-Login-Access-Token": lineAccessToken } : {}) } });
    const result = await response.json().catch(() => ({}));
    const failure = lineFriendshipFailureKind(response.status, result);
    if (failure === FRIENDSHIP_LINE_RELOGIN && response.ok) throw new LineFriendshipError("需要重新以 LINE 登入，才能確認官方 LINE 好友狀態。", failure);
    if (!response.ok) throw new LineFriendshipError(result.error || "LINE 好友狀態暫時無法確認", failure);
    const friendFlag = result.friendFlag === true;
    if (auth.user?.id === userId && auth.accessToken === accessToken) {
      lineFriendshipCache = { userId, value: friendFlag, expiresAt: Date.now() + LINE_FRIENDSHIP_TTL_MS };
      auth.lineFriendFlag = friendFlag;
    }
    return friendFlag;
  })();
  lineFriendshipInFlight = { userId, accessToken, promise };
  try {
    return await promise;
  } finally {
    if (lineFriendshipInFlight?.promise === promise) lineFriendshipInFlight = null;
  }
}

export function requireLineFriendshipForCheckout() {
  return ensureLineFriendship();
}
