// 會員點數與優惠券資料、LINE 好友狀態檢查（結帳前需加入官方帳號）。
import { liffState, canRequestLineFriendship, requestLineFriendship } from "./liff-auth.js";
import { escapeHtml, money } from "./product-format.js";
import { auth, closeDialog, formatDate, showDialog } from "./app-core.js";
import { resetMemberCartSyncState } from "./cart.js";
import { activeCheckoutScope, liffSessionMatches, openCheckout } from "./app.js";

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

export function showLineFriendDialog(message = "請先加入潮吉好頑官方 LINE，才能建立訂單並收到訂單狀態通知。") {
  const dialog = document.querySelector("#line-friend-dialog");
  const error = document.querySelector("#line-friend-error");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
  showDialog(dialog);
}

export async function handleLineFriendRequest(button) {
  if (!canRequestLineFriendship()) return false;
  button.setAttribute("aria-disabled", "true");
  try {
    await requestLineFriendship();
    const isFriend = await checkLineFriendship({ force: true });
    if (!isFriend) {
      showLineFriendDialog("尚未偵測到好友狀態，請完成加入後再重新檢查。");
      return true;
    }
    closeDialog(document.querySelector("#line-friend-dialog"));
    await openCheckout(activeCheckoutScope);
    return true;
  } catch (error) {
    showLineFriendDialog(error.message || "LINE 好友狀態暫時無法確認");
    return true;
  } finally {
    button.removeAttribute("aria-disabled");
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
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "LINE 好友狀態暫時無法確認");
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

export async function requireLineFriendshipForCheckout() {
  try {
    const isFriend = await checkLineFriendship();
    if (isFriend) return true;
    showLineFriendDialog();
    return false;
  } catch (error) {
    showLineFriendDialog(error.message);
    return false;
  }
}
