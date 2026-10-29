// 會員 API：收款帳戶、訂單查詢、雲端購物車、點數、LINE 好友狀態、建立訂單與回報匯款。
import { type RestoreExtras, requireUser } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, enforceRateLimit, fetchWithTimeout, json, serviceHeaders } from "./http";
import { invalidateCatalogCache } from "./catalog";
import { ServerTiming } from "./server-timing";

const MAX_ORDER_ITEMS = 50;

const MAX_ITEM_QUANTITY = 100;

const MAX_CART_ITEMS = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LINE_FRIEND_VERIFICATION_TTL_SECONDS = 15 * 60;

function lineFriendVerificationIsFresh(value: string | null | undefined) {
  const verifiedAt = value ? Date.parse(value) : NaN;
  return Number.isFinite(verifiedAt) && Date.now() - verifiedAt <= LINE_FRIEND_VERIFICATION_TTL_SECONDS * 1000;
}

async function setLineFriendVerification(env: Env, userId: string, verified: boolean) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  url.searchParams.set("id", `eq.${userId}`);
  const response = await fetchWithTimeout(url, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ line_friend_verified_at: verified ? new Date().toISOString() : null })
  });
  return response.ok;
}

export async function listBankAccounts(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `bank-accounts:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "收款帳戶服務尚未設定" }, { status: 503 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/bank_accounts?select=id,label,bank_name,account_name,account_number&is_active=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "收款帳戶暫時無法載入" }, { status: 503 });
  return json({ accounts: await response.json() });
}

// 會員訂單以會員自己的 JWT 讀取，由 RLS（members view own orders／order items）限定本人；
// member_id 條件保留作第二層防護。收款帳戶是店家資料、會員不能直接讀表，另以 service role 依 id 補上。
const MEMBER_ORDER_SELECT = "id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,pickup_store_city,pickup_store_district,pickup_store_name,pickup_store_code,shipment_tracking_number,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,final_payment_reported_last_five,final_payment_reported_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,payment_last_five,bank_account_id,created_at,order_items(product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)";

type MemberOrderRow = { bank_account_id?: string | null; bank_accounts?: unknown };
type BankAccountRow = { id: string; label: string; bank_name: string; account_name: string; account_number: string };

function memberHeaders(env: Env, authorization: string) {
  return { apikey: env.SUPABASE_ANON_KEY as string, Authorization: authorization };
}

async function attachBankAccounts(env: Env, orders: MemberOrderRow[]): Promise<boolean> {
  const ids = [...new Set(orders.map((order) => order.bank_account_id).filter((id): id is string => Boolean(id)))];
  const accounts = new Map<string, Omit<BankAccountRow, "id">>();
  if (ids.length) {
    const url = new URL(`${env.SUPABASE_URL}/rest/v1/bank_accounts`);
    url.searchParams.set("select", "id,label,bank_name,account_name,account_number");
    url.searchParams.set("id", `in.(${ids.join(",")})`);
    let loaded = false;
    try {
      const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
      if (response.ok) {
        for (const { id, ...account } of await response.json() as BankAccountRow[]) accounts.set(id, account);
        loaded = true;
      }
    } catch { /* 逾時或網路錯誤：與非 2xx 相同處理 */ }
    if (!loaded) {
      for (const order of orders) order.bank_accounts = null;
      return false;
    }
  }
  for (const order of orders) order.bank_accounts = order.bank_account_id ? accounts.get(order.bank_account_id) ?? null : null;
  return true;
}

async function loadOrder(env: Env, orderId: string, memberId: string, authorization: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", MEMBER_ORDER_SELECT);
  url.searchParams.set("id", `eq.${orderId}`);
  url.searchParams.set("member_id", `eq.${memberId}`);
  const response = await fetchWithTimeout(url, { headers: memberHeaders(env, authorization) });
  if (!response.ok) return null;
  const rows = await response.json() as MemberOrderRow[];
  if (!rows[0]) return null;
  // 收款帳戶查詢失敗時仍回傳訂單（帳戶為 null），付款畫面會顯示「匯款帳號暫時無法載入」。
  await attachBankAccounts(env, rows);
  return rows[0];
}

function ordersServiceReady(env: Env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY);
}

/** 會員最近 50 筆訂單（含收款帳戶）；GET /api/orders 與訂單頁恢復登入共用。查詢失敗回 null。 */
async function memberOrders(env: Env, memberId: string, authorization: string, timing: ServerTiming) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", MEMBER_ORDER_SELECT);
  url.searchParams.set("member_id", `eq.${memberId}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "50");
  const response = await timing.measure("orders", fetchWithTimeout(url, { headers: memberHeaders(env, authorization) }));
  if (!response.ok) return null;
  const orders = await response.json() as MemberOrderRow[];
  // 收款帳戶查詢失敗時仍列出訂單（帳戶欄位為 null），前台改顯示「匯款帳號暫時無法載入」，不讓客人連訂單都看不到。
  const bankAccountsLoaded = await timing.measure("bank", attachBankAccounts(env, orders));
  return { orders, bank_accounts_unavailable: !bankAccountsLoaded };
}

export async function listOrders(request: Request, env: Env): Promise<Response> {
  const timing = new ServerTiming();
  const authResult = await timing.measure("user", requireUser(request, env));
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `orders-read:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!ordersServiceReady(env)) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  const result = await memberOrders(env, authResult.user.id, authResult.authorization, timing);
  if (!result) return json({ error: "訂單紀錄暫時無法載入" }, { status: 503 });
  return json(result, { headers: { "Server-Timing": timing.header() } });
}

/**
 * 訂單頁恢復登入時一併回傳訂單（POST /api/auth/session/restore 帶 include_orders: true），省掉前端再請求 GET /api/orders
 * 與其中確認 token 的 Supabase 查詢（恢復時已確認是本人的 LINE 會員）。與 GET /api/orders 共用限流計數；
 * 限流、未設定或查詢失敗時不附帶，前端改請求 GET /api/orders，由它回報錯誤。
 */
export const ordersForRestoredSession: RestoreExtras = async (env, user, authorization, timing) => {
  if (!ordersServiceReady(env)) return {};
  if (await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `orders-read:${user.id}`)) return {};
  return (await memberOrders(env, user.id, authorization, timing)) || {};
};

type MemberCartRow = { variant_id: string; quantity: number; updated_at?: string };

export async function listMemberCart(request: Request, env: Env): Promise<Response> {
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
  const response = await fetchWithTimeout(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization } });
  if (!response.ok) return json({ error: "會員購物車暫時無法載入" }, { status: 503 });
  const rows = await response.json() as MemberCartRow[];
  return json({ items: rows.map((row) => ({ variant_id: row.variant_id, quantity: row.quantity })) });
}

export async function replaceMemberCart(request: Request, env: Env): Promise<Response> {
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
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/replace_member_cart`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_items: items.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity })) })
  });
  if (!response.ok) return databaseError(response);
  return json({ ok: true, items: items.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity })) });
}

export async function memberPoints(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `points:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "點數服務尚未設定" }, { status: 503 });
  const headers = serviceHeaders(env);
  const member = memberHeaders(env, authResult.authorization);
  const [balanceResponse, ledgerResponse, settingsResponse, couponsResponse] = await Promise.all([
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/member_point_balance`, {
      method: "POST",
      headers: { ...member, "Content-Type": "application/json" },
      body: "{}"
    }),
    // 點數紀錄以會員 JWT 讀取（RLS：members view own point ledger）；點數設定是全店共用設定，仍由 service role 讀。
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/point_ledger?select=id,kind,points,reason,created_at,orders(order_number)&member_id=eq.${authResult.user.id}&order=created_at.desc&limit=100`, { headers: member }),
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/point_settings?select=earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value&id=eq.true`, { headers }),
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/member_available_coupons`, { method: "POST", headers: { ...member, "Content-Type": "application/json" }, body: "{}" })
  ]);
  if (!balanceResponse.ok || !ledgerResponse.ok || !settingsResponse.ok || !couponsResponse.ok) return json({ error: "點數與優惠券資料暫時無法載入" }, { status: 503 });
  const balance = Number(await balanceResponse.json());
  const ledger = await ledgerResponse.json() as Array<{ points: number }>;
  const settings = await settingsResponse.json() as unknown[];
  return json({ balance: Number.isFinite(balance) ? balance : 0, ledger, settings: settings[0] || null, coupons: await couponsResponse.json() });
}

export async function memberLineFriendship(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `friendship:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) return json({ error: "LINE 好友狀態服務尚未設定" }, { status: 503 });
  const profileUrl = new URL(`${env.SUPABASE_URL}/rest/v1/profiles`);
  profileUrl.searchParams.set("select", "line_user_id,line_friend_verified_at");
  profileUrl.searchParams.set("id", `eq.${authResult.user.id}`);
  profileUrl.searchParams.set("limit", "1");
  const profileResponse = await fetchWithTimeout(profileUrl, { headers: serviceHeaders(env) });
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
    fetchWithTimeout("https://api.line.me/friendship/v1/status", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } }),
    fetchWithTimeout("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } })
  ]);
  if (friendshipResponse.ok && profileCheckResponse.ok) {
    const friendship = await friendshipResponse.json() as { friendFlag?: boolean };
    const lineProfile = await profileCheckResponse.json() as { userId?: string };
    if (lineProfile.userId !== lineUserId) return json({ error: "LINE 會員驗證不一致，請重新登入", code: "LINE_IDENTITY_MISMATCH" }, { status: 401 });
    const isFriend = friendship.friendFlag === true;
    if (!await setLineFriendVerification(env, authResult.user.id, isFriend)) return json({ error: "LINE 好友驗證紀錄失敗，請稍後再試" }, { status: 503 });
    return json({ friendFlag: isFriend, source: "line_login" });
  }
  // code 讓前台分辨「LINE 授權過期，要重新 LINE 登入」與網站登入過期（requireUser 的 401，沒有 code）
  if ([401, 403].includes(friendshipResponse.status) || [401, 403].includes(profileCheckResponse.status)) return json({ error: "LINE 登入授權已過期，請重新登入", code: "LINE_LOGIN_EXPIRED" }, { status: 401 });
  return json({ error: "LINE 好友狀態暫時無法確認" }, { status: 503 });
}

/** 建單成功後由伺服器移除雲端購物車中已下單的規格：前台同步失敗時，其他裝置也不會再看到已購買的商品。失敗不影響建單結果。 */
async function removeOrderedCartItems(env: Env, memberId: string, authorization: string, variantIds: string[]) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/member_cart_items`);
  url.searchParams.set("member_id", `eq.${memberId}`);
  url.searchParams.set("variant_id", `in.(${variantIds.join(",")})`);
  await fetchWithTimeout(url, {
    method: "DELETE",
    headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: authorization, Prefer: "return=minimal" }
  }).catch(() => undefined);
}

export async function createOrder(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const { authorization, user } = authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_ORDER_RATE_LIMITER, `order:${user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_REQUEST_BYTES) return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });
  let body: { items?: Array<{ variant_id: string; quantity: number }>; pickup_plan?: "together" | "split"; delivery_method?: "store_pickup" | "home_delivery" | "cvs_delivery"; payment_method?: "bank_transfer"; shipping_address?: string; shipping_recipient_name?: string; shipping_phone?: string; pickup_store_city?: string; pickup_store_district?: string; pickup_store_name?: string; pickup_store_code?: string; coupon_code?: string; points_to_redeem?: number; bank_account_id?: string; payment_last_five?: string; client_request_id?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  // 同一次結帳嘗試的識別碼：重送時資料庫回傳原訂單，避免重複下單（202610130001）
  if (body.client_request_id != null && !UUID_PATTERN.test(String(body.client_request_id))) return json({ error: "請求格式錯誤" }, { status: 400 });
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
  const deliveryMethod: string = body.delivery_method ?? "store_pickup";
  // 賣貨便已停用（202610110001）：所有新訂單一律匯款／轉帳。
  if (deliveryMethod === "seller_delivery") return json({ error: databaseErrors.SELLER_DELIVERY_RETIRED }, { status: 400 });
  if (!["store_pickup", "home_delivery", "cvs_delivery"].includes(deliveryMethod)) return json({ error: databaseErrors.INVALID_DELIVERY_METHOD }, { status: 400 });
  if ((body.payment_method ?? "bank_transfer") !== "bank_transfer") return json({ error: databaseErrors.STORE_PAYMENT_BANK_TRANSFER_ONLY }, { status: 400 });
  if (!body.bank_account_id) return json({ error: "請選擇收款帳戶" }, { status: 400 });
  if (!Number.isInteger(body.points_to_redeem ?? 0) || (body.points_to_redeem ?? 0) < 0) return json({ error: "點數使用數量不正確" }, { status: 400 });
  const needsRecipient = deliveryMethod === "home_delivery" || deliveryMethod === "cvs_delivery";
  const shippingRecipientName = needsRecipient ? body.shipping_recipient_name?.trim() || null : null;
  const shippingPhone = needsRecipient ? body.shipping_phone?.replace(/[\s-]/g, "") || null : null;
  const cvs = deliveryMethod === "cvs_delivery";
  const pickupStore = {
    city: cvs ? body.pickup_store_city?.trim() || null : null,
    district: cvs ? body.pickup_store_district?.trim() || null : null,
    name: cvs ? body.pickup_store_name?.trim() || null : null,
    code: cvs ? body.pickup_store_code?.replace(/\s/g, "") || null : null
  };
  if (needsRecipient) {
    if (!shippingRecipientName) return json({ error: databaseErrors.SHIPPING_RECIPIENT_REQUIRED }, { status: 400 });
    if (!shippingPhone || !/^09\d{8}$/.test(shippingPhone)) return json({ error: databaseErrors.SHIPPING_PHONE_REQUIRED }, { status: 400 });
  }
  if (deliveryMethod === "home_delivery" && !body.shipping_address?.trim()) return json({ error: databaseErrors.SHIPPING_ADDRESS_REQUIRED }, { status: 400 });
  if (cvs) {
    if (!pickupStore.city || !pickupStore.district || !pickupStore.name) return json({ error: databaseErrors.CVS_PICKUP_STORE_REQUIRED }, { status: 400 });
    if (!pickupStore.code || !/^\d{6}$/.test(pickupStore.code)) return json({ error: databaseErrors.CVS_PICKUP_STORE_CODE_INVALID }, { status: 400 });
  }
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/create_delivery_order`, {
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
      p_shipping_address: deliveryMethod === "home_delivery" ? body.shipping_address?.trim() || null : null,
      p_shipping_recipient_name: shippingRecipientName,
      p_shipping_phone: shippingPhone,
      p_pickup_store_city: pickupStore.city,
      p_pickup_store_district: pickupStore.district,
      p_pickup_store_name: pickupStore.name,
      p_pickup_store_code: pickupStore.code,
      p_client_request_id: body.client_request_id ?? null
    })
  });
  if (!response.ok) return databaseError(response);
  // 建單會保留庫存，前台型錄的可售量隨之減少
  await invalidateCatalogCache(request);
  const orderId = await response.json() as string;
  await removeOrderedCartItems(env, user.id, authorization, [...variantIds]);
  // 回讀逾時或網路例外也收斂成 null：訂單已建立，不能讓外層錯誤處理回 503
  const order = await loadOrder(env, orderId, user.id, authorization).catch(() => null);
  // 訂單已建立：明細讀不到也回 201，前端改導向我的訂單，避免客人以為失敗而重新下單。
  if (!order) return json({ order: null, order_id: orderId, detail_unavailable: true }, { status: 201 });
  return json({ order }, { status: 201 });
}

export async function submitOrderPayment(request: Request, env: Env, orderId: string): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `payment:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  let body: { bank_account_id?: string; payment_last_five?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.bank_account_id || !body.payment_last_five) return json({ error: "請選擇收款帳戶並填寫末五碼" }, { status: 400 });
  if (!/^\d{5}$/.test(body.payment_last_five)) return json({ error: "匯款帳號末五碼須為 5 位數字" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/submit_order_payment`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_order_id: orderId, p_bank_account_id: body.bank_account_id, p_payment_last_five: body.payment_last_five })
  });
  if (!response.ok) return databaseError(response);
  const order = await loadOrder(env, orderId, authResult.user.id, authResult.authorization);
  return json({ order });
}

/** 預購店到店／宅配到貨後回報尾款匯款末五碼；可否回報由 submit_order_final_payment 判斷，訂單狀態不變。 */
export async function submitOrderFinalPayment(request: Request, env: Env, orderId: string): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `payment:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  let body: { payment_last_five?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (typeof body.payment_last_five !== "string" || !/^\d{5}$/.test(body.payment_last_five)) return json({ error: "匯款帳號末五碼須為 5 位數字" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/submit_order_final_payment`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_order_id: orderId, p_payment_last_five: body.payment_last_five })
  });
  if (!response.ok) return databaseError(response);
  const order = await loadOrder(env, orderId, authResult.user.id, authResult.authorization);
  return json({ order });
}
