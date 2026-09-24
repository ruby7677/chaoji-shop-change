// 一般瀏覽器（非 LINE App）的登入續期。
// OAuth 回來當下把 refresh token 交給 Worker（/api/auth/web-session/start），由 Worker 加密存進
// HttpOnly cookie；前端之後只持有 access token，快到期或新分頁開啟時以 cookie 換發。
// cookie 為瀏覽器工作階段（關閉瀏覽器即失效），Worker 另外強制首次登入後最長 12 小時。
const REQUEST_HEADERS = { "Content-Type": "application/json", "X-CJ-Web-Session": "1" };
const LOCK_NAME = "cj-web-session-refresh";
// Worker 同時設定的可讀提示 cookie，不含憑證；沒有它就不必呼叫續期 API。
const HINT_COOKIE = "__Host-cj-web-hint=1";

let refreshInFlight = null;

async function post(path, body) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: REQUEST_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(body || {})
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || typeof result.access_token !== "string") return null;
    return result;
  } catch {
    return null;
  }
}

export function hasWebSession() {
  try { return document.cookie.split(";").some((part) => part.trim() === HINT_COOKIE); }
  catch { return false; }
}

// 回傳 { access_token, expires_in, user_id, session_expires_at } 或 null
export function startWebSession(refreshToken) {
  if (!refreshToken) return Promise.resolve(null);
  return post("/api/auth/web-session/start", { refresh_token: refreshToken });
}

// 同一分頁合併重複呼叫；跨分頁以 Web Locks 排隊，避免多個分頁同時用同一個 refresh token 換發
export function refreshWebSession() {
  if (!hasWebSession()) return Promise.resolve(null);
  refreshInFlight ||= (navigator.locks?.request
    ? navigator.locks.request(LOCK_NAME, () => post("/api/auth/web-session/refresh"))
    : post("/api/auth/web-session/refresh")
  ).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
