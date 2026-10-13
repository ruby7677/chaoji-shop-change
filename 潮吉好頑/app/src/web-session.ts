// 一般瀏覽器（非 LINE App）的登入續期。
// OAuth 回來後前端把 refresh token 交給 start，Worker 換發一次（同時驗證 token 有效且是 LINE 會員），
// 再以 AES-GCM 加密存進 HttpOnly、SameSite=Strict 的瀏覽器工作階段 cookie；前端之後只持有 access token。
// refresh 以 cookie 換發新 access token，並依首次登入時間強制最長 12 小時。
// 不寫入 LIFF vault 也不共用 LIFF cookie：兩條 refresh token 鏈各自輪替，不會互相觸發 Supabase 的重複使用撤銷。
import {
  clearWebSessionCookies,
  openWebSession,
  readWebSessionCookie,
  requestSupabaseRefresh,
  sealWebSession,
  webSessionCookies,
  type SupabaseRefreshSession
} from "./auth-session";

export const WEB_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Supabase access token 約 1 小時有效；超過這個時間點不再換發，最後一張 token 也會在 12 小時內到期。
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const RENEWAL_CUTOFF_MS = WEB_SESSION_MAX_AGE_MS - ACCESS_TOKEN_LIFETIME_MS;
// 前端每次請求都帶這個自訂 header：跨站表單無法送出，跨站 fetch 會觸發 CORS 預檢而被擋。
const WEB_SESSION_HEADER = "X-CJ-Web-Session";
const MAX_REFRESH_TOKEN_LENGTH = 8192;
// 伺服器時鐘誤差容忍；超過代表 payload 異常，視同失效。
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface WebSessionEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  AUTH_SESSION_SECRET?: string;
  API_MEMBER_RATE_LIMITER?: RateLimit;
  API_AUTH_IP_RATE_LIMITER?: RateLimit;
}

export interface WebSessionDeps<E extends WebSessionEnv> {
  json(data: unknown, init?: ResponseInit): Response;
  enforceRateLimit(limiter: RateLimit | undefined, key: string): Promise<Response | null>;
  /** Returns the refreshed session's user id only when it carries a LINE identity; throws when Supabase cannot answer. */
  lineMemberId(env: E, session: SupabaseRefreshSession): Promise<string | null>;
}

type WebSessionFailure = "NO_WEB_SESSION" | "INVALID_WEB_SESSION" | "WEB_SESSION_EXPIRED";

export function createWebSession<E extends WebSessionEnv>(deps: WebSessionDeps<E>) {
  const { json, enforceRateLimit, lineMemberId } = deps;

  function ready(env: E) {
    return Boolean(env.AUTH_SESSION_SECRET && env.AUTH_SESSION_SECRET.length >= 32 && env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  }

  function withCookies(response: Response, cookies: string[]) {
    // json() merges headers with set(); append each Set-Cookie separately so neither is dropped.
    cookies.forEach((cookie) => response.headers.append("Set-Cookie", cookie));
    return response;
  }

  function unavailable(cookies: string[] = []) {
    // Supabase 暫時無法回應時保留 cookie（或換成已輪替的新 token），下次仍可續期。
    return withCookies(json({ error: "登入續期暫時無法完成，請稍後再試", code: "WEB_SESSION_UNAVAILABLE" }, { status: 503 }), cookies);
  }

  function failure(code: WebSessionFailure, clearCookies: boolean) {
    const response = json({ error: code === "WEB_SESSION_EXPIRED" ? "登入已超過 12 小時，請重新登入" : "登入工作階段已失效，請重新登入", code }, { status: 401 });
    return clearCookies ? withCookies(response, clearWebSessionCookies()) : response;
  }

  async function issue(env: E, refreshed: SupabaseRefreshSession, userId: string, issuedAt: number) {
    const sealed = await sealWebSession(env.AUTH_SESSION_SECRET!, { rt: refreshed.refresh_token, iat: issuedAt, uid: userId });
    return withCookies(json({
      access_token: refreshed.access_token,
      expires_in: Number(refreshed.expires_in || 0),
      user_id: userId,
      session_expires_at: new Date(issuedAt + WEB_SESSION_MAX_AGE_MS).toISOString()
    }), webSessionCookies(sealed));
  }

  async function guard(request: Request, env: E, action: string) {
    if (request.headers.get(WEB_SESSION_HEADER) !== "1") return json({ error: "登入續期請求格式錯誤" }, { status: 400 });
    // 第一層：驗證身分之前只以 IP 防洪（上限寬鬆，避免共用 IP 的會員互相阻擋）
    const rateLimitResponse = await enforceRateLimit(env.API_AUTH_IP_RATE_LIMITER, `web-session-${action}:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
    if (rateLimitResponse) return rateLimitResponse;
    if (!ready(env)) return json({ error: "登入續期尚未設定" }, { status: 503 });
    return null;
  }

  // 第二層：以會員 id 計數，同一帳號換 IP 也無法大量呼叫（refresh 用 cookie 內已驗證的 id，在輪替前檢查）
  function verifiedUserRateLimit(env: E, action: string, userId: string) {
    return enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `web-session-${action}-user:${userId}`);
  }

  async function start(request: Request, env: E): Promise<Response> {
    const blocked = await guard(request, env, "start");
    if (blocked) return blocked;
    let body: { refresh_token?: unknown } | null;
    try { body = await request.json() as { refresh_token?: unknown } | null; }
    catch { return json({ error: "登入工作階段資料格式錯誤" }, { status: 400 }); }
    const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token.trim() : "";
    if (!refreshToken || refreshToken.length > MAX_REFRESH_TOKEN_LENGTH) return json({ error: "登入工作階段資料不完整" }, { status: 400 });
    // Rotating once proves the token is live and yields a lineage only this cookie holds.
    const result = await requestSupabaseRefresh(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, refreshToken);
    if (!result.ok) return result.retryable ? unavailable() : failure("INVALID_WEB_SESSION", true);
    const refreshed = result.session;
    // OAuth token 只在此刻出現、事先無從得知會員 id，限流只能在輪替後。查詢暫時失敗回 503：token 已輪替，前端重送只在 Supabase 重複使用寬限內有效，否則需重新登入（refresh 回應通常已帶 user，極少走到）
    let userId: string | null;
    try { userId = await lineMemberId(env, refreshed); }
    catch { return unavailable(); }
    if (!userId) return withCookies(json({ error: "本網站僅接受 LINE 會員登入" }, { status: 403 }), clearWebSessionCookies());
    const userRateLimitResponse = await verifiedUserRateLimit(env, "start", userId);
    if (userRateLimitResponse) return userRateLimitResponse;
    return issue(env, refreshed, userId, Date.now());
  }

  async function refresh(request: Request, env: E): Promise<Response> {
    const blocked = await guard(request, env, "refresh");
    if (blocked) return blocked;
    const sealed = readWebSessionCookie(request);
    if (!sealed) return failure("NO_WEB_SESSION", true);
    const payload = await openWebSession(env.AUTH_SESSION_SECRET!, sealed);
    if (!payload) return failure("INVALID_WEB_SESSION", true);
    const now = Date.now();
    if (payload.iat > now + CLOCK_SKEW_MS || now - payload.iat >= RENEWAL_CUTOFF_MS) return failure("WEB_SESSION_EXPIRED", true);
    // 輪替前限流：限流後才輪替會讓新 token 隨 429 遺失，舊 token 又已失效
    const userRateLimitResponse = await verifiedUserRateLimit(env, "refresh", payload.uid);
    if (userRateLimitResponse) return userRateLimitResponse;
    const result = await requestSupabaseRefresh(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, payload.rt);
    if (!result.ok) return result.retryable ? unavailable() : failure("INVALID_WEB_SESSION", true);
    const refreshed = result.session;
    let userId: string | null;
    try { userId = await lineMemberId(env, refreshed); }
    catch {
      // 已輪替但查不到使用者：新 token 由同一 cookie 的 token 換來，沿用 cookie 內的會員 id 與登入時間存回
      const sealedRotated = await sealWebSession(env.AUTH_SESSION_SECRET!, { rt: refreshed.refresh_token, iat: payload.iat, uid: payload.uid });
      return unavailable(webSessionCookies(sealedRotated));
    }
    if (!userId || userId !== payload.uid) return failure("INVALID_WEB_SESSION", true);
    // Keep the original login time so renewals never extend the 12-hour cap.
    return issue(env, refreshed, userId, payload.iat);
  }

  async function route(request: Request, env: E, url: URL): Promise<Response | null> {
    if (request.method !== "POST") return null;
    if (url.pathname === "/api/auth/web-session/start") return start(request, env);
    if (url.pathname === "/api/auth/web-session/refresh") return refresh(request, env);
    return null;
  }

  return { route };
}
