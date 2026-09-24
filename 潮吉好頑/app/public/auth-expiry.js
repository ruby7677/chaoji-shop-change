// 會員登入逾時處理：Supabase access token 約 1 小時到期，頁面不會自動換發。
// 到期（或後台 API 回 401）時先嘗試恢復（LINE App 內的保存工作階段），失敗才把頁首恢復成未登入並提示重新登入，
// 避免頁首仍顯示會員名稱、但所有會員／後台操作都被拒絕。
let deps = null;
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

function renderLoggedOut() {
  const login = document.querySelector("[data-demo='login']");
  if (login) {
    login.textContent = "LINE 登入";
    login.removeAttribute("title");
  }
  document.querySelector("[data-orders-open]")?.classList.add("hidden");
  document.querySelector("[data-admin-open]")?.classList.add("hidden");
  // 後台與訂單視窗已無法讀寫資料，關閉後使用者才看得到頁首的「LINE 登入」
  ["#admin-dialog", "#orders-dialog"].forEach((selector) => {
    const dialog = document.querySelector(selector);
    if (dialog?.open) deps.closeDialog(dialog);
  });
}

// 可由其他地方（例如 API 回 401）呼叫；同時只處理一次
export function handleSessionExpired() {
  if (!deps || !deps.getAccessToken()) return Promise.resolve();
  handling ||= (async () => {
    window.clearTimeout(timer);
    const restored = await deps.tryRestore().catch(() => false);
    if (restored && deps.getAccessToken() && !isExpired(deps.getAccessToken())) {
      watchSessionExpiry();
      return;
    }
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
  timer = window.setTimeout(() => { void handleSessionExpired(); }, Math.max(0, expiresAt - Date.now()));
}

// deps：getAccessToken、tryRestore、clearSession、closeDialog、showToast
export function initAuthExpiry(options) {
  if (deps) return;
  deps = options;
  // 手機休眠或分頁在背景時計時器會暫停；回到頁面時補檢查
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const token = deps.getAccessToken();
    if (token && isExpired(token)) void handleSessionExpired();
  });
}
