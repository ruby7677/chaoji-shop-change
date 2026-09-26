// LINE 身分驗證、LIFF 持久登入（vault／cookie）與會員／管理員授權檢查。
import { type SupabaseRefreshSession, clearRefreshSessionCookie, openRefreshToken, readRefreshSessionCookie, refreshSessionCookie, refreshSupabaseSession, sealRefreshToken } from "./auth-session";
import { deleteVaultedSession, readVaultedSession, storeVaultedSession } from "./liff-session-vault";
import { type AuthUser, type Env } from "./env";
import { bearerToken, enforceRateLimit, fetchWithTimeout, json, serviceHeaders } from "./http";

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

async function verifyLiffIdToken(env: Env, idToken: string): Promise<VerifiedLiffIdentity | null> {
  const channelId = env.LINE_LOGIN_CHANNEL_ID?.trim();
  if (!channelId) return null;
  const response = await fetchWithTimeout("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });
  if (!response.ok) return null;
  const payload = await response.json() as VerifiedLiffIdentity;
  const expiresAt = Number(payload.exp || 0) * 1000;
  if (
    payload.iss !== "https://access.line.me"
    || payload.aud !== channelId
    || typeof payload.sub !== "string"
    || !/^U[0-9a-f]{32}$/i.test(payload.sub)
    || !Number.isFinite(expiresAt)
    || expiresAt <= Date.now()
  ) return null;
  return payload;
}

export async function verifyLiffIdentity(request: Request, env: Env): Promise<Response> {
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `liff:${request.headers.get("CF-Connecting-IP") || "unknown"}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.LINE_LOGIN_CHANNEL_ID || !env.LIFF_ID) return json({ error: "LIFF 尚未設定" }, { status: 503 });
  let body: { id_token?: unknown } | null;
  try { body = await request.json() as { id_token?: unknown } | null; }
  catch { return json({ error: "LIFF 驗證資料格式錯誤" }, { status: 400 }); }
  const idToken = typeof body?.id_token === "string" ? body.id_token.trim() : "";
  if (!idToken || idToken.length > 8192) return json({ error: "LIFF 驗證資料不完整" }, { status: 400 });
  const identity = await verifyLiffIdToken(env, idToken);
  if (!identity?.sub) return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401 });
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

export async function refreshedAuthUser(env: Env, session: SupabaseRefreshSession): Promise<AuthUser | null> {
  if (session.user && typeof session.user === "object") return session.user as AuthUser;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetchWithTimeout(env.SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + session.access_token }
  });
  if (!response.ok) return null;
  return await response.json() as AuthUser;
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
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, "session-remember:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
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

  const identity = await verifyLiffIdToken(env, idToken);
  if (!identity?.sub) return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401 });
  const refreshed = await refreshSupabaseSession(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, refreshToken);
  if (!refreshed) {
    return json({ error: "會員登入工作階段已失效" }, { status: 401, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }
  const user = await validateRefreshedLineSession(env, refreshed, identity.sub);
  if (!user) {
    return json({ error: "LIFF LINE 身分與會員登入不一致" }, { status: 409, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }

  return persistedSessionResponse(env, identity.sub, user, refreshed);
}

// The vault is the canonical store once available. Keeping the same refresh
// token lineage in both a cookie and the vault would let an old copy be reused
// after rotation, which Supabase treats as token reuse and revokes the session.
async function persistedSessionResponse(env: Env, lineUserId: string, user: AuthUser, refreshed: SupabaseRefreshSession) {
  const sealed = await sealRefreshToken(env.AUTH_SESSION_SECRET!, refreshed.refresh_token);
  const vaulted = await storeVaultedSession(env, lineUserId, user.id, sealed);
  return json({
    access_token: refreshed.access_token,
    expires_in: Number(refreshed.expires_in || 0),
    user_id: user.id
  }, { headers: { "Set-Cookie": vaulted ? clearRefreshSessionCookie() : refreshSessionCookie(sealed) } });
}

type SealedSessionResult =
  | { ok: true; user: AuthUser; refreshed: SupabaseRefreshSession }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" };

async function restoreSealedSession(env: Env, sealed: string, lineUserId: string): Promise<SealedSessionResult> {
  const refreshToken = await openRefreshToken(env.AUTH_SESSION_SECRET!, sealed);
  if (!refreshToken) return { ok: false, reason: "invalid" };
  const refreshed = await refreshSupabaseSession(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, refreshToken);
  if (!refreshed) return { ok: false, reason: "expired" };
  const user = await validateRefreshedLineSession(env, refreshed, lineUserId);
  if (!user) return { ok: false, reason: "mismatch" };
  return { ok: true, user, refreshed };
}

export async function restoreLiffSession(request: Request, env: Env): Promise<Response> {
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, "session-restore:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
  if (rateLimitResponse) return rateLimitResponse;
  if (!sessionBridgeReady(env)) return json({ error: "LIFF 持久登入尚未設定" }, { status: 503 });

  let body: { id_token?: unknown } | null;
  try { body = await request.json() as { id_token?: unknown } | null; }
  catch { return json({ error: "LIFF 驗證資料格式錯誤" }, { status: 400 }); }
  const idToken = typeof body?.id_token === "string" ? body.id_token.trim() : "";
  if (!idToken || idToken.length > 8192) return json({ error: "LIFF 驗證資料不完整" }, { status: 400 });

  // Every restore path is keyed by a LINE-verified identity; the vault and the
  // cookie only supply the refresh token for that same LINE user.
  const identity = await verifyLiffIdToken(env, idToken);
  if (!identity?.sub) {
    return json({ error: "LIFF LINE 身分驗證失敗" }, { status: 401, headers: { "Set-Cookie": clearRefreshSessionCookie() } });
  }

  const vaulted = await readVaultedSession(env, identity.sub);
  if (vaulted.status === "found") {
    const result = await restoreSealedSession(env, vaulted.sealed, identity.sub);
    if (result.ok) return persistedSessionResponse(env, identity.sub, result.user, result.refreshed);
    // Keep the row on a refresh failure: it may be a transient Supabase error,
    // and the next successful LINE Login overwrites it anyway.
    if (result.reason !== "expired") await deleteVaultedSession(env, identity.sub);
  }

  const sealedCookie = readRefreshSessionCookie(request);
  if (!sealedCookie) return json({ error: "沒有可恢復的登入工作階段", code: "NO_PERSISTENT_SESSION" }, { status: 401 });
  const result = await restoreSealedSession(env, sealedCookie, identity.sub);
  if (result.ok) return persistedSessionResponse(env, identity.sub, result.user, result.refreshed);
  const clearCookie = { "Set-Cookie": clearRefreshSessionCookie() };
  if (result.reason === "invalid") return json({ error: "登入工作階段無效", code: "INVALID_PERSISTENT_SESSION" }, { status: 401, headers: clearCookie });
  if (result.reason === "expired") return json({ error: "會員登入工作階段已失效" }, { status: 401, headers: clearCookie });
  return json({ error: "LIFF LINE 身分與保存的會員登入不一致", code: "LIFF_SESSION_MISMATCH" }, { status: 409, headers: clearCookie });
}

export async function forgetLiffSession(): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": clearRefreshSessionCookie() } });
}

export async function requireUser(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authorization = bearerToken(request);
  if (!authorization) return json({ error: "需要會員登入" }, { status: 401 });
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "會員系統尚未設定" }, { status: 503 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization }
  });
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
