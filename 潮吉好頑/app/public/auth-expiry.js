// 會員登入逾時處理：Supabase access token 約 1 小時到期。
// 到期前 1 分鐘（或後台 API 回 401）先嘗試換發（LINE App 內的 LIFF 工作階段、一般瀏覽器的 web-session cookie），
// 失敗才把頁首恢復成未登入並提示重新登入，
// 避免頁首仍顯示會員名稱、但所有會員／後台操作都被拒絕。
// 提前換發，避免在到期那一刻送出的請求拿到 401
const RENEW_BEFORE_MS = 60 * 1000;
// 換發遇到網路、限流或服務暫時故障：保留登入，隔一段時間自動再試
export const RENEW_RETRY_MS = 30 * 1000;
let deps = null;
let retryNoticeShown = false;
let timer = null;
let handling = null;

function tokenExpiresAt(token) {
  try {
    const part = String(token).split(".")[1];
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const exp = Number(JSON.parse(atob(base64)).exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpired(token) {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && Date.now() >= expiresAt;
}

// 已到期或即將到期（需要換發）
export function accessTokenExpiresSoon(token) {
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== null && Date.now() >= expiresAt - RENEW_BEFORE_MS;
}

function renderLoggedOut() {
  const login = document.querySelector("[data-demo='login']");
  if (login) {
    login.textContent = "LINE 登入";
    login.removeAttribute("title");
    login.removeAttribute("aria-label");
  }
  document.querySelectorAll("[data-orders-open]").forEach((button) => button.classList.add("hidden"));
  document.querySelector("[data-admin-open]")?.classList.add("hidden");
  // 後台與訂單視窗已無法讀寫資料，關閉後使用者才看得到頁首的「LINE 登入」
  ["#admin-dialog", "#orders-dialog"].forEach((selector) => {
    const dialog = document.querySelector(selector);
    if (dialog?.open) deps.closeDialog(dialog);
  });
}

// 可由其他地方（例如 API 回 401）呼叫；同時只處理一次。
// early：到期前的預先換發；換發失敗但舊 token 仍有效時，等真正到期再處理，不提前登出。
export function handleSessionExpired({ early = false } = {}) {
  if (!deps || !deps.getAccessToken()) return Promise.resolve();
  handling ||= (async () => {
    window.clearTimeout(timer);
    // tryRestore 回傳 "restored"／"failed"／"retry"（舊介面的 true／false 也接受）；例外視為暫時故障
    const outcome = await deps.tryRestore().catch(() => "retry");
    const restored = outcome === true || outcome === "restored";
    if (restored && deps.getAccessToken() && !isExpired(deps.getAccessToken())) {
      retryNoticeShown = false;
      watchSessionExpiry();
      return;
    }
    const current = deps.getAccessToken();
    const expiresAt = tokenExpiresAt(current);
    if (early && current && expiresAt !== null && Date.now() < expiresAt) {
      timer = window.setTimeout(() => { void handleSessionExpired(); }, Math.min(expiresAt - Date.now(), outcome === "retry" ? RENEW_RETRY_MS : Infinity));
      return;
    }
    if (outcome === "retry") {
      // 暫時故障不登出：token 已到期的請求會失敗，但工作階段仍在，稍後自動重試
      timer = window.setTimeout(() => { void handleSessionExpired(); }, RENEW_RETRY_MS);
      // 舊 token 仍有效時不打擾；已到期（操作會失敗）才提示一次
      if (!retryNoticeShown && (!current || isExpired(current))) {
        deps.showToast("登入續期暫時無法完成，稍後會自動重試", "warning");
        retryNoticeShown = true;
      }
      return;
    }
    retryNoticeShown = false;
    deps.clearSession();
    renderLoggedOut();
    deps.showToast("登入已過期，請重新登入", "warning");
  })().finally(() => { handling = null; });
  return handling;
}

// 登入成功或換發新 token 後呼叫：在到期時間點觸發檢查
export function watchSessionExpiry() {
  if (!deps) return;
  window.clearTimeout(timer);
  const expiresAt = tokenExpiresAt(deps.getAccessToken());
  if (expiresAt === null) return;
  // setTimeout 上限約 24.8 天；token 只有小時級，不會超過
  timer = window.setTimeout(() => { void handleSessionExpired({ early: true }); }, Math.max(0, expiresAt - RENEW_BEFORE_MS - Date.now()));
}

// 結帳、建單等需要會員的操作前呼叫：token 已到期或即將到期就先換發，換發失敗會登出，呼叫端再依 auth 狀態導去登入
export async function ensureFreshSession() {
  const token = deps?.getAccessToken();
  if (token && accessTokenExpiresSoon(token)) await handleSessionExpired({ early: true });
}

// 每分鐘檢查一次：電腦休眠後計時器可能延後，分頁一直在前景時也不會有 visibilitychange
export const EXPIRY_CHECK_INTERVAL_MS = 60 * 1000;

// deps：getAccessToken、tryRestore、clearSession、closeDialog、showToast
export function initAuthExpiry(options) {
  if (deps) return;
  deps = options;
  const check = () => {
    if (document.visibilityState !== "visible") return;
    void ensureFreshSession();
  };
  // 手機休眠或分頁在背景時計時器會暫停；回到頁面、視窗取得焦點或從 bfcache 還原時補檢查
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  window.setInterval(check, EXPIRY_CHECK_INTERVAL_MS);
}
