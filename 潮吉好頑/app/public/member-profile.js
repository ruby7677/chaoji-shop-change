// 會員：載入會員與個人資料、LINE 身分同步、會員資料表單與 LINE 登入入口。
import { watchSessionExpiry } from "./auth-expiry.js";
import { endWebSession } from "./web-session.js";
import { liffState } from "./liff-auth.js";
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

class MemberSessionRejected extends Error {}
const MEMBER_LOAD_RETRY = Symbol("member-load-retry");

export function loadMember() {
  if (memberLoadResolved) return Promise.resolve();
  if (memberLoadInFlight) return memberLoadInFlight;
  const promise = (async () => {
    if (!auth.accessToken || !auth.config?.authEnabled) return;
    try {
      const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
      if (response.status === 401 || response.status === 403) throw new MemberSessionRejected();
      if (!response.ok) throw new Error(`member lookup failed (${response.status})`);
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
    } catch (error) {
      // 只有 Supabase 確定拒絕 token 才登出；網路、限流或服務暫時故障保留登入，下次呼叫再載入
      if (error instanceof MemberSessionRejected) { clearStoredAuthSession(); return; }
      showToast("會員資料暫時無法載入，請稍後重新整理", "warning");
      return MEMBER_LOAD_RETRY;
    }
  })();
  memberLoadInFlight = promise.then((result) => {
    memberLoadResolved = result !== MEMBER_LOAD_RETRY;
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
  // LINE App 內的登入綁定 LINE 帳號，下次開啟會自動恢復，登出沒有意義；只在一般瀏覽器提供
  document.querySelector("[data-member-logout]")?.classList.toggle("hidden", required || Boolean(liffState.isInClient));
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
  // LINE 內的登入（自動或手動）都帶 LIFF 回呼標記：WebView 回跳可能沒有原本的 sessionStorage，
  // 少了標記會被當成一般瀏覽器，不會保存 LIFF 登入，之後從 LINE 開獨立訂單頁就無法恢復
  if (automatic || liffState.isInClient) redirectUrl.searchParams.set(LIFF_AUTO_CALLBACK_PARAM, String(Date.now()));
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

// 一般瀏覽器登出：撤銷 Supabase 工作階段（盡力而為）、清掉續期 cookie 與前端登入資料，再以訪客身分重新載入
let logoutInFlight = false;
export async function logoutMember() {
  if (logoutInFlight) return;
  logoutInFlight = true;
  const accessToken = auth.accessToken;
  if (accessToken && auth.config?.authEnabled) {
    try {
      await fetch(`${auth.config.supabaseUrl}/auth/v1/logout?scope=local`, { method: "POST", headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${accessToken}` } });
    } catch { /* token 可能已過期；續期 cookie 清掉後一樣無法再恢復 */ }
  }
  if (!await endWebSession()) {
    logoutInFlight = false;
    showToast("登出未完成，請確認網路連線後再試", "warning");
    return;
  }
  clearStoredAuthSession();
  location.reload();
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
