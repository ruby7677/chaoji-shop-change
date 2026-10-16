// LINE 身分驗證、LIFF 持久登入（vault／cookie）與會員／管理員授權檢查。
import { type SupabaseRefreshSession, clearRefreshSessionCookie, openRefreshToken, readRefreshSessionCookie, refreshSessionCookie, requestSupabaseRefresh, sealRefreshToken } from "./auth-session";
import { deleteVaultedSession, readVaultedSession, replaceVaultedToken, storeVaultedSession } from "./liff-session-vault";
import { type AuthUser, type Env } from "./env";
import { bearerToken, enforceRateLimit, fetchWithTimeout, json, serviceHeaders } from "./http";
import { ServerTiming } from "./server-timing";

function lineIdentityId(user: AuthUser, env: Env) {
  const expectedProvider = (env.SUPABASE_CUSTOM_PROVIDER || "custom:line-web").toLowerCase();
  const metadataSources = (user.identities || [])
    .filter((identity) => {
      const provider = identity.provider?.toLowerCase();
      return provider === "line" || provider === "custom:line-web" || provider === expectedProvider;
    })
    .map((identity) => identity.identity_data || {});
  const value = metadataSources
    .flatMap((metadata) => [metadata.line_user_id, metadata.lineUserId, metadata.user_id, metadata.sub])
    .find((candidate) => typeof candidate === "string" && /^U[0-9a-f]{32}$/i.test(candidate.trim()));
  return typeof value === "string" ? value.trim() : null;
}

export function hasLineIdentity(user: AuthUser, env: Env) {
  return Boolean(lineIdentityId(user, env));
}

type VerifiedLiffIdentity = {
  iss?: string;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  name?: string;
  picture?: string;
};

type LiffIdTokenCheck =
  | { status: "valid"; identity: VerifiedLiffIdentity }
  | { status: "invalid" }
  | { status: "unavailable" };

// 分清「LINE 判定 token 無效」與「LINE 暫時無法驗證」（逾時、429、5xx）：後者不可當成登入失效處理
async function checkLiffIdToken(env: Env, idToken: string): Promise<LiffIdTokenCheck> {
  const channelId = env.LINE_LOGIN_CHANNEL_ID?.trim();
  if (!channelId) return { status: "invalid" };
  let response: Response;
  try {
    response = await fetchWithTimeout("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId })
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 429 || response.status >= 500) return { status: "unavailable" };
  if (!response.ok) return { status: "invalid" };
  const payload = await response.json().catch(() => null) as VerifiedLiffIdentity | null;
  if (!payload) return { status: "unavailable" };
  const expiresAt = Number(payload.exp || 0) * 1000;
  if (
    payload.iss !== "https://access.line.me"
    || payload.aud !== channelId
    || typeof payload.sub !== "string"
    || !/^U[0-9a-f]{32}$/i.test(payload.sub)
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) return { status: "invalid" };
  return { status: "valid", identity: payload };
}

// 其他路由沿用「無效回 null」；LINE 暫時無法驗證時丟出錯誤，由最外層回 503，避免前端誤判為登入失效
async function verifyLiffIdToken(env: Env, idToken: string): Promise<VerifiedLiffIdentity | null> {
  const result = await checkLiffIdToken(env, idToken);
  if (result.status === "unavailable") throw new Error("LINE 身分驗證服務暫時無法使用");
  return result.status === "valid" ? result.identity : null;
}

export async function verifyLiffIdentity(request: Request, env: Env): Promise<Response> {
  // 第一層：驗證 LINE token 之前只以 IP 防洪（上限寬鬆，避免共用 IP 的會員互相阻擋）
  const rateLimitResponse = await enforceRateLimit(env.API_AUTH_IP_RATE_LIMITER, `liff:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.LINE_LOGIN_CHANNEL_ID || !env.LIFF_ID) return json({ error: "LIFF 尚未設定" }, { status: 503 });
  let body: { id_token?: unknown } | null;
  try { body = await request.json() as { id_token?: unknown } | null; }
  catch { return json({ error: "LIFF 驗證資料格式錯誤" }, { status: 400 }); }
  const idToken = typeof body?.id_token === "string" ? body.id_token.trim() : "";
  if (!idToken || idToken.length > 8192) return json({ error: "LIFF 驗證資料不完整" }, { status: 400 });
  const identity = await verifyLiffIdToken(env, idToken);
  if (!identity?.sub) return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401 });
  // 第二層：LINE 驗證通過後以該帳號計數，同一帳號換 IP 也無法大量呼叫
  const userRateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `liff-user:${identity.sub}`);
  if (userRateLimitResponse) return userRateLimitResponse;
  let sessionMatch: boolean | null = null;
  if (bearerToken(request)) {
    const authResult = await requireUser(request, env);
    if (authResult instanceof Response) return authResult;
    const authenticatedLineId = lineIdentityId(authResult.user, env);
    sessionMatch = Boolean(authenticatedLineId && authenticatedLineId.toLowerCase() === identity.sub.toLowerCase());
    if (!sessionMatch) return json({ error: "LIFF LINE 身分與目前會員登入不一致", code: "LIFF_SESSION_MISMATCH" }, { status: 409 });
  }
  return json({ verified: true, sessionMatch, displayName: typeof identity.name === "string" ? identity.name : null });
}

/** Supabase 暫時無法回應（429、5xx、逾時）時拋出，呼叫端不可把它當成登入失效；確定不是有效使用者才回 null。 */
export async function refreshedAuthUser(env: Env, session: SupabaseRefreshSession): Promise<AuthUser | null> {
  // refresh 回應通常已帶 user，優先使用，少一次可能失敗的查詢
  if (session.user && typeof session.user === "object") return session.user as AuthUser;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetchWithTimeout(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + session.access_token }
  });
  if (isTransientStatus(response.status)) throw new Error(`Supabase 使用者查詢暫時失敗（${response.status}）`);
  if (!response.ok) return null;
  return await response.json() as AuthUser;
}

function isTransientStatus(status: number) {
  return status === 429 || status >= 500;
}

function sessionBridgeReady(env: Env) {
  return Boolean(
    env.AUTH_SESSION_SECRET
    && env.AUTH_SESSION_SECRET.length >= 32
    && env.SUPABASE_URL
    && env.SUPABASE_ANON_KEY
    && env.LINE_LOGIN_CHANNEL_ID
  );
}

async function validateRefreshedLineSession(
  env: Env,
  session: SupabaseRefreshSession,
  lineUserId: string
) {
  const user = await refreshedAuthUser(env, session);
  if (!user || !hasLineIdentity(user, env)) return null;
  const authenticatedLineId = lineIdentityId(user, env);
  if (!authenticatedLineId || authenticatedLineId.toLowerCase() !== lineUserId.toLowerCase()) return null;
  return user;
}

export async function rememberLiffSession(request: Request, env: Env): Promise<Response> {
  // 第一層：驗證 LINE token 之前只以 IP 防洪（上限寬鬆，避免共用 IP 的會員互相阻擋）
  const rateLimitResponse = await enforceRateLimit(env.API_AUTH_IP_RATE_LIMITER, "session-remember:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
  if (rateLimitResponse) return rateLimitResponse;
  if (!sessionBridgeReady(env)) return json({ error: "LIFF 持久登入尚未設定" }, { status: 503 });

  let body: { refresh_token?: unknown; id_token?: unknown } | null;
  try { body = await request.json() as { refresh_token?: unknown; id_token?: unknown } | null; }
  catch { return json({ error: "登入工作階段資料格式錯誤" }, { status: 400 }); }
  const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token.trim() : "";
  const idToken = typeof body?.id_token === "string" ? body.id_token.trim() : "";
  if (!refreshToken || refreshToken.length > 8192 || !idToken || idToken.length > 8192) {
    return json({ error: "登入工作階段資料不完整" }, { status: 400 });
  }

  const checked = await checkLiffIdToken(env, idToken);
  if (checked.status === "unavailable") return sessionUnavailable("SESSION_REMEMBER_UNAVAILABLE");
  const identity = checked.status === "valid" ? checked.identity : null;
  if (!identity?.sub) return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401 });
  // 第二層：LINE 驗證通過後以該帳號計數，同一帳號換 IP 也無法大量呼叫
  const userRateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `session-remember-user:${identity.sub}`);
  if (userRateLimitResponse) return userRateLimitResponse;
  // 暫時性故障不清 cookie：前端保留 refresh token 稍後重試，不把會員登出
  const refreshed = await requestSupabaseRefresh(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, refreshToken);
  if (!refreshed.ok) {
    if (refreshed.retryable) return sessionUnavailable("SESSION_REMEMBER_UNAVAILABLE");
    return json({ error: "會員登入工作階段已失效" }, { status: 401, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }
  // token 已輪替但查不到使用者：這個 token 尚未驗證過身分，不能保存；前端重送只在 Supabase 重複使用寬限內有效（refresh 回應通常已帶 user，極少走到）
  let user: AuthUser | null;
  try { user = await validateRefreshedLineSession(env, refreshed.session, identity.sub); }
  catch { return sessionUnavailable("SESSION_REMEMBER_UNAVAILABLE"); }
  if (!user) {
    return json({ error: "LIFF LINE 身分與會員登入不一致" }, { status: 409, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }

  return persistedSessionResponse(env, identity.sub, user, refreshed.session);
}

/**
 * 恢復登入成功後一併回傳的資料（訂單頁的訂單，見 member-api.ts 的 ordersForRestoredSession），省掉前端再發一次請求。
 * 回傳 {} 表示不附帶；丟錯也當作不附帶：此時 refresh token 已輪替，無論如何都要把新的 access token 交給前端。
 */
export type RestoreExtras = (env: Env, user: AuthUser, authorization: string, timing: ServerTiming) => Promise<Record<string, unknown>>;

// The vault is the canonical store once available. Keeping the same refresh
// token lineage in both a cookie and the vault would let an old copy be reused
// after rotation, which Supabase treats as token reuse and revokes the session.
async function persistedSessionResponse(
  env: Env,
  lineUserId: string,
  user: AuthUser,
  refreshed: SupabaseRefreshSession,
  timing = new ServerTiming(),
  extras?: RestoreExtras
) {
  const sealed = await sealRefreshToken(env.AUTH_SESSION_SECRET!, refreshed.refresh_token);
  // 附帶資料用新的 access token 讀取，與保存登入互不相依，同時進行
  const [vaulted, extra] = await Promise.all([
    timing.measure("save", storeVaultedSession(env, lineUserId, user.id, sealed)),
    extras ? extras(env, user, `Bearer ${refreshed.access_token}`, timing).catch(() => ({})) : Promise.resolve({})
  ]);
  return json({
    ...extra,
    access_token: refreshed.access_token,
    expires_in: Number(refreshed.expires_in || 0),
    user_id: user.id
  }, { headers: { "Set-Cookie": vaulted ? clearRefreshSessionCookie() : refreshSessionCookie(sealed), "Server-Timing": timing.header() } });
}

type SealedSessionResult =
  | { ok: true; user: AuthUser; refreshed: SupabaseRefreshSession }
  // rotated：token 已輪替但查不到使用者，呼叫端要把新 token 存回原處，否則舊 token 已失效、會員被迫重新登入
  | { ok: false; reason: "unavailable"; rotated?: SupabaseRefreshSession }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" };

async function restoreSealedSession(env: Env, sealed: string, lineUserId: string): Promise<SealedSessionResult> {
  const refreshToken = await openRefreshToken(env.AUTH_SESSION_SECRET!, sealed);
  if (!refreshToken) return { ok: false, reason: "invalid" };
  const refreshed = await requestSupabaseRefresh(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, refreshToken);
  if (!refreshed.ok) return { ok: false, reason: refreshed.retryable ? "unavailable" : "expired" };
  let user: AuthUser | null;
  try { user = await validateRefreshedLineSession(env, refreshed.session, lineUserId); }
  catch { return { ok: false, reason: "unavailable", rotated: refreshed.session }; }
  if (!user) return { ok: false, reason: "mismatch" };
  return { ok: true, user, refreshed: refreshed.session };
}

// LINE／Supabase 暫時無法回應：保留 vault 與 cookie，前端稍後重試，不可改走 OAuth
function sessionUnavailable(code: "SESSION_RESTORE_UNAVAILABLE" | "SESSION_REMEMBER_UNAVAILABLE", init: ResponseInit = {}) {
  return json({ error: "登入暫時無法恢復，請稍後再試", code, retryable: true }, { ...init, status: 503 });
}

function restoreUnavailable(init?: ResponseInit) {
  return sessionUnavailable("SESSION_RESTORE_UNAVAILABLE", init);
}

/** extras：body 帶 include_orders: true 時，恢復成功後一併回傳的資料（index.ts 傳入訂單查詢）。 */
export async function restoreLiffSession(request: Request, env: Env, extras?: RestoreExtras): Promise<Response> {
  const timing = new ServerTiming();
  // 第一層：驗證 LINE token 之前只以 IP 防洪（上限寬鬆，避免共用 IP 的會員互相阻擋）
  const rateLimitResponse = await enforceRateLimit(env.API_AUTH_IP_RATE_LIMITER, "session-restore:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
  if (rateLimitResponse) return rateLimitResponse;
  if (!sessionBridgeReady(env)) return json({ error: "LIFF 持久登入尚未設定" }, { status: 503 });

  let body: { id_token?: unknown; include_orders?: unknown } | null;
  try { body = await request.json() as { id_token?: unknown; include_orders?: unknown } | null; }
  catch { return json({ error: "LIFF 驗證資料格式錯誤" }, { status: 400 }); }
  const idToken = typeof body?.id_token === "string" ? body.id_token.trim() : "";
  if (!idToken || idToken.length > 8192) return json({ error: "LIFF 驗證資料不完整" }, { status: 400 });
  const restoredExtras = body?.include_orders === true ? extras : undefined;

  // Every restore path is keyed by a LINE-verified identity; the vault and the
  // cookie only supply the refresh token for that same LINE user.
  const checked = await timing.measure("line", checkLiffIdToken(env, idToken));
  if (checked.status === "unavailable") return restoreUnavailable();
  const identity = checked.status === "valid" ? checked.identity : null;
  if (!identity?.sub) {
    return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }
  // 第二層：LINE 驗證通過後以該帳號計數，同一帳號換 IP 也無法大量呼叫
  const userRateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `session-restore-user:${identity.sub}`);
  if (userRateLimitResponse) return userRateLimitResponse;

  // cookie 優先：只有 vault 寫不進去時才把 token 放進 cookie（成功寫入 vault 會清掉 cookie），所以 cookie 存在時一定比 vault 新。
  // 先用 vault 可能拿到已輪替的舊 token，被 Supabase 視為重複使用而撤銷整條登入。
  const clearCookie = { "Set-Cookie": clearRefreshSessionCookie() };
  // cookie 確定不可用（解不開、被拒）時的回應；vault 也無法恢復才回傳
  let cookieFailure: Response | null = null;
  const sealedCookie = readRefreshSessionCookie(request);
  if (sealedCookie) {
    const result = await timing.measure("refresh", restoreSealedSession(env, sealedCookie, identity.sub));
    if (result.ok) return persistedSessionResponse(env, identity.sub, result.user, result.refreshed, timing, restoredExtras);
    if (result.reason === "unavailable") {
      // Supabase 暫時故障：不改試較舊的 vault；token 已輪替時把新 token 存回 cookie
      if (!result.rotated) return restoreUnavailable();
      const sealed = await sealRefreshToken(env.AUTH_SESSION_SECRET!, result.rotated.refresh_token);
      return restoreUnavailable({ headers: { "Set-Cookie": refreshSessionCookie(sealed) } });
    }
    if (result.reason === "mismatch") return json({ error: "LIFF LINE 身分與保存的會員登入不一致", code: "LIFF_SESSION_MISMATCH" }, { status: 409, headers: clearCookie });
    cookieFailure = result.reason === "invalid"
      ? json({ error: "登入工作階段無效", code: "INVALID_PERSISTENT_SESSION" }, { status: 401, headers: clearCookie })
      : json({ error: "會員登入工作階段已失效" }, { status: 401, headers: clearCookie });
  }

  const vaulted = await timing.measure("vault", readVaultedSession(env, identity.sub));
  if (vaulted.status === "found") {
    const result = await timing.measure("refresh", restoreSealedSession(env, vaulted.sealed, identity.sub));
    if (result.ok) return persistedSessionResponse(env, identity.sub, result.user, result.refreshed, timing, restoredExtras);
    // 只有確定無效（解不開、身分不符）才刪除；token 被拒可能是暫時狀態，下次 LINE Login 也會覆寫
    if (result.reason === "invalid" || result.reason === "mismatch") await deleteVaultedSession(env, identity.sub, vaulted.sealed);
    if (result.reason === "unavailable") {
      if (!result.rotated) return restoreUnavailable(cookieFailure ? { headers: clearCookie } : undefined);
      // vault 的 token 已在本次輪替：存回輪替後的 token 再回 503
      const sealed = await sealRefreshToken(env.AUTH_SESSION_SECRET!, result.rotated.refresh_token);
      if (await replaceVaultedToken(env, identity.sub, sealed, vaulted.sealed)) return restoreUnavailable(cookieFailure ? { headers: clearCookie } : undefined);
      // vault 也寫不進去：新 token 改放 cookie（下次優先使用），並盡量刪掉 vault 內已失效的舊 token
      await deleteVaultedSession(env, identity.sub, vaulted.sealed);
      return restoreUnavailable({ headers: { "Set-Cookie": refreshSessionCookie(sealed) } });
    }
  }
  // 任一來源暫時讀不到時回 503，而不是「沒有工作階段」
  if (vaulted.status === "unavailable") return restoreUnavailable(cookieFailure ? { headers: clearCookie } : undefined);
  if (cookieFailure) return cookieFailure;
  return json({ error: "沒有可恢復的登入工作階段", code: "NO_PERSISTENT_SESSION" }, { status: 401 });
}

export async function forgetLiffSession(): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": clearRefreshSessionCookie() } });
}

function memberAuthUnavailable() {
  return json({ error: "會員驗證暫時無法完成，請稍後再試", code: "AUTH_UNAVAILABLE" }, { status: 503 });
}

export async function requireUser(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authorization = bearerToken(request);
  if (!authorization) return json({ error: "需要會員登入" }, { status: 401 });
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "會員系統尚未設定" }, { status: 503 });
  // 只有 Supabase 確定拒絕 token 才回 401；限流、5xx 與逾時回 503，前端不會因此把會員登出
  let response: Response;
  try {
    response = await fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization }
    });
  } catch {
    return memberAuthUnavailable();
  }
  if (isTransientStatus(response.status)) return memberAuthUnavailable();
  if (!response.ok) return json({ error: "登入已過期，請重新登入" }, { status: 401 });
  const user = await response.json() as AuthUser;
  if (env.LINE_AUTH_ENABLED === "true" && !hasLineIdentity(user, env)) return json({ error: "本網站僅接受 LINE 會員登入" }, { status: 403 });
  return { authorization, user };
}

export async function requireAdmin(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "管理服務尚未設定" }, { status: 503 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/profiles?select=is_admin,line_user_id&id=eq.${authResult.user.id}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "無法確認管理員權限" }, { status: 503 });
  const rows = await response.json() as Array<{ is_admin?: boolean; line_user_id?: string | null }>;
  if (!rows[0]?.is_admin) return json({ error: "僅限管理員使用" }, { status: 403 });
  const authenticatedLineId = lineIdentityId(authResult.user, env);
  if (!authenticatedLineId || !rows[0].line_user_id || rows[0].line_user_id.toLowerCase() !== authenticatedLineId.toLowerCase()) return json({ error: "管理員 LINE 身分尚未綁定，請重新登入", code: "ADMIN_LINE_ID_MISMATCH" }, { status: 403 });
  const rateLimitResponse = await enforceRateLimit(env.API_ADMIN_RATE_LIMITER, `admin:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  return authResult;
}

async function syncLineIdentity(env: Env, user: AuthUser) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, synced: false };
  // `user_metadata` is editable by the signed-in user. Only use provider identity
  // data and never overwrite an existing binding from a later client request.
  const lineId = lineIdentityId(user, env);
  if (!lineId) return { ok: true, synced: false };
  const profileUrl = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("id", `eq.${user.id}`);
  profileUrl.searchParams.set("line_user_id", "is.null");
  const response = await fetchWithTimeout(profileUrl, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ line_user_id: lineId })
  });
  return { ok: response.ok, synced: response.ok };
}

export async function syncMemberIdentity(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `identity-sync:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  let result: { ok: boolean; synced: boolean };
  try { result = await syncLineIdentity(env, authResult.user); }
  catch { return json({ error: "會員身分同步暫時無法完成" }, { status: 503 }); }
  if (!result.ok) return json({ error: "會員身分同步暫時無法完成" }, { status: 503 });
  return json({ ok: true, synced: result.synced });
}
