// 會員：載入會員與個人資料、LINE 身分同步、會員資料表單與 LINE 登入入口。
import { watchSessionExpiry } from "./auth-expiry.js";
import { auth, closeDialog, showDialog, showToast } from "./app-core.js";
import { cartSyncUserId, loadMemberCart, resetMemberCartSyncState, saveCart } from "./cart.js";
import { clearMemberStateCache, lineFriendshipCache, loadPoints, memberPointsCache, renderMemberPoints } from "./member-benefits.js";
import { resumePendingReturnCheckout, saveAuthReturnState } from "./auth-return-state.js";
import { LIFF_AUTO_CALLBACK_PARAM, LIFF_AUTO_LOGIN_KEY, clearStoredAuthSession, liffOAuthCallbackSeen, markLiffAutoLoginAttempt, recentLiffAutoLoginAttempt } from "./liff-session.js";

let memberLoadInFlight = null;
let memberLoadResolved = false;

let identitySyncUserId = null;
let identitySyncInFlight = null;

async function syncMemberIdentityOnce() {
  const userId = auth.user?.id;
  if (!auth.accessToken || !userId || !auth.config?.authEnabled) return;
  const storageKey = `cj-identity-sync:${userId}`;
  try {
    if (sessionStorage.getItem(storageKey) === "attempted") return;
  } catch {
    // The in-memory guard below still prevents duplicate calls in restricted previews.
  }
  if (identitySyncUserId === userId && identitySyncInFlight) return identitySyncInFlight;
  identitySyncUserId = userId;
  identitySyncInFlight = fetch("/api/member/identity-sync", { method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}` } })
    .then((response) => {
      try {
        if (response.ok) sessionStorage.setItem(storageKey, "attempted");
        else sessionStorage.removeItem(storageKey);
      } catch { /* sessionStorage may be unavailable in restricted previews. */ }
      return response;
    })
    .catch(() => {
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore restricted storage */ }
      return null;
    })
    .finally(() => { identitySyncInFlight = null; });
  return identitySyncInFlight;
}

export function loadMember() {
  if (memberLoadResolved) return Promise.resolve();
  if (memberLoadInFlight) return memberLoadInFlight;
  const promise = (async () => {
    if (!auth.accessToken || !auth.config?.authEnabled) return;
    try {
      const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
      if (!response.ok) throw new Error("expired");
      const user = await response.json();
      if ((auth.user?.id && auth.user.id !== user.id) || (cartSyncUserId && cartSyncUserId !== user.id)) resetMemberCartSyncState();
      if ((memberPointsCache.userId && memberPointsCache.userId !== user.id) || (lineFriendshipCache.userId && lineFriendshipCache.userId !== user.id)) clearMemberStateCache();
      auth.user = user;
      updateMemberButton();
      watchSessionExpiry();
      // Identity binding is an explicit, best-effort operation. A temporary
      // service-role/database failure must not log the member out or block catalog.
      await Promise.all([
        syncMemberIdentityOnce(),
        loadProfile(),
        loadPoints().catch(() => { auth.points = null; }),
        loadMemberCart()
      ]);
      updateMemberButton();
      if (!profileIsComplete()) showProfileDialog(true);
    } catch {
      clearStoredAuthSession();
    }
  })();
  memberLoadInFlight = promise.then((result) => {
    memberLoadResolved = true;
    return result;
  }).finally(() => {
    memberLoadInFlight = null;
  });
  return memberLoadInFlight;
}

async function loadProfile() {
  const url = new URL(`${auth.config.supabaseUrl}/rest/v1/profiles`);
  url.searchParams.set("select", "full_name,phone,birthday,address,is_admin");
  url.searchParams.set("id", `eq.${auth.user.id}`);
  const response = await fetch(url, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
  if (!response.ok) throw new Error("會員資料讀取失敗");
  const rows = await response.json();
  auth.profile = rows[0] ?? { full_name: null, phone: null, birthday: null, address: null };
}

export function profileIsComplete() {
  return Boolean(auth.profile?.full_name?.trim() && auth.profile?.phone?.trim());
}

function updateMemberButton() {
  const displayName = auth.profile?.full_name || auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "會員";
  const button = document.querySelector("[data-demo='login']");
  button.textContent = displayName;
  // 名稱可能被 CSS 截斷，完整名稱保留在提示與報讀文字
  button.title = `${displayName}｜查看或修改會員資料`;
  button.setAttribute("aria-label", `會員 ${displayName}，查看或修改會員資料`);
  // 頁首（桌機）與主選單列（手機）各有一顆「我的訂單」，由 CSS 依寬度只顯示其一
  document.querySelectorAll("[data-orders-open]").forEach((button) => button.classList.remove("hidden"));
  document.querySelector("[data-admin-open]").classList.toggle("hidden", auth.profile?.is_admin !== true);
  if (auth.profile?.full_name) document.querySelector("#checkout-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-phone").value = auth.profile.phone;
  if (auth.profile?.address) document.querySelector("#checkout-address").value = auth.profile.address;
}

export function showProfileDialog(required = false) {
  const dialog = document.querySelector("#profile-dialog");
  const metadataName = auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "";
  document.querySelector("#profile-name").value = auth.profile?.full_name || metadataName;
  document.querySelector("#profile-phone").value = auth.profile?.phone || "";
  document.querySelector("#profile-birthday").value = auth.profile?.birthday || "";
  document.querySelector("#profile-address").value = auth.profile?.address || "";
  document.querySelector("#profile-birthday").max = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  document.querySelector("#profile-error").classList.add("hidden");
  document.querySelector(".profile-close").classList.toggle("hidden", required);
  document.querySelector("#profile-dialog-title").textContent = required ? "完成會員資料" : "會員資料";
  document.querySelector("[data-profile-copy]").textContent = required
    ? "第一次使用 LINE 登入，請先填寫基本資料。姓名與手機為必填，生日與地址可稍後補上。"
    : "可在這裡更新聯絡資料；生日與地址為選填。";
  renderMemberPoints();
  dialog.dataset.required = String(required);
  showDialog(dialog);
}

export function beginLineLogin({ automatic = false } = {}) {
  if (!auth.config?.authEnabled) {
    showToast("LINE Login 尚未在 Supabase 啟用");
    return false;
  }
  if (automatic && (liffOAuthCallbackSeen || recentLiffAutoLoginAttempt())) return false;
  if (!automatic) {
    try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
  }
  if (automatic) markLiffAutoLoginAttempt();
  saveAuthReturnState();
  saveCart();
  const redirectUrl = new URL(location.origin + location.pathname);
  if (automatic) redirectUrl.searchParams.set(LIFF_AUTO_CALLBACK_PARAM, String(Date.now()));
  const url = new URL(`${auth.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", auth.config.lineProvider);
  url.searchParams.set("redirect_to", redirectUrl.toString());
  url.searchParams.set("bot_prompt", "normal");
  // The automatic LIFF handoff must not add another history entry. Manual
  // login keeps the normal browser navigation semantics.
  if (automatic) location.replace(url.toString());
  else location.assign(url.toString());
  return true;
}

export async function saveProfile(profile) {
  const response = await fetch(`${auth.config.supabaseUrl}/rest/v1/profiles?id=eq.${auth.user.id}`, {
    method: "PATCH",
    headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(profile)
  });
  if (!response.ok) throw new Error("會員資料儲存失敗");
  const rows = await response.json();
  if (!rows.length) throw new Error("找不到會員資料，請重新登入後再試");
  auth.profile = rows[0];
  updateMemberButton();
}

export async function submitProfile(event) {
  event.preventDefault();
  const submitButton = document.querySelector(".profile-submit");
  const fullName = document.querySelector("#profile-name").value.trim();
  const rawPhone = document.querySelector("#profile-phone").value.trim();
  const phone = rawPhone.replace(/[\s-]/g, "");
  const birthday = document.querySelector("#profile-birthday").value || null;
  const address = document.querySelector("#profile-address").value.trim() || null;
  document.querySelector("#profile-error").classList.add("hidden");
  if (!fullName) return showProfileError("請填寫姓名");
  if (!/^09\d{8}$/.test(phone)) return showProfileError("請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  submitButton.disabled = true;
  submitButton.textContent = "儲存中…";
  try {
    await saveProfile({ full_name: fullName, phone, birthday, address });
    document.querySelector("#checkout-name").value = fullName;
    document.querySelector("#checkout-phone").value = phone;
    closeDialog(document.querySelector("#profile-dialog"));
    showToast("會員資料已儲存", "success");
    await resumePendingReturnCheckout();
  } catch (error) {
    showProfileError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "儲存會員資料";
  }
}

function showProfileError(message) {
  const errorNode = document.querySelector("#profile-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}
