import {
  buildBirthdayCouponMessage,
  buildLineBirthdayFlexMessage,
  buildLineOrderFlexMessage,
  buildLowStockMessage,
  buildOrderNotificationMessage,
  buildTelegramOrderNotificationMessage,
  buildTelegramTestMessage,
  routeOrderNotificationRecipients,
  type LinePushMessage,
  type OrderNotificationEventType
} from "./line-notification-messages";
import {
  clearRefreshSessionCookie,
  openRefreshToken,
  readRefreshSessionCookie,
  refreshSessionCookie,
  refreshSupabaseSession,
  sealRefreshToken,
  type SupabaseRefreshSession
} from "./auth-session";
import { deleteVaultedSession, readVaultedSession, storeVaultedSession } from "./liff-session-vault";
import { createProductShowcase, isShowcaseImageUpload } from "./product-showcase";
import { createWebSession } from "./web-session";
import { loadAdminOverview } from "./admin-overview";
import { isShareMetaRequest, withShareMeta } from "./share-meta";
import { IMAGE_CACHE_CONTROL, IMAGE_STALE_VERSION_CACHE_CONTROL, PRODUCT_IMAGE_BUCKET, PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_TYPES, hasImageSignature, imageContentType, productImageCacheKey, productImageEdgeCache, purgeProductImageCache, requestedImageVersion, storageObjectUrl } from "./product-image-storage";
import {
  deliverLineNotification,
  deliverTelegramNotification,
  retryDueNotificationDeliveries,
  type DeliveryResult
} from "./notification-delivery";

interface Env {
  ASSETS: Fetcher;
  STORE_NAME: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_CUSTOM_PROVIDER?: string;
  LINE_AUTH_ENABLED?: string;
  LIFF_ID?: string;
  LINE_LOGIN_CHANNEL_ID?: string;
  AUTH_SESSION_SECRET?: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
  LINE_NOTIFY_ENABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_CHAT_IDS?: string;
  TELEGRAM_NOTIFY_ENABLED?: string;
  API_ORDER_RATE_LIMITER?: RateLimit;
  API_MEMBER_RATE_LIMITER?: RateLimit;
  API_ADMIN_RATE_LIMITER?: RateLimit;
}

type Product = {
  id: string;
  category: string;
  name: string;
  product_id?: string;
  product_name?: string;
  description?: string;
  variant_name?: string;
  purchase_limit?: number | null;
  points_eligible?: boolean;
  compare_at_price?: number | null;
  price: number;
  stock: number;
  type: "現貨" | "預購";
  preorder_arrival?: string;
  seller_link?: string;
  image_url?: string;
  hero_rank?: number | null;
  hero_tagline?: string | null;
};

type AuthUser = {
  id: string;
  user_metadata?: Record<string, unknown>;
  identities?: Array<{ provider?: string; identity_data?: Record<string, unknown> }>;
};

const demoProducts: Product[] = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' https://static.line-scdn.net; style-src 'self' 'sha256-L0NsGOdCgMq8WQ+53SoJ4y/OJrxNakwWYcLt+wUiWoE='; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co https://api.line.me https://access.line.me https://liff.line.me https://liffsdk.line-scdn.net; form-action 'self'; upgrade-insecure-requests",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000"
};

function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Cache-Control", "no-store");
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return Response.json(data, { ...init, headers });
}

const MAX_JSON_REQUEST_BYTES = 128 * 1024;
const MAX_ORDER_ITEMS = 50;
const MAX_ITEM_QUANTITY = 100;
const MAX_CART_ITEMS = 50;
const LINE_FRIEND_VERIFICATION_TTL_SECONDS = 15 * 60;

async function enforceRateLimit(limiter: RateLimit | undefined, key: string): Promise<Response | null> {
  if (!limiter) return null;
  try {
    const outcome = await limiter.limit({ key });
    return outcome.success ? null : json({ error: "請求過於頻繁，請稍後再試" }, { status: 429, headers: { "Retry-After": "60" } });
  } catch {
    return json({ error: "安全限制服務暫時無法使用，請稍後再試" }, { status: 503 });
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith("Bearer ") ? authorization : null;
}

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

function hasLineIdentity(user: AuthUser, env: Env) {
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
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
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

async function verifyLiffIdentity(request: Request, env: Env): Promise<Response> {
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

async function refreshedAuthUser(env: Env, session: SupabaseRefreshSession): Promise<AuthUser | null> {
  if (session.user && typeof session.user === "object") return session.user as AuthUser;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(env.SUPABASE_URL + "/auth/v1/user", {
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

async function rememberLiffSession(request: Request, env: Env): Promise<Response> {
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

async function restoreLiffSession(request: Request, env: Env): Promise<Response> {
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

async function forgetLiffSession(): Promise<Response> {
  return json({ ok: true }, { headers: { "Set-Cookie": clearRefreshSessionCookie() } });
}

async function requireUser(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authorization = bearerToken(request);
  if (!authorization) return json({ error: "需要會員登入" }, { status: 401 });
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "會員系統尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization }
  });
  if (!response.ok) return json({ error: "登入已過期，請重新登入" }, { status: 401 });
  const user = await response.json() as AuthUser;
  if (env.LINE_AUTH_ENABLED === "true" && !hasLineIdentity(user, env)) return json({ error: "本網站僅接受 LINE 會員登入" }, { status: 403 });
  return { authorization, user };
}

async function requireAdmin(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "管理服務尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=is_admin,line_user_id&id=eq.${authResult.user.id}`, {
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

function serviceHeaders(env: Env, prefer?: string) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
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
  const response = await fetch(profileUrl, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ line_user_id: lineId })
  });
  return { ok: response.ok, synced: response.ok };
}

async function syncMemberIdentity(request: Request, env: Env): Promise<Response> {
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

function lineFriendVerificationIsFresh(value: string | null | undefined) {
  const verifiedAt = value ? Date.parse(value) : NaN;
  return Number.isFinite(verifiedAt) && Date.now() - verifiedAt <= LINE_FRIEND_VERIFICATION_TTL_SECONDS * 1000;
}

async function setLineFriendVerification(env: Env, userId: string, verified: boolean) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  url.searchParams.set("id", `eq.${userId}`);
  const response = await fetch(url, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ line_friend_verified_at: verified ? new Date().toISOString() : null })
  });
  return response.ok;
}

const lineOrderStatusLabels: Record<string, string> = {
  pending_payment: "待付款", pending_review: "待確認款項", confirmed: "已確認付款",
  partially_ready: "部分到貨", ready_for_pickup: "配送處理中", completed: "已完成訂單",
  cancelled: "已取消", refund_pending: "退款處理中", refunded: "已退款"
};

function lineNotificationEnabled(env: Env) {
  return env.LINE_NOTIFY_ENABLED !== "false" && Boolean(env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN);
}

function telegramAdminRecipients(env: Env) {
  return [...new Set((env.TELEGRAM_ADMIN_CHAT_IDS || "").split(",").map((id) => id.trim()).filter((id) => /^-?\d+$/.test(id) || /^@[A-Za-z0-9_]{5,}$/.test(id)))];
}

function telegramNotificationEnabled(env: Env) {
  return env.TELEGRAM_NOTIFY_ENABLED !== "false" && Boolean(env.TELEGRAM_BOT_TOKEN);
}

async function notifyLine(env: Env, eventKey: string, recipientId: string, eventType: string, message: string | LinePushMessage): Promise<DeliveryResult> {
  if (!lineNotificationEnabled(env) || !recipientId) return { sent: false, handled: true };
  const payload = typeof message === "string" ? { type: "text", text: message.slice(0, 5000) } : message;
  return deliverLineNotification(env, eventKey, recipientId, eventType, payload);
}

async function notifyTelegram(env: Env, eventKey: string, chatId: string, eventType: string, message: string): Promise<DeliveryResult> {
  if (!telegramNotificationEnabled(env) || !chatId) return { sent: false, handled: true };
  return deliverTelegramNotification(env, eventKey, chatId, eventType, message);
}

async function testTelegramNotification(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (env.TELEGRAM_NOTIFY_ENABLED === "false") return json({ error: "Telegram 管理員通知目前已停用" }, { status: 503 });
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "尚未設定 TELEGRAM_BOT_TOKEN" }, { status: 503 });
  const recipients = telegramAdminRecipients(env);
  if (!recipients.length) return json({ error: "尚未設定 TELEGRAM_ADMIN_CHAT_IDS" }, { status: 503 });
  const eventKey = `telegram-test:${crypto.randomUUID()}`;
  const timestamp = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const message = buildTelegramTestMessage(env.STORE_NAME, timestamp);
  const results = await Promise.allSettled(recipients.map(async (chatId) => notifyTelegram(env, `${eventKey}:${chatId}`, chatId, "telegram_test", message)));
  const sent = results.filter((result) => result.status === "fulfilled" && result.value.sent).length;
  if (!sent) return json({ error: "Telegram 測試通知未送出，請確認 Bot token、管理員 chat ID，並先與 Bot 開始對話" }, { status: 502 });
  return json({ ok: true, sent, total: recipients.length, message: `Telegram 測試通知已送出 ${sent}/${recipients.length} 位管理員` });
}

async function loadOrderNotification(env: Env, orderId: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id,order_number,status,delivery_method,bank_account_id,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,paid_amount,final_payment_last_five,final_payment_confirmed_at,updated_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,profiles!orders_member_id_fkey(full_name,line_user_id,is_admin),order_items(product_name,variant_name,quantity,kind)");
  url.searchParams.set("id", `eq.${orderId}`);
  const response = await fetch(url, { headers: serviceHeaders(env) });
  if (!response.ok) return null;
  const rows = await response.json() as unknown[];
  return rows[0] as { order_number: string; status: string; delivery_method?: string; bank_account_id?: string | null; shipping_fee?: number; shipping_address?: string | null; shipping_recipient_name?: string | null; shipping_phone?: string | null; shipping_fee_notified_at?: string | null; paid_amount?: number; final_payment_last_five?: string | null; final_payment_confirmed_at?: string | null; updated_at?: string; subtotal: number; coupon_discount: number; point_discount: number; amount_due: number; deposit_due: number; payment_deadline: string; profiles?: { full_name?: string; line_user_id?: string; is_admin?: boolean }; order_items?: Array<{ product_name: string; variant_name: string; quantity: number; kind?: string }> };
}

/** Resolves true once every recipient's notification is sent or owned by the delivery state machine. */
async function notifyOrderEvent(env: Env, orderId: string, eventType: OrderNotificationEventType): Promise<boolean> {
  const order = await loadOrderNotification(env, orderId);
  if (!order) return false;
  const items = (order.order_items || []).map((item) => `${item.product_name}${item.variant_name === "單一規格" ? "" : ` · ${item.variant_name}`} ×${item.quantity}`).join("、");
  const hasPreorder = (order.order_items || []).some((item) => item.kind === "preorder");
  const deliveryLabels: Record<string, string> = { store_pickup: "到店取貨", seller_delivery: "賣貨便", home_delivery: "宅配" };
  const deliveryLine = deliveryLabels[order.delivery_method || "store_pickup"] || "到店取貨";
  const paymentLine = order.delivery_method === "seller_delivery" ? "賣貨便付款（外部）" : order.bank_account_id ? "匯款／轉帳" : "到店支付";
  const orderMessageData = {
    storeName: env.STORE_NAME,
    eventType,
    orderStatus: order.status,
    statusLabel: lineOrderStatusLabels[order.status] || order.status,
    orderNumber: order.order_number,
    items,
    deliveryLine,
    paymentLine,
    hasPreorder,
    amountDue: order.amount_due,
    depositDue: order.deposit_due,
    paidAmount: order.paid_amount ?? order.deposit_due,
    shippingFee: order.shipping_fee ?? 0,
    finalPaymentConfirmed: Boolean(order.final_payment_confirmed_at),
    shippingRecipientName: order.shipping_recipient_name,
    shippingPhone: order.shipping_phone,
    shippingAddress: order.shipping_address
  };
  const message = buildOrderNotificationMessage(orderMessageData);
  if (!message) return true;
  const lineMessage = buildLineOrderFlexMessage(orderMessageData, message);
  const telegramMessage = buildTelegramOrderNotificationMessage(message, order.profiles?.full_name);
  const suppressAdminMemberLine = eventType === "status_changed"
    && order.status === "confirmed"
    && order.delivery_method === "seller_delivery"
    && !hasPreorder
    && order.profiles?.is_admin === true;
  const eventKey = eventType === "status_changed"
    ? `${eventType}:${orderId}:${order.status}:${order.updated_at || "current"}`
    : eventType === "fulfillment_updated"
      ? `${eventType}:${orderId}:${order.updated_at || "current"}`
      : `${eventType}:${orderId}`;
  const routing = routeOrderNotificationRecipients(eventType, order.profiles?.line_user_id, telegramAdminRecipients(env), suppressAdminMemberLine);
  const tasks: Promise<DeliveryResult>[] = routing.telegramRecipients.map((chatId) => notifyTelegram(env, eventKey, chatId, `order_${eventType}`, telegramMessage));
  // 會員回報匯款只通知 Telegram 管理員；一般會員狀態走 LINE，管理員本人賣貨便備貨確認只保留 Telegram。
  tasks.push(...routing.lineRecipients.map((recipientId) => notifyLine(env, eventKey, recipientId, `order_${eventType}`, lineMessage)));
  const results = await Promise.allSettled(tasks);
  return results.every((result) => result.status === "fulfilled" && result.value.handled);
}

async function notifyLowStock(env: Env) {
  const recipients = telegramAdminRecipients(env);
  if (!telegramNotificationEnabled(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !recipients.length) return;
  const base = env.SUPABASE_URL;
  const headers = serviceHeaders(env);
  const [variantsResponse, statesResponse] = await Promise.all([
    fetch(`${base}/rest/v1/product_variants?select=id,name,sku,stock_on_hand,safety_stock,is_published,products(name)&is_published=eq.true&order=stock_on_hand.asc`, { headers }),
    fetch(`${base}/rest/v1/line_low_stock_states?select=variant_id,last_notified_stock,last_notified_at`, { headers })
  ]);
  if (!variantsResponse.ok || !statesResponse.ok) return;
  const variants = await variantsResponse.json() as Array<{ id: string; name: string; sku: string; stock_on_hand: number; safety_stock: number; products?: { name?: string } }>;
  const states = await statesResponse.json() as Array<{ variant_id: string; last_notified_stock: number | null }>;
  const stateMap = new Map(states.map((state) => [state.variant_id, state]));
  const low = variants.filter((variant) => variant.stock_on_hand <= variant.safety_stock);
  const toNotify = low.filter((variant) => {
    const previous = stateMap.get(variant.id)?.last_notified_stock;
    return previous == null || variant.stock_on_hand < previous;
  });
  for (const variant of variants.filter((item) => item.stock_on_hand > item.safety_stock && stateMap.has(item.id))) {
    await fetch(`${base}/rest/v1/line_low_stock_states?variant_id=eq.${variant.id}`, { method: "PATCH", headers: serviceHeaders(env, "return=minimal"), body: JSON.stringify({ last_notified_stock: null, last_notified_at: null, updated_at: new Date().toISOString() }) });
  }
  if (!toNotify.length) return;
  const lines = toNotify.map((variant) => `• ${variant.products?.name || "商品"} · ${variant.name} (${variant.sku})：剩 ${variant.stock_on_hand} 件`);
  const eventKey = `low-stock:${new Date().toISOString().slice(0, 10)}:${toNotify.map((item) => `${item.id}-${item.stock_on_hand}`).join(",")}`;
  const sent = await Promise.all(recipients.map((chatId) => notifyTelegram(env, eventKey, chatId, "low_stock", buildLowStockMessage(env.STORE_NAME, lines))));
  if (sent.some((result) => result.sent)) {
    for (const variant of toNotify) {
      await fetch(`${base}/rest/v1/line_low_stock_states`, { method: "POST", headers: serviceHeaders(env, "resolution=merge-duplicates,return=minimal"), body: JSON.stringify({ variant_id: variant.id, last_notified_stock: variant.stock_on_hand, last_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
    }
  }
}

async function notifyBirthdayCoupons(env: Env) {
  if (!lineNotificationEnabled(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/coupons`);
  url.searchParams.set("select", "id,code,name,discount_amount,coupon_members(member_id,profiles(line_user_id))");
  url.searchParams.set("is_birthday", "eq.true");
  url.searchParams.set("created_at", `gte.${start.toISOString()}`);
  const response = await fetch(url, { headers: serviceHeaders(env) });
  if (!response.ok) return;
  const coupons = await response.json() as Array<{ id: string; code: string; name: string; discount_amount: number; coupon_members?: Array<{ profiles?: { line_user_id?: string } }> }>;
  for (const coupon of coupons) for (const member of coupon.coupon_members || []) if (member.profiles?.line_user_id) {
    const couponData = { name: coupon.name, code: coupon.code, discountAmount: coupon.discount_amount };
    const altText = buildBirthdayCouponMessage(env.STORE_NAME, couponData);
    await notifyLine(env, `birthday:${coupon.id}`, member.profiles.line_user_id, "birthday_coupon", buildLineBirthdayFlexMessage(env.STORE_NAME, couponData, altText));
  }
}

const CANCELLED_ORDER_SWEEP_PAGE_SIZE = 50;
const CANCELLED_ORDER_SWEEP_MAX_PAGES = 4;

async function notifyRecentlyCancelledOrders(env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  // Only cancelled orders not yet handed to the delivery state machine are
  // walked; `cancellation_notified_at` is set once every recipient has a claim
  // row, after which the 5-minute retry cron owns failures. Orders whose claims
  // could not be recorded stay unmarked and are offered again next hour. The
  // keyset cursor skips them within this run, and the page cap keeps a backlog
  // from exhausting one invocation's subrequests.
  const headers = serviceHeaders(env);
  let lastCancelledAt: string | null = null;
  let lastId: string | null = null;
  for (let page = 0; page < CANCELLED_ORDER_SWEEP_MAX_PAGES; page += 1) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
    url.searchParams.set("select", "id,cancelled_at");
    url.searchParams.set("status", "eq.cancelled");
    url.searchParams.set("cancelled_at", "not.is.null");
    url.searchParams.set("cancellation_notified_at", "is.null");
    url.searchParams.set("order", "cancelled_at.asc,id.asc");
    url.searchParams.set("limit", String(CANCELLED_ORDER_SWEEP_PAGE_SIZE));
    if (lastCancelledAt && lastId) {
      url.searchParams.set("or", `(cancelled_at.gt.${lastCancelledAt},and(cancelled_at.eq.${lastCancelledAt},id.gt.${lastId}))`);
    }
    const response = await fetch(url, { headers });
    if (!response.ok) return;
    const rows = await response.json() as Array<{ id?: string; cancelled_at?: string | null }>;
    const validRows = rows.filter((row): row is { id: string; cancelled_at: string } => typeof row.id === "string" && typeof row.cancelled_at === "string");
    if (!validRows.length) return;
    const outcomes = await Promise.allSettled(validRows.map((row) => notifyOrderEvent(env, row.id, "status_changed")));
    const handledIds = validRows
      .filter((_row, index) => {
        const outcome = outcomes[index];
        return outcome.status === "fulfilled" && outcome.value;
      })
      .map((row) => row.id);
    if (handledIds.length) {
      const markUrl = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
      markUrl.searchParams.set("id", `in.(${handledIds.join(",")})`);
      markUrl.searchParams.set("status", "eq.cancelled");
      markUrl.searchParams.set("cancellation_notified_at", "is.null");
      await fetch(markUrl, {
        method: "PATCH",
        headers: serviceHeaders(env, "return=minimal"),
        body: JSON.stringify({ cancellation_notified_at: new Date().toISOString() })
      });
    }
    if (validRows.length < CANCELLED_ORDER_SWEEP_PAGE_SIZE) return;
    const last = validRows[validRows.length - 1];
    lastCancelledAt = last.cancelled_at;
    lastId = last.id;
  }
}

async function runScheduledNotifications(env: Env) {
  await notifyRecentlyCancelledOrders(env);
  await notifyBirthdayCoupons(env);
  await notifyLowStock(env);
}

const databaseErrors: Record<string, string> = {
  LOGIN_REQUIRED: "需要會員登入",
  PROFILE_INCOMPLETE: "請先完成姓名與手機資料",
  INVALID_PICKUP_PLAN: "取貨方式不正確",
  INVALID_DELIVERY_METHOD: "取貨方式不正確",
  INVALID_SHIPPING_UNITS: "商品裝箱設定不正確",
  SHIPPING_SETTINGS_NOT_FOUND: "配送設定尚未完成",
  INVALID_SHIPPING_SETTINGS: "配送設定不正確",
  SHIPPING_ADDRESS_REQUIRED: "宅配請填寫收件地址",
  SHIPPING_RECIPIENT_REQUIRED: "宅配請填寫收件人姓名",
  SHIPPING_PHONE_REQUIRED: "宅配請填寫有效的收件人手機號碼",
  INVALID_DISCOUNT: "折扣資料不正確",
  EMPTY_CART: "購物車不可為空",
  BANK_ACCOUNT_REQUIRED: "請選擇收款帳戶",
  INVALID_PAYMENT_METHOD: "付款方式不正確",
  STORE_PAYMENT_BANK_TRANSFER_ONLY: "本站到店取貨與宅配訂單僅接受匯款／轉帳",
  STORE_PAYMENT_ONLY_STORE_PICKUP: "本站到店取貨與宅配訂單僅接受匯款／轉帳",
  STORE_PAYMENT_PREORDER_NOT_ALLOWED: "預購商品必須先匯款支付訂金",
  SELLER_BANK_PREORDER_ONLY: "賣貨便匯款訂單僅適用預購商品",
  MIXED_ORDER_NOT_ALLOWED: "現貨與預購需分開建立訂單，請回購物車分組結帳",
  CART_TOO_LARGE: "購物車品項數量超過上限",
  CART_ITEM_INVALID: "購物車商品資料不正確",
  CART_DUPLICATE_ITEM: "購物車中不可重複相同商品規格",
  CART_PRODUCT_NOT_FOUND: "購物車內有商品已下架，請重新整理",
  INVALID_BANK_ACCOUNT: "收款帳戶無效或已停用",
  INVALID_PAYMENT_LAST_FIVE: "匯款帳號末五碼格式不正確",
  INVALID_FINAL_PAYMENT_LAST_FIVE: "尾款匯款末五碼格式不正確",
  INVALID_SHIPPING_FEE: "實際運費必須是 0 或正整數",
  SHIPPING_FEE_STORE_PICKUP: "到店取貨不可設定寄送運費",
  SELLER_DELIVERY_NO_SHIPPING_FEE: "賣貨便運費由 7-11 向客戶收取，不計入訂單",
  SELLER_DELIVERY_EXTERNAL_ONLY: "賣貨便請前往 7-ELEVEN 賣貨便完成結帳，本站不建立賣貨便訂單",
  FINAL_PAYMENT_REQUIRED: "請填寫尾款匯款末五碼並確認尾款與運費已入帳",
  FINAL_PAYMENT_NOT_ALLOWED: "訂單尚未進入可出貨或可取貨狀態",
  ORDER_FULFILLMENT_NOT_EDITABLE: "此訂單目前不可修改尾款或運費資訊",
  INVALID_QUANTITY: "商品數量不正確",
  PRODUCT_NOT_FOUND: "商品已下架或不存在",
  INSUFFICIENT_STOCK: "商品庫存不足，請重新整理購物車",
  ORDER_NOT_PAYABLE: "訂單已逾期、已回報付款或無法付款",
  LINE_FRIEND_REQUIRED: "請先加入官方 LINE，並重新檢查好友狀態",
  ORDER_RATE_LIMITED: "近期建立訂單次數過多，請稍後再試",
  PENDING_ORDER_LIMIT: "目前待處理訂單已達上限，請等待客服確認",
  PURCHASE_LIMIT_EXCEEDED: "已達此商品的會員限購數量",
  DUPLICATE_ORDER_ITEM: "購物車中不可重複相同商品規格",
  REQUEST_BODY_TOO_LARGE: "請求內容過大，請縮減購物車或欄位內容",
  ADMIN_REQUIRED: "僅限管理員使用",
  REQUIRED_FIELDS_MISSING: "請填寫所有必填欄位",
  INVALID_NUMBER: "價格或庫存數量不正確",
  INVALID_PURCHASE_LIMIT: "限購數量必須為正整數或不限購",
  INVALID_DEPOSIT_RATE: "訂金比例不正確",
  PREORDER_DEPOSIT_MUST_BE_HALF: "預購商品訂金比例必須為 50%",
  ZERO_ADJUSTMENT: "庫存異動數量不可為 0",
  REASON_REQUIRED: "請填寫庫存異動原因",
  VARIANT_NOT_FOUND: "找不到商品規格",
  NEGATIVE_STOCK: "庫存不可小於 0",
  BELOW_RESERVED_STOCK: "調整後庫存不可低於已保留數量",
  ORDER_NOT_FOUND: "找不到訂單",
  ORDER_STATUS_UNCHANGED: "訂單狀態沒有變更",
  INVALID_ORDER_TRANSITION: "此訂單目前不可切換到指定狀態",
  SELLER_DELIVERY_SHIPPED_REQUIRES_REFUND: "賣貨便已進入出貨狀態，請走退款與退貨驗收流程",
  ORDER_NOTE_REQUIRED: "取消或退款相關操作必須填寫原因",
  PARTIAL_READY_REQUIRES_SPLIT: "只有分批取貨訂單可標記為部分可取貨",
  PAYMENT_REPORT_REQUIRED: "會員尚未回報匯款末五碼",
  MEMBER_NOT_FOUND: "找不到會員",
  ZERO_POINT_ADJUSTMENT: "點數異動不可為 0",
  INSUFFICIENT_POINTS: "會員點數不足，無法扣除",
  INVALID_POINT_SETTINGS: "點數規則設定不正確",
  DISCOUNTS_NOT_ENABLED: "點數與優惠券折抵功能尚未啟用",
  DISCOUNTS_NOT_VERIFIED: "折扣必須由系統驗證",
  INVALID_COUPON: "優惠券設定不正確",
  COUPON_CODE_EXISTS: "優惠碼已存在",
  COUPON_NOT_FOUND: "找不到優惠券",
  COUPON_EXPIRED: "優惠券已失效或尚未開始",
  COUPON_NOT_ELIGIBLE: "此優惠券不適用於這個會員",
  COUPON_PRODUCT_NOT_ELIGIBLE: "購物車中沒有符合優惠券的商品",
  COUPON_USAGE_LIMIT: "優惠券總使用次數已達上限",
  COUPON_MEMBER_LIMIT: "您已達此優惠券的使用上限",
  COUPON_POINTS_NOT_COMBINABLE: "此優惠券不可與點數併用",
  INVALID_POINTS: "點數使用數量不正確",
  POINT_MINIMUM: "未達最低點數折抵門檻",
  POINT_LIMIT_EXCEEDED: "點數折抵超過本筆訂單上限",
  INVALID_RETURN_QUANTITY: "退貨收到、可再售與報廢數量不正確",
  RETURN_EXCEEDS_SOLD_QUANTITY: "退貨收到數量不可超過原購買數量",
  RETURN_EXCEEDS_SALE_MOVEMENT: "退貨數量不可超過原扣庫存數量",
  RETURN_REQUIRES_REFUNDED_ORDER: "訂單完成退款後才能確認實際退貨",
  RETURN_ALREADY_CONFIRMED: "此商品退貨已確認，不可重複回補",
  SALE_ALREADY_RESTOCKED: "此筆銷售庫存已回補，不可重複入庫",
  SALE_MOVEMENT_NOT_FOUND: "找不到原始銷售庫存異動",
  ORDER_ITEM_NOT_FOUND: "找不到訂單商品",
  INVALID_BIRTHDAY_SETTINGS: "生日券設定不正確",
  BANK_ACCOUNT_NOT_FOUND: "找不到收款帳戶",
  CATEGORY_NOT_FOUND: "找不到商品分類",
  CATEGORY_NAME_EXISTS: "分類名稱已存在",
  INVALID_CATEGORY: "商品分類資料不正確",
  INVALID_VARIANT: "商品規格資料不正確",
  SKU_EXISTS: "SKU 已存在",
  INVALID_PRODUCT: "商品資料不正確",
  INVALID_COMPARE_AT_PRICE: "原價資料不正確",
  AUDIT_LOG_IMMUTABLE: "稽核紀錄不可修改或刪除",
  AUDIT_TARGET_REQUIRED: "稽核目標不可為空",
  INVALID_IMAGE_PATH: "商品圖片資料不正確",
  PRODUCT_IMAGE_LIMIT: "每件商品最多 10 張照片",
  PRODUCT_IMAGE_NOT_FOUND: "找不到這張商品照片",
  INVALID_IMAGE_ORDER: "照片排序與目前照片不一致，請重新整理後再試",
  INVALID_PRODUCT_SHOWCASE: "展示設定格式錯誤：介紹上限 8000 字、導購文上限 80 字、輪播排序 1–12",
  INVALID_ADMIN_ORDER_FILTER: "訂單篩選條件不正確",
  INVALID_NOTIFICATION_STATUS: "通知狀態篩選條件不正確",
  NOTIFICATION_NOT_FOUND: "找不到通知紀錄",
  NOTIFICATION_REQUEUE_NOT_ALLOWED: "只有失敗通知可以重新排入"
};

async function databaseError(response: Response) {
  let payload: { message?: string } = {};
  try { payload = await response.json() as { message?: string }; } catch { /* ignore malformed upstream errors */ }
  const matched = Object.keys(databaseErrors).find((code) => payload.message?.includes(code));
  const status = matched === "LINE_FRIEND_REQUIRED" ? 403 : response.status >= 500 ? 503 : 400;
  return json({ error: matched ? databaseErrors[matched] : "訂單服務暫時無法處理" }, { status });
}

const productShowcase = createProductShowcase<Env>({ json, serviceHeaders, requireAdmin, databaseError, securityHeaders: SECURITY_HEADERS });
const webSession = createWebSession<Env>({
  json,
  enforceRateLimit,
  lineMemberId: async (env, session) => {
    const user = await refreshedAuthUser(env, session);
    return user && hasLineIdentity(user, env) ? user.id : null;
  }
});

async function publicCatalog(env: Env): Promise<Product[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoProducts;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=id,category,name,price,compare_at_price,stock,type,preorder_arrival,seller_link,display_order,product_id,has_image,image_updated_at,product_name,description,variant_name,purchase_limit,points_eligible,hero_rank,hero_tagline&is_published=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` }
  });
  if (!response.ok) throw new Error("Unable to load catalog");
  const rows = await response.json() as Array<Product & { has_image?: boolean; image_updated_at?: string }>;
  return rows.map(({ has_image, image_updated_at, ...product }) => ({
    ...product,
    image_url: has_image && product.product_id
      ? `/api/product-images/${product.product_id}?v=${encodeURIComponent(image_updated_at || "1")}`
      : undefined
  }));
}

async function serveProductImage(request: Request, env: Env, productId: string, ctx: ExecutionContext): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  // The edge key includes the version query (see product-image-storage.ts), so
  // a changed primary image is served under a new key in every data center.
  const version = requestedImageVersion(request);
  const cacheKey = productImageCacheKey(request, productId, undefined, version);
  const edgeCache = productImageEdgeCache();
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;
  // Unpublished product images must not be exposed by guessing an old UUID.
  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=image_path,image_updated_at&id=eq.${productId}&is_published=eq.true&limit=1`, {
    headers: serviceHeaders(env)
  });
  if (!productResponse.ok) return json({ error: "圖片暫時無法載入" }, { status: 503 });
  const products = await productResponse.json() as Array<{ image_path?: string; image_updated_at?: string | null }>;
  const imagePath = products[0]?.image_path;
  const isCurrentVersion = version === (products[0]?.image_updated_at || "1");
  if (!imagePath) return json({ error: "商品尚未上傳照片" }, { status: 404 });
  const imageResponse = await fetch(storageObjectUrl(env, imagePath), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!imageResponse.ok || !imageResponse.body) return json({ error: "圖片暫時無法載入" }, { status: imageResponse.status === 404 ? 404 : 503 });
  const imageHeaders = new Headers(SECURITY_HEADERS);
  imageHeaders.set("Content-Type", imageContentType(imagePath, imageResponse.headers.get("Content-Type")));
  imageHeaders.set("Cache-Control", isCurrentVersion ? IMAGE_CACHE_CONTROL : IMAGE_STALE_VERSION_CACHE_CONTROL);
  const response = new Response(imageResponse.body, {
    headers: imageHeaders
  });
  // Only the current version enters the public cache; stale or made-up
  // versions get the current bytes with a short browser TTL instead.
  if (isCurrentVersion) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

async function uploadProductImage(request: Request, env: Env, productId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  const requestSize = Number(request.headers.get("Content-Length") || 0);
  if (requestSize > PRODUCT_IMAGE_MAX_BYTES + 256 * 1024) return json({ error: "商品照片不可超過 5MB" }, { status: 413 });

  let formData: FormData;
  try { formData = await request.formData(); }
  catch { return json({ error: "照片上傳格式錯誤" }, { status: 400 }); }
  const image = formData.get("image");
  if (!(image instanceof File)) return json({ error: "請選擇商品照片" }, { status: 400 });
  const extension = PRODUCT_IMAGE_TYPES[image.type];
  if (!extension) return json({ error: "照片僅支援 JPG、PNG 或 WebP" }, { status: 400 });
  if (!image.size || image.size > PRODUCT_IMAGE_MAX_BYTES) return json({ error: "商品照片必須小於 5MB" }, { status: 400 });
  if (!(await hasImageSignature(image, image.type))) return json({ error: "照片格式與檔案內容不一致" }, { status: 400 });

  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path,image_updated_at&id=eq.${productId}&limit=1`, { headers: serviceHeaders(env) });
  if (!productResponse.ok) return json({ error: "無法確認商品資料" }, { status: 503 });
  const productRows = await productResponse.json() as Array<{ id: string; image_path?: string; image_updated_at?: string | null }>;
  if (!productRows.length) return json({ error: "找不到商品" }, { status: 404 });
  const previousImagePath = productRows[0].image_path;
  const previousVersion = productRows[0].image_updated_at || "1";

  const imagePath = `${productId}/primary.${extension}`;
  const uploadResponse = await fetch(storageObjectUrl(env, imagePath), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": image.type,
      "x-upsert": "true"
    },
    body: image
  });
  if (!uploadResponse.ok) return json({ error: "照片上傳失敗，請稍後重試" }, { status: 502 });

  const updatedAt = new Date().toISOString();
  const updateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product_image`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_product_id: productId, p_image_path: imagePath, p_image_updated_at: updatedAt })
  });
  if (!updateResponse.ok) return databaseError(updateResponse);
  await purgeProductImageCache(request, productId, undefined, previousVersion);
  if (previousImagePath && previousImagePath !== imagePath) {
    await fetch(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}`, {
      method: "DELETE",
      headers: serviceHeaders(env),
      body: JSON.stringify({ prefixes: [previousImagePath] })
    });
  }
  return json({ image_url: `/api/product-images/${productId}?v=${encodeURIComponent(updatedAt)}` });
}

async function runtimeConfig(env: Env) {
  const provider = env.SUPABASE_CUSTOM_PROVIDER ?? "custom:line-web";
  // Supabase's public /auth/v1/settings response only reports built-in
  // providers; Custom OAuth/OIDC providers are not included in `external`.
  const lineEnabled = env.LINE_AUTH_ENABLED === "true";
  return {
    supabaseUrl: env.SUPABASE_URL ?? null,
    supabaseAnonKey: env.SUPABASE_ANON_KEY ?? null,
    lineProvider: provider,
    authEnabled: lineEnabled,
    liffId: env.LIFF_ID ?? null,
    liffEnabled: Boolean(env.LIFF_ID && env.LINE_LOGIN_CHANNEL_ID),
    adminIdentityMode: "line_user_id+is_admin"
  };
}

async function listBankAccounts(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "收款帳戶服務尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/bank_accounts?select=id,label,bank_name,account_name,account_number&is_active=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "收款帳戶暫時無法載入" }, { status: 503 });
  return json({ accounts: await response.json() });
}

async function loadOrder(env: Env, orderId: string, memberId: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,payment_last_five,bank_account_id,created_at,bank_accounts(label,bank_name,account_name,account_number),order_items(product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)");
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("member_id", `eq.${memberId}`);
  const response = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return null;
  const rows = await response.json() as unknown[];
  return rows[0] ?? null;
}

async function listOrders(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,payment_last_five,bank_account_id,created_at,bank_accounts(label,bank_name,account_name,account_number),order_items(product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)");
  url.searchParams.set("member_id", `eq.${authResult.user.id}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "50");
  const response = await fetch(url, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "訂單紀錄暫時無法載入" }, { status: 503 });
  return json({ orders: await response.json() });
}

type MemberCartRow = { variant_id: string; quantity: number; updated_at?: string };

async function listMemberCart(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `cart:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "購物車同步服務尚未設定" }, { status: 503 });
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/member_cart_items`);
  url.searchParams.set("select", "variant_id,quantity,updated_at");
  url.searchParams.set("member_id", `eq.${authResult.user.id}`);
  url.searchParams.set("order", "updated_at.desc");
  url.searchParams.set("limit", String(MAX_CART_ITEMS));
  const response = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization } });
  if (!response.ok) return json({ error: "會員購物車暫時無法載入" }, { status: 503 });
  const rows = await response.json() as MemberCartRow[];
  return json({ items: rows.map((row) => ({ variant_id: row.variant_id, quantity: row.quantity })) });
}

async function replaceMemberCart(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `cart:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "購物車同步服務尚未設定" }, { status: 503 });
  let body: { items?: Array<{ variant_id?: string; quantity?: number }> };
  try { body = await request.json(); } catch { return json({ error: "購物車資料格式錯誤" }, { status: 400 }); }
  const items = body.items;
  if (!Array.isArray(items) || items.length > MAX_CART_ITEMS) return json({ error: databaseErrors.CART_TOO_LARGE }, { status: 400 });
  const ids = new Set<string>();
  if (items.some((item) => {
    const id = item.variant_id?.trim().toLowerCase();
    if (!id || !/^[0-9a-f-]{36}$/.test(id) || !Number.isInteger(item.quantity) || (item.quantity as number) < 1 || (item.quantity as number) > MAX_ITEM_QUANTITY || ids.has(id)) return true;
    ids.add(id);
    return false;
  })) return json({ error: databaseErrors.CART_ITEM_INVALID }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/replace_member_cart`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_items: items.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity })) })
  });
  if (!response.ok) return databaseError(response);
  return json({ ok: true, items: items.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity })) });
}

async function memberPoints(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "點數服務尚未設定" }, { status: 503 });
  const headers = serviceHeaders(env);
  const [balanceResponse, ledgerResponse, settingsResponse, couponsResponse] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_point_balance`, {
      method: "POST",
      headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: authResult.authorization, "Content-Type": "application/json" },
      body: "{}"
    }),
    fetch(`${env.SUPABASE_URL}/rest/v1/point_ledger?select=id,kind,points,reason,created_at,orders(order_number)&member_id=eq.${authResult.user.id}&order=created_at.desc&limit=100`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/point_settings?select=earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value&id=eq.true`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_available_coupons`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: authResult.authorization, "Content-Type": "application/json" }, body: "{}" })
  ]);
  if (!balanceResponse.ok || !ledgerResponse.ok || !settingsResponse.ok || !couponsResponse.ok) return json({ error: "點數與優惠券資料暫時無法載入" }, { status: 503 });
  const balance = Number(await balanceResponse.json());
  const ledger = await ledgerResponse.json() as Array<{ points: number }>;
  const settings = await settingsResponse.json() as unknown[];
  return json({ balance: Number.isFinite(balance) ? balance : 0, ledger, settings: settings[0] || null, coupons: await couponsResponse.json() });
}

async function memberLineFriendship(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `friendship:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) return json({ error: "LINE 好友狀態服務尚未設定" }, { status: 503 });
  const profileUrl = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("select", "line_user_id,line_friend_verified_at");
  profileUrl.searchParams.set("id", `eq.${authResult.user.id}`);
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetch(profileUrl, { headers: serviceHeaders(env) });
  if (!profileResponse.ok) return json({ error: "無法讀取 LINE 會員資料" }, { status: 503 });
  const profiles = await profileResponse.json() as Array<{ line_user_id?: string | null; line_friend_verified_at?: string | null }>;
  const lineUserId = profiles[0]?.line_user_id;
  if (!lineUserId) return json({ friendFlag: false, reason: "LINE_ID_MISSING" });
  const lineLoginAccessToken = request.headers.get("X-LINE-Login-Access-Token")?.trim() || null;
  if (!lineLoginAccessToken) {
    // A cached verification is safe for a short window, but a Bot API profile
    // lookup alone cannot prove that this requester owns the LINE identity.
    return json(lineFriendVerificationIsFresh(profiles[0]?.line_friend_verified_at)
      ? { friendFlag: true, source: "cached" }
      : { friendFlag: false, reason: "LINE_PROVIDER_TOKEN_REQUIRED" });
  }
  if (lineLoginAccessToken.length > 4096) return json({ error: "LINE 登入授權格式不正確" }, { status: 400 });
  const [friendshipResponse, profileCheckResponse] = await Promise.all([
    fetch("https://api.line.me/friendship/v1/status", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } }),
    fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } })
  ]);
  if (friendshipResponse.ok && profileCheckResponse.ok) {
    const friendship = await friendshipResponse.json() as { friendFlag?: boolean };
    const lineProfile = await profileCheckResponse.json() as { userId?: string };
    if (lineProfile.userId !== lineUserId) return json({ error: "LINE 會員驗證不一致，請重新登入" }, { status: 401 });
    const isFriend = friendship.friendFlag === true;
    if (!await setLineFriendVerification(env, authResult.user.id, isFriend)) return json({ error: "LINE 好友驗證紀錄失敗，請稍後再試" }, { status: 503 });
    return json({ friendFlag: isFriend, source: "line_login" });
  }
  if ([401, 403].includes(friendshipResponse.status) || [401, 403].includes(profileCheckResponse.status)) return json({ error: "LINE 登入授權已過期，請重新登入" }, { status: 401 });
  return json({ error: "LINE 好友狀態暫時無法確認" }, { status: 503 });
}

type AdminDashboardSection = "overview" | "orders" | "members" | "products" | "inventory" | "discounts" | "settings";

const ADMIN_DASHBOARD_SECTIONS: AdminDashboardSection[] = ["overview", "orders", "members", "products", "inventory", "discounts", "settings"];
const ADMIN_PRODUCTS_SELECT = "id,name,description,image_path,image_updated_at,purchase_limit,points_eligible,is_published,display_order,category_id,details,hero_rank,hero_tagline,product_images(id,sort_order,updated_at,width,height),categories(id,name,is_active),product_variants(id,name,sku,kind,price,compare_at_price,stock_on_hand,safety_stock,preorder_arrival,deposit_rate,seller_link,is_published,display_order,updated_at)";
const ADMIN_ORDERS_SELECT = "id,member_id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,paid_amount,payment_deadline,payment_last_five,bank_account_id,admin_note,confirmed_at,payment_confirmed_at,completed_at,cancelled_at,created_at,profiles!orders_member_id_fkey(full_name,phone),bank_accounts(label,bank_name,account_name,account_number),order_items(id,product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)";
const ADMIN_ORDER_HISTORY_SELECT = "id,order_id,from_status,to_status,note,created_at,profiles(full_name)";
const ADMIN_RETURNS_SELECT = "id,order_id,order_item_id,sale_movement_id,received_quantity,restock_quantity,scrap_quantity,note,created_at";
const ADMIN_MEMBER_SELECT = "id,full_name,phone,birthday,address,is_admin,created_at,point_balance,lifetime_spend,order_count";
const ADMIN_POINT_ENTRIES_SELECT = "id,member_id,order_id,kind,points,reason,created_at,profiles!point_ledger_member_id_fkey(full_name),actor:profiles!point_ledger_actor_id_fkey(full_name),orders(order_number)";
const ADMIN_COUPON_SELECT = "id,code,name,discount_amount,combinable_with_points,valid_from,valid_until,total_usage_limit,per_member_limit,is_active,is_birthday,created_at,coupon_products(product_id),coupon_members(member_id),coupon_redemptions(id)";

function adminResourceUrl(base: string, resource: string, select: string, params: Record<string, string> = {}) {
  const url = new URL(`${base}/rest/v1/${resource}`);
  url.searchParams.set("select", select);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

async function fetchAdminRows(url: URL, headers: Record<string, string>) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("管理資料暫時無法載入");
  return await response.json() as unknown[];
}

function adminPage(request: Request, defaultSize: number) {
  const params = new URL(request.url).searchParams;
  const page = Math.max(0, Math.min(Number(params.get("page") || 0) || 0, 100000));
  const pageSize = Math.max(1, Math.min(Number(params.get("page_size") || defaultSize) || defaultSize, 500));
  return { page, pageSize, offset: page * pageSize };
}

function pageRows(rows: unknown[], page: number, pageSize: number) {
  return { items: rows.slice(0, pageSize), pagination: { page, pageSize, hasMore: rows.length > pageSize } };
}

function adminIdFilter(ids: string[]) {
  return `in.(${ids.join(",")})`;
}

function orderRowsByIds(rows: unknown[], ids: string[]) {
  const rowMap = new Map((rows as Array<{ id?: string }>).map((row) => [row.id, row]));
  return ids.map((id) => rowMap.get(id)).filter((row): row is Record<string, unknown> => Boolean(row));
}

async function adminDashboardSection(request: Request, env: Env, section: AdminDashboardSection, actorId: string): Promise<Response> {
  const base = env.SUPABASE_URL as string;
  const headers = serviceHeaders(env);
  const includeManagementOptions = new URL(request.url).searchParams.get("include_options") === "true";
  const rows = (resource: string, select: string, params: Record<string, string> = {}) => fetchAdminRows(adminResourceUrl(base, resource, select, params), headers);
  try {
    if (section === "overview") {
      const result = await loadAdminOverview(base, headers, actorId, (url) => fetchAdminRows(url, headers));
      if (!result.ok) return databaseError(result.response);
      return json({ stats: result.stats, overview: result.overview });
    }
    if (section === "orders") {
      const page = adminPage(request, 100);
      const params = new URL(request.url).searchParams;
      const searchResponse = await fetch(`${base}/rest/v1/rpc/admin_search_order_ids`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_actor_id: actorId,
          p_query: params.get("query")?.trim().slice(0, 100) || "",
          p_status: params.get("status") || "all",
          p_page: page.page,
          p_page_size: page.pageSize
        })
      });
      if (!searchResponse.ok) return databaseError(searchResponse);
      const searchResult = await searchResponse.json() as { ids?: unknown; pagination?: Record<string, unknown> };
      const ids = Array.isArray(searchResult.ids) ? searchResult.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      if (!ids.length) return json({ orders: [], orderHistory: [], returns: [], pagination: { orders: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false }, orderHistory: { page: page.page, pageSize: page.pageSize, hasMore: false }, returns: { page: page.page, pageSize: page.pageSize, hasMore: false } } });
      const idFilter = adminIdFilter(ids);
      const [orders, orderHistory, returns] = await Promise.all([
        rows("orders", ADMIN_ORDERS_SELECT, { id: idFilter, order: "created_at.desc", limit: String(page.pageSize) }),
        rows("order_status_history", ADMIN_ORDER_HISTORY_SELECT, { order_id: idFilter, order: "created_at.desc", limit: "500" }),
        rows("inventory_return_confirmations", ADMIN_RETURNS_SELECT, { order_id: idFilter, order: "created_at.desc", limit: "500" })
      ]);
      return json({ orders: orderRowsByIds(orders, ids), orderHistory, returns, pagination: { orders: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false }, orderHistory: { page: page.page, pageSize: page.pageSize, hasMore: false }, returns: { page: page.page, pageSize: page.pageSize, hasMore: false } } });
    }
    if (section === "members") {
      const page = adminPage(request, 100);
      const params = new URL(request.url).searchParams;
      const searchResponse = await fetch(`${base}/rest/v1/rpc/admin_search_member_ids`, {
        method: "POST",
        headers,
        body: JSON.stringify({ p_actor_id: actorId, p_query: params.get("query")?.trim().slice(0, 100) || "", p_page: page.page, p_page_size: page.pageSize })
      });
      if (!searchResponse.ok) return databaseError(searchResponse);
      const searchResult = await searchResponse.json() as { ids?: unknown; pagination?: Record<string, unknown> };
      const ids = Array.isArray(searchResult.ids) ? searchResult.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      if (!ids.length) return json({ members: [], pointEntries: [], pointSettings: null, orders: [], pagination: { members: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false }, pointEntries: { page: page.page, pageSize: page.pageSize, hasMore: false }, orders: { page: page.page, pageSize: page.pageSize, hasMore: false } } });
      const idFilter = adminIdFilter(ids);
      const [members, pointEntries, pointSettings, orders] = await Promise.all([
        rows("admin_member_summary", ADMIN_MEMBER_SELECT, { id: idFilter, order: "created_at.desc", limit: String(page.pageSize) }),
        rows("point_ledger", ADMIN_POINT_ENTRIES_SELECT, { member_id: idFilter, order: "created_at.desc", limit: "500" }),
        rows("point_settings", "earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value,updated_at", { id: "eq.true", limit: "1" }),
        rows("orders", ADMIN_ORDERS_SELECT, { member_id: idFilter, order: "created_at.desc", limit: "500" })
      ]);
      return json({ members: orderRowsByIds(members, ids), pointEntries, pointSettings: pointSettings[0] || null, orders, pagination: { members: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false }, pointEntries: { page: page.page, pageSize: page.pageSize, hasMore: false }, orders: { page: page.page, pageSize: page.pageSize, hasMore: false } } });
    }
    if (section === "products") {
      const page = adminPage(request, 100);
      const params = new URL(request.url).searchParams;
      const [searchResponse, optionsResponse] = await Promise.all([
        fetch(`${base}/rest/v1/rpc/admin_search_product_ids`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId, p_query: params.get("query")?.trim().slice(0, 100) || "", p_status: params.get("status") || "all", p_page: page.page, p_page_size: page.pageSize }) }),
        includeManagementOptions
          ? fetch(`${base}/rest/v1/rpc/admin_management_options`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId }) })
          : Promise.resolve(null)
      ]);
      if (!searchResponse.ok) return databaseError(searchResponse);
      if (optionsResponse && !optionsResponse.ok) return databaseError(optionsResponse);
      const searchResult = await searchResponse.json() as { ids?: unknown; pagination?: Record<string, unknown> };
      const managementOptions = optionsResponse ? await optionsResponse.json() : null;
      const ids = Array.isArray(searchResult.ids) ? searchResult.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      const products = ids.length ? await rows("products", ADMIN_PRODUCTS_SELECT, { id: adminIdFilter(ids), limit: String(page.pageSize) }) : [];
      return json({ products: orderRowsByIds(products, ids), ...(managementOptions ? { managementOptions } : {}), pagination: { products: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false } } });
    }
    if (section === "inventory") {
      const page = adminPage(request, 100);
      const [searchResponse, optionsResponse] = await Promise.all([
        fetch(`${base}/rest/v1/rpc/admin_search_inventory_movement_ids`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId, p_variant_id: null, p_page: page.page, p_page_size: page.pageSize }) }),
        includeManagementOptions
          ? fetch(`${base}/rest/v1/rpc/admin_management_options`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId }) })
          : Promise.resolve(null)
      ]);
      if (!searchResponse.ok) return databaseError(searchResponse);
      if (optionsResponse && !optionsResponse.ok) return databaseError(optionsResponse);
      const searchResult = await searchResponse.json() as { ids?: unknown; pagination?: Record<string, unknown> };
      const managementOptions = optionsResponse ? await optionsResponse.json() : null;
      const ids = Array.isArray(searchResult.ids) ? searchResult.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      const movements = ids.length ? await rows("inventory_movements", "id,variant_id,kind,quantity_delta,reason,created_at,product_variants(name,sku,products(name))", { id: adminIdFilter(ids), order: "created_at.desc", limit: String(page.pageSize) }) : [];
      return json({ movements: orderRowsByIds(movements, ids), ...(managementOptions ? { managementOptions } : {}), pagination: { inventory: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false } } });
    }
    if (section === "discounts") {
      const page = adminPage(request, 100);
      const [searchResponse, optionsResponse, birthdaySettings] = await Promise.all([
        fetch(`${base}/rest/v1/rpc/admin_search_coupon_ids`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId, p_query: "", p_page: page.page, p_page_size: page.pageSize }) }),
        includeManagementOptions
          ? fetch(`${base}/rest/v1/rpc/admin_management_options`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId }) })
          : Promise.resolve(null),
        rows("birthday_coupon_settings", "enabled,discount_amount,issue_days_before,valid_days,combinable_with_points,updated_at", { id: "eq.true", limit: "1" })
      ]);
      if (!searchResponse.ok) return databaseError(searchResponse);
      if (optionsResponse && !optionsResponse.ok) return databaseError(optionsResponse);
      const searchResult = await searchResponse.json() as { ids?: unknown; pagination?: Record<string, unknown> };
      const managementOptions = optionsResponse ? await optionsResponse.json() : null;
      const ids = Array.isArray(searchResult.ids) ? searchResult.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) : [];
      const coupons = ids.length ? await rows("coupons", ADMIN_COUPON_SELECT, { id: adminIdFilter(ids), limit: String(page.pageSize) }) : [];
      return json({ ...(managementOptions ? { managementOptions } : {}), coupons: orderRowsByIds(coupons, ids), birthdaySettings: birthdaySettings[0] || null, pagination: { discounts: searchResult.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false } } });
    }
    const accounts = await rows("bank_accounts", "id,label,bank_name,account_name,account_number,is_active,display_order,created_at", { order: "display_order.asc", limit: "100" });
    return json({ accounts });
  } catch {
    return json({ error: "管理資料暫時無法載入" }, { status: 503 });
  }
}

async function adminDashboard(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  // 後台一律分區載入；舊的全量路徑（一次讀取 11 張表、各數百筆）已移除。
  const sectionParam = new URL(request.url).searchParams.get("section");
  if (!sectionParam || !ADMIN_DASHBOARD_SECTIONS.includes(sectionParam as AdminDashboardSection)) return json({ error: "管理資料分區不正確" }, { status: 400 });
  return adminDashboardSection(request, env, sectionParam as AdminDashboardSection, admin.user.id);
}

const adminOrderStatuses = ["pending_payment", "pending_review", "confirmed", "partially_ready", "ready_for_pickup", "completed", "cancelled", "refund_pending", "refunded"] as const;

async function transitionAdminOrder(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { target_status?: string; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const targetStatus = body.target_status;
  if (!targetStatus || !adminOrderStatuses.includes(targetStatus as typeof adminOrderStatuses[number])) return json({ error: "訂單狀態不正確" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  if (["partially_ready", "ready_for_pickup"].includes(targetStatus)) {
    const orderUrl = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
    orderUrl.searchParams.set("select", "delivery_method,pickup_plan,order_items(kind)");
    orderUrl.searchParams.set("id", `eq.${orderId}`);
    orderUrl.searchParams.set("limit", "1");
    const orderResponse = await fetch(orderUrl, { headers: serviceHeaders(env) });
    if (!orderResponse.ok) return json({ error: "訂單資料暫時無法讀取" }, { status: 503 });
    const orderRows = await orderResponse.json() as Array<{ delivery_method?: string; pickup_plan?: string; order_items?: Array<{ kind?: string }> }>;
    const order = orderRows[0];
    if (!order) return json({ error: "找不到訂單" }, { status: 404 });
    const hasPreorder = (order.order_items || []).some((item) => item.kind === "preorder");
    const preorderStorePickup = order.delivery_method === "store_pickup" && hasPreorder;
    if (targetStatus === "partially_ready" && (!preorderStorePickup || order.pickup_plan !== "split")) {
      return json({ error: "只有預購到店且設定分批取貨的訂單可標記部分可取貨" }, { status: 400 });
    }
    if (targetStatus === "ready_for_pickup" && !preorderStorePickup && !["seller_delivery", "home_delivery"].includes(order.delivery_method || "")) {
      return json({ error: "現貨到店取貨確認付款後可直接完成取貨，無需標記可取貨" }, { status: 400 });
    }
    if (targetStatus === "ready_for_pickup" && order.delivery_method === "home_delivery" && !hasPreorder) {
      return json({ error: "現貨宅配付款確認後直接填寫尾款與運費，無需更新備貨狀態" }, { status: 400 });
    }
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_transition_order`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_order_id: orderId, p_target_status: targetStatus, p_note: body.note?.trim() || null })
  });
  if (!response.ok) return databaseError(response);
  return json({ order: await response.json() });
}

async function adminAuditLogs(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const page = adminPage(request, 100);
  const resource = url.searchParams.get("resource") || "";
  const action = url.searchParams.get("action") || "";
  const allowedResources = new Set(["product", "product_variant", "category", "bank_account", "coupon", "birthday_coupon_settings", "point_settings", "member_points", "product_image"]);
  const allowedActions = new Set(["create", "update", "adjust", "upload", "delete"]);
  if ((resource && !allowedResources.has(resource)) || (action && !allowedActions.has(action))) return json({ error: "稽核篩選條件不正確" }, { status: 400 });
  const query = new URL(`${env.SUPABASE_URL}/rest/v1/audit_logs`);
  query.searchParams.set("select", "id,actor_id,action,resource,target,before_data,after_data,created_at,profiles!audit_logs_actor_id_fkey(full_name)");
  query.searchParams.set("order", "created_at.desc,id.desc");
  query.searchParams.set("limit", String(page.pageSize + 1));
  query.searchParams.set("offset", String(page.offset));
  if (resource) query.searchParams.set("resource", `eq.${resource}`);
  if (action) query.searchParams.set("action", `eq.${action}`);
  const response = await fetch(query, { headers: serviceHeaders(env) });
  if (!response.ok) return databaseError(response);
  const rows = await response.json() as unknown[];
  // 前端 renderAdminAudit() 讀 auditLogs、分頁依區塊存在 pagination.audit（與通知紀錄 API 相同格式）。
  return json({ auditLogs: rows.slice(0, page.pageSize), pagination: { audit: { page: page.page, pageSize: page.pageSize, hasMore: rows.length > page.pageSize } } });
}

async function adminNotificationDeliveries(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const url = new URL(request.url);
  const page = adminPage(request, 50);
  const channel = url.searchParams.get("channel") || "all";
  const status = url.searchParams.get("status") || "all";
  if (!["all", "line", "telegram"].includes(channel) || !["all", "pending", "processing", "sent", "failed"].includes(status)) return json({ error: "通知篩選條件不正確" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_list_notification_deliveries`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_channel: channel, p_status: status, p_page: page.page, p_page_size: page.pageSize })
  });
  if (!response.ok) return databaseError(response);
  const result = await response.json() as { items?: unknown[]; pagination?: unknown };
  return json({ notificationDeliveries: result.items || [], pagination: { notifications: result.pagination || { page: page.page, pageSize: page.pageSize, hasMore: false } } });
}

async function requeueAdminNotificationDelivery(request: Request, env: Env, channel: string, notificationId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_requeue_notification_delivery`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_channel: channel, p_id: notificationId })
  });
  if (!response.ok) return databaseError(response);
  return json({ delivery: await response.json() });
}

async function updateAdminOrderFulfillment(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { shipping_fee?: number; final_payment_confirmed?: boolean; final_payment_last_five?: string; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.shipping_fee) || (body.shipping_fee as number) < 0) return json({ error: "實際運費必須是 0 或正整數" }, { status: 400 });
  if (body.final_payment_last_five && !/^\d{5}$/.test(body.final_payment_last_five)) return json({ error: "尾款匯款末五碼須為 5 位數字" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  const orderLookup = await fetch(`${env.SUPABASE_URL}/rest/v1/orders?select=status,delivery_method,order_items(kind)&id=eq.${orderId}&limit=1`, { headers: serviceHeaders(env) });
  if (!orderLookup.ok) return json({ error: "訂單資料暫時無法讀取" }, { status: 503 });
  const orderRows = await orderLookup.json() as Array<{ status?: string; delivery_method?: string; order_items?: Array<{ kind?: string }> }>;
  if (!orderRows.length) return json({ error: "找不到訂單" }, { status: 404 });
  const order = orderRows[0];
  const sellerDelivery = order.delivery_method === "seller_delivery";
  const homeDelivery = order.delivery_method === "home_delivery";
  const hasPreorder = (order.order_items || []).some((item) => item.kind === "preorder");
  const fulfillmentReady = ["partially_ready", "ready_for_pickup"].includes(order.status || "")
    || (homeDelivery && !hasPreorder && ["pending_review", "confirmed"].includes(order.status || ""));
  if (homeDelivery && !fulfillmentReady) {
    return json({ error: hasPreorder ? "請先將預購宅配更新為到貨狀態，再儲存尾款與運費" : "請先確認現貨宅配付款，再儲存尾款與運費" }, { status: 400 });
  }
  if (sellerDelivery && body.shipping_fee !== 0) return json({ error: "賣貨便運費由 7-11 向客戶收取，不計入訂單" }, { status: 400 });
  if (sellerDelivery && body.final_payment_confirmed === true) return json({ error: "賣貨便付款由外部平台處理，不需在本站確認尾款" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_order_fulfillment`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_order_id: orderId,
      p_shipping_fee: sellerDelivery ? 0 : body.shipping_fee,
      p_final_payment_confirmed: body.final_payment_confirmed === true,
      p_final_payment_last_five: body.final_payment_last_five?.trim() || null,
      p_note: body.note?.trim() || null
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ order: await response.json() });
}

/**
 * Records the physical return after the refund is completed. The database
 * restores only the quantity the admin marked as resellable.
 */
async function confirmAdminOrderReturn(request: Request, env: Env, orderItemId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { received_quantity?: number; restock_quantity?: number; scrap_quantity?: number; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const received = body.received_quantity;
  const restock = body.restock_quantity;
  const scrap = body.scrap_quantity;
  if (![received, restock, scrap].every(Number.isInteger)
      || (received as number) <= 0
      || (restock as number) < 0
      || (scrap as number) < 0
      || (restock as number) + (scrap as number) !== received) {
    return json({ error: databaseErrors.INVALID_RETURN_QUANTITY }, { status: 400 });
  }
  if ((body.note || "").length > 1000) return json({ error: "退貨驗收備註不可超過 1000 字" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_confirm_order_return`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_order_item_id: orderItemId,
      p_received_quantity: received,
      p_restock_quantity: restock,
      p_scrap_quantity: scrap,
      p_note: body.note?.trim() || null
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ return_confirmation: await response.json() });
}

async function updatePointSettings(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { earn_amount_per_point?: number; point_value?: number; min_redeem_points?: number; max_redeem_mode?: string; max_redeem_value?: number };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const numbers = [body.earn_amount_per_point, body.point_value, body.min_redeem_points, body.max_redeem_value];
  if (!numbers.every(Number.isInteger) || (body.earn_amount_per_point as number) <= 0 || (body.point_value as number) <= 0 || (body.min_redeem_points as number) <= 0 || (body.max_redeem_value as number) < 0) return json({ error: "請填寫正確的點數規則" }, { status: 400 });
  if (!["percent", "fixed"].includes(body.max_redeem_mode || "") || (body.max_redeem_mode === "percent" && (body.max_redeem_value as number) > 100)) return json({ error: "折抵上限設定不正確" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_point_settings`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_earn_amount_per_point: body.earn_amount_per_point,
      p_point_value: body.point_value,
      p_min_redeem_points: body.min_redeem_points,
      p_max_redeem_mode: body.max_redeem_mode,
      p_max_redeem_value: body.max_redeem_value
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ settings: await response.json() });
}

async function adjustMemberPoints(request: Request, env: Env, memberId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { points?: number; reason?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.points) || body.points === 0 || !body.reason?.trim()) return json({ error: "請填寫非 0 點數與異動原因" }, { status: 400 });
  if (body.reason.length > 200) return json({ error: "異動原因不可超過 200 字" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_adjust_member_points`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_member_id: memberId, p_points: body.points, p_reason: body.reason.trim() })
  });
  if (!response.ok) return databaseError(response);
  return json({ balance: await response.json() });
}

async function saveCoupon(request: Request, env: Env, couponId: string | null): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { code?: string; name?: string; discount_amount?: number; combinable_with_points?: boolean; valid_from?: string; valid_until?: string; total_usage_limit?: number | null; per_member_limit?: number; is_active?: boolean; product_ids?: string[]; member_ids?: string[] };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.code?.trim() || !body.name?.trim() || !Number.isInteger(body.discount_amount) || (body.discount_amount as number) <= 0 || !body.valid_from || !body.valid_until || !Number.isInteger(body.per_member_limit) || (body.per_member_limit as number) <= 0) return json({ error: "請填寫完整優惠券資料" }, { status: 400 });
  if (body.total_usage_limit != null && (!Number.isInteger(body.total_usage_limit) || body.total_usage_limit <= 0)) return json({ error: "總使用次數必須為正整數" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_save_coupon`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_coupon_id: couponId, p_code: body.code, p_name: body.name,
      p_discount_amount: body.discount_amount, p_combinable: body.combinable_with_points === true,
      p_valid_from: body.valid_from, p_valid_until: body.valid_until, p_total_usage_limit: body.total_usage_limit ?? null,
      p_per_member_limit: body.per_member_limit, p_is_active: body.is_active !== false,
      p_product_ids: body.product_ids || [], p_member_ids: body.member_ids || []
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ id: await response.json() }, { status: couponId ? 200 : 201 });
}

async function updateBirthdaySettings(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { enabled?: boolean; discount_amount?: number; issue_days_before?: number; valid_days?: number; combinable_with_points?: boolean };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.discount_amount) || (body.discount_amount as number) <= 0 || !Number.isInteger(body.issue_days_before) || !Number.isInteger(body.valid_days)) return json({ error: "生日券設定不正確" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_birthday_coupon_settings`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_enabled: body.enabled === true, p_discount_amount: body.discount_amount, p_issue_days_before: body.issue_days_before, p_valid_days: body.valid_days, p_combinable: body.combinable_with_points === true })
  });
  if (!response.ok) return databaseError(response);
  return json({ settings: await response.json() });
}

async function issueBirthdayCoupons(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/issue_birthday_coupons`, {
    method: "POST", headers: serviceHeaders(env), body: "{}"
  });
  if (!response.ok) return databaseError(response);
  const value = await response.json();
  const issued = typeof value === "number" ? value : Number(value || 0);
  ctx.waitUntil(notifyBirthdayCoupons(env));
  return json({ issued: Number.isFinite(issued) ? issued : 0 });
}

type BankAccountInput = { label?: string; bank_name?: string; account_name?: string; account_number?: string; is_active?: boolean; display_order?: number };

function validateBankAccount(body: BankAccountInput) {
  const accountNumber = String(body.account_number || "").replace(/[\s-]/g, "");
  if (!body.label?.trim() || !body.bank_name?.trim() || !body.account_name?.trim()) return { error: "請填寫帳戶名稱、銀行及戶名" };
  if (!/^\d{8,20}$/.test(accountNumber)) return { error: "銀行帳號須為 8 至 20 位數字" };
  return {
    value: {
      label: body.label.trim(), bank_name: body.bank_name.trim(), account_name: body.account_name.trim(), account_number: accountNumber,
      is_active: body.is_active !== false, display_order: Number.isInteger(body.display_order) ? body.display_order : 0
    }
  };
}

async function createBankAccount(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: BankAccountInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateBankAccount(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_bank_account`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_label: validated.value.label, p_bank_name: validated.value.bank_name,
      p_account_name: validated.value.account_name, p_account_number: validated.value.account_number,
      p_is_active: validated.value.is_active, p_display_order: validated.value.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ account: await response.json() }, { status: 201 });
}

async function updateBankAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: BankAccountInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateBankAccount(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_bank_account`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_account_id: accountId, p_label: validated.value.label, p_bank_name: validated.value.bank_name,
      p_account_name: validated.value.account_name, p_account_number: validated.value.account_number,
      p_is_active: validated.value.is_active, p_display_order: validated.value.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ account: await response.json() });
}

type CategoryInput = { name?: string; display_order?: number; is_active?: boolean };

function validateCategory(body: CategoryInput) {
  const name = body.name?.trim();
  if (!name) return { error: "請填寫分類名稱" };
  if (name.length > 50) return { error: "分類名稱不可超過 50 個字" };
  if (body.display_order != null && (!Number.isInteger(body.display_order) || body.display_order < 0)) return { error: "分類排序須為 0 或正整數" };
  return { value: { name, display_order: Number.isInteger(body.display_order) ? body.display_order : 0, is_active: body.is_active !== false } };
}

async function createAdminCategory(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: CategoryInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateCategory(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_category`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_name: validated.value.name, p_display_order: validated.value.display_order, p_is_active: validated.value.is_active
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ category: await response.json() }, { status: 201 });
}

async function updateAdminCategory(request: Request, env: Env, categoryId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: CategoryInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateCategory(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_category`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_category_id: categoryId, p_name: validated.value.name,
      p_display_order: validated.value.display_order, p_is_active: validated.value.is_active
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ category: await response.json() });
}

type ProductInput = {
  category_id?: string; category_name?: string; product_name?: string; description?: string; variant_name?: string; sku?: string;
  kind?: "in_stock" | "preorder"; price?: number; stock?: number; preorder_arrival?: string;
  deposit_rate?: number; seller_link?: string; purchase_limit?: number | null; points_eligible?: boolean; compare_at_price?: number | null; is_published?: boolean;
};

async function createAdminProduct(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: ProductInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  let categoryName = body.category_name?.trim() || "";
  const categoryId = body.category_id?.trim() || "";
  if (categoryId) {
    if (!/^[0-9a-f-]{36}$/i.test(categoryId)) return json({ error: "商品分類資料不正確" }, { status: 400 });
    const categoryResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/categories?select=id,name,is_active&id=eq.${categoryId}&limit=1`, { headers: serviceHeaders(env) });
    if (!categoryResponse.ok) return json({ error: "無法確認商品分類" }, { status: 503 });
    const categories = await categoryResponse.json() as Array<{ id: string; name: string; is_active?: boolean }>;
    if (!categories[0]) return json({ error: "找不到商品分類" }, { status: 400 });
    if (categories[0].is_active === false) return json({ error: "請選擇啟用中的商品分類" }, { status: 400 });
    categoryName = categories[0].name;
  }
  if (!categoryName || !body.product_name?.trim() || !body.sku?.trim()) return json({ error: "請填寫分類、商品名稱與 SKU" }, { status: 400 });
  if (!Number.isInteger(body.price) || (body.price as number) < 0 || !Number.isInteger(body.stock) || (body.stock as number) < 0) return json({ error: "價格與庫存須為非負整數" }, { status: 400 });
  const price = body.price as number;
  const compareAtPrice = body.compare_at_price == null ? null : Number(body.compare_at_price);
  if (compareAtPrice != null && (!Number.isInteger(compareAtPrice) || compareAtPrice < 0 || compareAtPrice < price)) return json({ error: "原價須為 0 或正整數，且不可低於售價" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return json({ error: "商品類型不正確" }, { status: 400 });
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_product`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_category_name: categoryName,
      p_product_name: body.product_name,
      p_description: body.description || "",
      p_variant_name: body.variant_name || "單一規格",
      p_sku: body.sku,
      p_kind: body.kind,
      p_price: body.price,
      p_stock: body.stock,
      p_preorder_arrival: body.preorder_arrival || null,
      p_deposit_rate: depositRate,
      p_seller_link: body.seller_link || null,
      p_is_published: body.is_published === true,
      p_purchase_limit: body.purchase_limit ?? null,
      p_points_eligible: body.points_eligible !== false,
      p_compare_at_price: compareAtPrice
    })
  });
  if (!response.ok) return databaseError(response);
  const ids = await response.json() as { product_id?: string; variant_id?: string };
  return json({ ids }, { status: 201 });
}

type VariantInput = {
  product_id?: string; name?: string; sku?: string; kind?: "in_stock" | "preorder"; price?: number;
  safety_stock?: number; preorder_arrival?: string; deposit_rate?: number; seller_link?: string; compare_at_price?: number | null;
  is_published?: boolean; display_order?: number;
};

function normalizedVariant(body: VariantInput, includeProduct = false) {
  if (!body.name?.trim() || !body.sku?.trim() || !Number.isInteger(body.price) || (body.price as number) < 0) return { error: "請填寫規格名稱、SKU 與正確價格" };
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return { error: "商品類型不正確" };
  if (includeProduct && !body.product_id) return { error: "請選擇商品" };
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  if (!Number.isFinite(depositRate) || depositRate < 0 || depositRate > 1) return { error: "訂金比例須介於 0% 至 100%" };
  const price = body.price as number;
  const compareAtPrice = body.compare_at_price == null ? null : Number(body.compare_at_price);
  if (compareAtPrice != null && (!Number.isInteger(compareAtPrice) || compareAtPrice < 0 || compareAtPrice < price)) return { error: "原價須為 0 或正整數，且不可低於售價" };
  return { value: {
    ...(includeProduct ? { product_id: body.product_id } : {}), name: body.name.trim(), sku: body.sku.trim().toUpperCase(), kind: body.kind,
    price: body.price, compare_at_price: compareAtPrice, safety_stock: Number.isInteger(body.safety_stock) ? body.safety_stock : 3,
    preorder_arrival: body.preorder_arrival?.trim() || null, deposit_rate: depositRate,
    seller_link: body.seller_link?.trim() || null, is_published: body.is_published === true,
    display_order: Number.isInteger(body.display_order) ? body.display_order : 0, updated_at: new Date().toISOString()
  } };
}

async function createVariant(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: VariantInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = normalizedVariant(body, true);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const payload = validated.value;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_variant`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_product_id: payload.product_id, p_name: payload.name, p_sku: payload.sku,
      p_kind: payload.kind, p_price: payload.price, p_compare_at_price: payload.compare_at_price,
      p_safety_stock: payload.safety_stock, p_preorder_arrival: payload.preorder_arrival,
      p_deposit_rate: payload.deposit_rate, p_seller_link: payload.seller_link,
      p_is_published: payload.is_published, p_display_order: payload.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ variant: await response.json() }, { status: 201 });
}

async function updateVariant(request: Request, env: Env, variantId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: VariantInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = normalizedVariant(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const payload = { ...validated.value };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_variant`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_variant_id: variantId, p_name: payload.name, p_sku: payload.sku,
      p_kind: payload.kind, p_price: payload.price, p_compare_at_price: payload.compare_at_price ?? null,
      p_update_compare_at_price: body.compare_at_price !== undefined, p_safety_stock: payload.safety_stock,
      p_preorder_arrival: payload.preorder_arrival, p_deposit_rate: payload.deposit_rate,
      p_seller_link: payload.seller_link, p_is_published: payload.is_published, p_display_order: payload.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ variant: await response.json() });
}

async function updateProduct(request: Request, env: Env, productId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { name?: string; description?: string; category_id?: string; purchase_limit?: number | null; points_eligible?: boolean; is_published?: boolean; display_order?: number };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.name?.trim()) return json({ error: "請填寫商品名稱" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_product_id: productId, p_name: body.name.trim(), p_description: body.description || "",
      p_category_id: body.category_id || null, p_purchase_limit: body.purchase_limit ?? null,
      p_points_eligible: typeof body.points_eligible === "boolean" ? body.points_eligible : null,
      p_is_published: body.is_published === true, p_display_order: Number.isInteger(body.display_order) ? body.display_order : 0
    })
  });
  if (!response.ok) return databaseError(response);
  const product = await response.json() as { image_updated_at?: string | null };
  // This mutation includes is_published; purge the current primary image here.
  // Other data centers drop it within the edge TTL (s-maxage) after unpublishing.
  await purgeProductImageCache(request, productId, undefined, product.image_updated_at || "1");
  return json({ product });
}

async function adjustInventory(request: Request, env: Env, variantId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { quantity_delta?: number; reason?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.quantity_delta) || body.quantity_delta === 0 || !body.reason?.trim()) return json({ error: "請填寫非 0 的異動數量與原因" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_adjust_inventory`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_variant_id: variantId, p_quantity_delta: body.quantity_delta, p_reason: body.reason.trim() })
  });
  if (!response.ok) return databaseError(response);
  return json({ stock_on_hand: await response.json() });
}

async function createOrder(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const { authorization, user } = authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_ORDER_RATE_LIMITER, `order:${user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_REQUEST_BYTES) return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });
  let body: { items?: Array<{ variant_id: string; quantity: number }>; pickup_plan?: "together" | "split"; delivery_method?: "store_pickup" | "seller_delivery" | "home_delivery"; payment_method?: "bank_transfer" | "store_payment"; shipping_address?: string; shipping_recipient_name?: string; shipping_phone?: string; coupon_code?: string; points_to_redeem?: number; bank_account_id?: string; payment_last_five?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Array.isArray(body.items) || body.items.length === 0) return json({ error: "購物車不可為空" }, { status: 400 });
  if (body.pickup_plan && body.pickup_plan !== "together") return json({ error: "現貨與預購需分開結帳，不提供單筆分批取貨" }, { status: 400 });
  if (body.items.length > MAX_ORDER_ITEMS) return json({ error: "購物車品項數量超過上限" }, { status: 400 });
  const variantIds = new Set<string>();
  let duplicateVariant = false;
  if (body.items.some((item) => {
    if (!item.variant_id || !/^[0-9a-f-]{36}$/i.test(item.variant_id) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) return true;
    if (variantIds.has(item.variant_id.toLowerCase())) { duplicateVariant = true; return true; }
    variantIds.add(item.variant_id.toLowerCase());
    return false;
  })) return json({ error: duplicateVariant ? databaseErrors.DUPLICATE_ORDER_ITEM : "商品數量錯誤" }, { status: 400 });
  const deliveryMethod = body.delivery_method ?? "store_pickup";
  const paymentMethod = body.payment_method ?? (deliveryMethod === "seller_delivery" ? "store_payment" : "bank_transfer");
  if (!['bank_transfer', 'store_payment'].includes(paymentMethod)) return json({ error: "付款方式不正確" }, { status: 400 });
  if (paymentMethod === "store_payment" && deliveryMethod !== "seller_delivery") return json({ error: databaseErrors.STORE_PAYMENT_BANK_TRANSFER_ONLY }, { status: 400 });
  if (deliveryMethod === "seller_delivery" && paymentMethod === "store_payment" && body.bank_account_id) return json({ error: "賣貨便外部付款訂單不可指定本站收款帳戶" }, { status: 400 });
  if (paymentMethod === "bank_transfer" && !body.bank_account_id) return json({ error: "請選擇收款帳戶" }, { status: 400 });
  if (!Number.isInteger(body.points_to_redeem ?? 0) || (body.points_to_redeem ?? 0) < 0) return json({ error: "點數使用數量不正確" }, { status: 400 });
  const shippingRecipientName = body.shipping_recipient_name?.trim() || null;
  const shippingPhone = body.shipping_phone?.replace(/[\s-]/g, "") || null;
  if (deliveryMethod === "home_delivery") {
    if (!shippingRecipientName) return json({ error: "宅配請填寫收件人姓名" }, { status: 400 });
    if (!shippingPhone || !/^09\d{8}$/.test(shippingPhone)) return json({ error: "宅配請填寫有效的收件人手機號碼" }, { status: 400 });
    if (!body.shipping_address?.trim()) return json({ error: "宅配請填寫收件地址" }, { status: 400 });
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/create_delivery_order`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_items: body.items,
      p_pickup_plan: body.pickup_plan ?? "together",
      p_delivery_method: deliveryMethod,
      p_coupon_code: body.coupon_code?.trim() || null,
      p_points_to_redeem: body.points_to_redeem ?? 0,
      p_bank_account_id: body.bank_account_id ?? null,
      p_payment_last_five: body.payment_last_five ?? null,
      p_shipping_address: body.shipping_address?.trim() || null,
      p_shipping_recipient_name: shippingRecipientName,
      p_shipping_phone: shippingPhone
    })
  });
  if (!response.ok) return databaseError(response);
  const orderId = await response.json() as string;
  const order = await loadOrder(env, orderId, user.id);
  if (!order) return json({ error: "訂單已建立，但明細載入失敗，請至我的訂單查看" }, { status: 502 });
  return json({ order }, { status: 201 });
}

async function submitOrderPayment(request: Request, env: Env, orderId: string): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `payment:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  let body: { bank_account_id?: string; payment_last_five?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.bank_account_id || !body.payment_last_five) return json({ error: "請選擇收款帳戶並填寫末五碼" }, { status: 400 });
  if (!/^\d{5}$/.test(body.payment_last_five)) return json({ error: "匯款帳號末五碼須為 5 位數字" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/submit_order_payment`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_order_id: orderId, p_bank_account_id: body.bank_account_id, p_payment_last_five: body.payment_last_five })
  });
  if (!response.ok) return databaseError(response);
  const order = await loadOrder(env, orderId, authResult.user.id);
  return json({ order });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isProductImageUpload = request.method === "POST" && /^\/api\/admin\/products\/[0-9a-f-]{36}\/image$/i.test(url.pathname);
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (url.pathname.startsWith("/api/") && ["POST", "PUT", "PATCH"].includes(request.method) && !isProductImageUpload && !isShowcaseImageUpload(request, url) && Number.isFinite(contentLength) && contentLength > MAX_JSON_REQUEST_BYTES) {
      return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });
    }
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, store: env.STORE_NAME, database: Boolean(env.SUPABASE_URL) });
    if (request.method === "POST" && url.pathname === "/api/auth/liff/verify") return verifyLiffIdentity(request, env);
    if (request.method === "POST" && url.pathname === "/api/auth/session/remember") return rememberLiffSession(request, env);
    if (request.method === "POST" && url.pathname === "/api/auth/session/restore") return restoreLiffSession(request, env);
    if (request.method === "POST" && url.pathname === "/api/auth/session/forget") return forgetLiffSession();
    const webSessionResponse = await webSession.route(request, env, url);
    if (webSessionResponse) return webSessionResponse;
    if (request.method === "GET" && url.pathname === "/api/config") {
      // Runtime config only contains public, non-member-specific bootstrap data.
      // Keep every other JSON response on the default no-store policy.
      return json(await runtimeConfig(env), { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } });
    }
    if (request.method === "GET" && url.pathname === "/api/catalog") {
      try { return json({ products: await publicCatalog(env) }); }
      catch { return json({ error: "商品暫時無法載入" }, { status: 503 }); }
    }
    const productImageMatch = url.pathname.match(/^\/api\/product-images\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && productImageMatch) return serveProductImage(request, env, productImageMatch[1], ctx);
    if (request.method === "GET" && url.pathname === "/api/bank-accounts") return listBankAccounts(request, env);
    if (request.method === "GET" && url.pathname === "/api/cart") return listMemberCart(request, env);
    if (request.method === "PUT" && url.pathname === "/api/cart") return replaceMemberCart(request, env);
    if (request.method === "GET" && url.pathname === "/api/orders") return listOrders(request, env);
    if (request.method === "GET" && url.pathname === "/api/member/points") return memberPoints(request, env);
    if (request.method === "GET" && url.pathname === "/api/member/line-friendship") return memberLineFriendship(request, env);
    if (request.method === "POST" && url.pathname === "/api/member/identity-sync") return syncMemberIdentity(request, env);
    if (request.method === "POST" && url.pathname === "/api/orders") {
      const response = await createOrder(request, env);
      if (response.ok) {
        try {
          const payload = await response.clone().json() as { order?: { id?: string } };
          if (payload.order?.id) ctx.waitUntil(notifyOrderEvent(env, payload.order.id, "created"));
        } catch { /* response body is still returned to the member */ }
      }
      return response;
    }
    const paymentMatch = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})\/payment$/i);
    if (request.method === "POST" && paymentMatch) {
      const response = await submitOrderPayment(request, env, paymentMatch[1]);
      if (response.ok) ctx.waitUntil(notifyOrderEvent(env, paymentMatch[1], "payment_reported"));
      return response;
    }
    if (request.method === "GET" && url.pathname === "/api/admin/dashboard") return adminDashboard(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/audit-logs") return adminAuditLogs(request, env);
    if (request.method === "GET" && url.pathname === "/api/admin/notification-deliveries") return adminNotificationDeliveries(request, env);
    const notificationRequeueMatch = url.pathname.match(/^\/api\/admin\/notification-deliveries\/(line|telegram)\/([0-9a-f-]{36})\/requeue$/i);
    if (request.method === "POST" && notificationRequeueMatch) return requeueAdminNotificationDelivery(request, env, notificationRequeueMatch[1], notificationRequeueMatch[2]);
    if (request.method === "POST" && ["/api/admin/telegram-test", "/api/admin/line-test"].includes(url.pathname)) return testTelegramNotification(request, env);
    const orderTransitionMatch = url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/transition$/i);
    if (request.method === "POST" && orderTransitionMatch) {
      const response = await transitionAdminOrder(request, env, orderTransitionMatch[1]);
      if (response.ok) ctx.waitUntil(Promise.allSettled([notifyOrderEvent(env, orderTransitionMatch[1], "status_changed"), notifyLowStock(env)]));
      return response;
    }
    const orderFulfillmentMatch = url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/fulfillment$/i);
    if (request.method === "PATCH" && orderFulfillmentMatch) {
      const response = await updateAdminOrderFulfillment(request, env, orderFulfillmentMatch[1]);
      if (response.ok) ctx.waitUntil(notifyOrderEvent(env, orderFulfillmentMatch[1], "fulfillment_updated"));
      return response;
    }
    const orderReturnMatch = url.pathname.match(/^\/api\/admin\/order-items\/([0-9a-f-]{36})\/return$/i);
    if (request.method === "POST" && orderReturnMatch) return confirmAdminOrderReturn(request, env, orderReturnMatch[1]);
    if (request.method === "PUT" && url.pathname === "/api/admin/point-settings") return updatePointSettings(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/coupons") return saveCoupon(request, env, null);
    const couponMatch = url.pathname.match(/^\/api\/admin\/coupons\/([0-9a-f-]{36})$/i);
    if (request.method === "PUT" && couponMatch) return saveCoupon(request, env, couponMatch[1]);
    if (request.method === "PUT" && url.pathname === "/api/admin/birthday-coupon-settings") return updateBirthdaySettings(request, env);
    if (request.method === "POST" && url.pathname === "/api/admin/birthday-coupons/issue") return issueBirthdayCoupons(request, env, ctx);
    const memberPointMatch = url.pathname.match(/^\/api\/admin\/members\/([0-9a-f-]{36})\/points$/i);
    if (request.method === "POST" && memberPointMatch) return adjustMemberPoints(request, env, memberPointMatch[1]);
    if (request.method === "POST" && url.pathname === "/api/admin/bank-accounts") return createBankAccount(request, env);
    const accountMatch = url.pathname.match(/^\/api\/admin\/bank-accounts\/([0-9a-f-]{36})$/i);
    if (request.method === "PATCH" && accountMatch) return updateBankAccount(request, env, accountMatch[1]);
    if (request.method === "POST" && url.pathname === "/api/admin/categories") return createAdminCategory(request, env);
    const categoryMatch = url.pathname.match(/^\/api\/admin\/categories\/([0-9a-f-]{36})$/i);
    if (request.method === "PATCH" && categoryMatch) return updateAdminCategory(request, env, categoryMatch[1]);
    if (request.method === "POST" && url.pathname === "/api/admin/products") return createAdminProduct(request, env);
    const productMatch = url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
    const productImageUploadMatch = url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/image$/i);
    if (request.method === "POST" && productImageUploadMatch) return uploadProductImage(request, env, productImageUploadMatch[1]);
    if (request.method === "PATCH" && productMatch) return updateProduct(request, env, productMatch[1]);
    if (request.method === "POST" && url.pathname === "/api/admin/variants") return createVariant(request, env);
    const variantMatch = url.pathname.match(/^\/api\/admin\/variants\/([0-9a-f-]{36})$/i);
    if (request.method === "PATCH" && variantMatch) return updateVariant(request, env, variantMatch[1]);
    const inventoryMatch = url.pathname.match(/^\/api\/admin\/variants\/([0-9a-f-]{36})\/inventory$/i);
    if (request.method === "POST" && inventoryMatch) {
      const response = await adjustInventory(request, env, inventoryMatch[1]);
      if (response.ok) ctx.waitUntil(notifyLowStock(env));
      return response;
    }
    const showcaseResponse = await productShowcase.route(request, env, url, ctx);
    if (showcaseResponse) return showcaseResponse;
    if (url.pathname.startsWith("/api/")) return json({ error: "找不到 API" }, { status: 404 });
    if (isShareMetaRequest(request, url)) return withSecurityHeaders(await withShareMeta(request, env, url));
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const task = _controller.cron === "*/5 * * * *"
      ? retryDueNotificationDeliveries(env)
      : Promise.all([retryDueNotificationDeliveries(env), runScheduledNotifications(env)]).then(() => undefined);
    ctx.waitUntil(task);
  }
} satisfies ExportedHandler<Env>;
