// 一般瀏覽器（非 LINE App）的登入續期。
// OAuth 回來當下把 refresh token 交給 Worker（/api/auth/web-session/start），由 Worker 加密存進
// HttpOnly cookie；前端之後只持有 access token，快到期或新分頁開啟時以 cookie 換發。
// cookie 為瀏覽器工作階段（關閉瀏覽器即失效），Worker 另外強制首次登入後最長 12 小時。
const REQUEST_HEADERS = { "Content-Type": "application/json", "X-CJ-Web-Session": "1" };
const LOCK_NAME = "cj-web-session-refresh";
// Worker 同時設定的可讀提示 cookie，不含憑證；沒有它就不必呼叫續期 API。
const HINT_COOKIE = "__Host-cj-web-hint=1";

let refreshInFlight = null;

// 回傳 { session, retryable }：session 為成功結果或 null；retryable 表示網路、限流或服務暫時故障
async function send(path, body) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: REQUEST_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && typeof result.access_token === "string") return { session: result, retryable: false };
    return { session: null, retryable: response.status === 429 || response.status >= 500 };
  } catch {
    return { session: null, retryable: true };
  }
}

export function hasWebSession() {
  try { return document.cookie.split(";").some((part) => part.trim() === HINT_COOKIE); }
  catch { return false; }
}

// 回傳 { session, retryable }；session 為 { access_token, expires_in, user_id, session_expires_at } 或 null
export function startWebSession(refreshToken) {
  if (!refreshToken) return Promise.resolve({ session: null, retryable: false });
  return send("/api/auth/web-session/start", { refresh_token: refreshToken });
}

// 回傳 { session, retryable }。同一分頁合併重複呼叫；跨分頁以 Web Locks 排隊，避免多個分頁同時用同一個 refresh token 換發
export function refreshWebSessionOutcome() {
  if (!hasWebSession()) return Promise.resolve({ session: null, retryable: false });
  refreshInFlight ||= (navigator.locks?.request
    ? navigator.locks.request(LOCK_NAME, () => send("/api/auth/web-session/refresh"))
    : send("/api/auth/web-session/refresh")
  ).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// 登出：請 Worker 清掉續期 cookie。回傳是否成功；失敗時 cookie 仍在，重新整理會再恢復登入
export async function endWebSession() {
  try {
    const response = await fetch("/api/auth/web-session/logout", { method: "POST", headers: REQUEST_HEADERS, credentials: "same-origin", body: "{}" });
    return response.ok;
  } catch {
    return false;
  }
}

// 只需要結果的呼叫端（開機、獨立訂單頁）：回傳 session 或 null
export async function refreshWebSession() {
  return (await refreshWebSessionOutcome()).session;
}
