// 會員 API：收款帳戶、訂單查詢、雲端購物車、點數、LINE 好友狀態、建立訂單與回報匯款。
import { requireUser } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, enforceRateLimit, json, serviceHeaders } from "./http";

const MAX_ORDER_ITEMS = 50;

const MAX_ITEM_QUANTITY = 100;

const MAX_CART_ITEMS = 50;

const LINE_FRIEND_VERIFICATION_TTL_SECONDS = 15 * 60;

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

export async function listBankAccounts(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "收款帳戶服務尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/bank_accounts?select=id,label,bank_name,account_name,account_number&is_active=eq.true&order=display_order.asc`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "收款帳戶暫時無法載入" }, { status: 503 });
  return json({ accounts: await response.json() });
}

// 會員訂單以會員自己的 JWT 讀取，由 RLS（members view own orders／order items）限定本人；
// member_id 條件保留作第二層防護。收款帳戶是店家資料、會員不能直接讀表，另以 service role 依 id 補上。
const MEMBER_ORDER_SELECT = "id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,payment_last_five,bank_account_id,created_at,order_items(product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)";

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
    const response = await fetch(url, { headers: serviceHeaders(env) });
    if (!response.ok) return false;
    for (const { id, ...account } of await response.json() as BankAccountRow[]) accounts.set(id, account);
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
  const response = await fetch(url, { headers: memberHeaders(env, authorization) });
  if (!response.ok) return null;
  const rows = await response.json() as MemberOrderRow[];
  if (!rows[0] || !await attachBankAccounts(env, rows)) return null;
  return rows[0];
}

export async function listOrders(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "訂單服務尚未設定" }, { status: 503 });
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", MEMBER_ORDER_SELECT);
  url.searchParams.set("member_id", `eq.${authResult.user.id}`);
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "50");
  const response = await fetch(url, { headers: memberHeaders(env, authResult.authorization) });
  if (!response.ok) return json({ error: "訂單紀錄暫時無法載入" }, { status: 503 });
  const orders = await response.json() as MemberOrderRow[];
  if (!await attachBankAccounts(env, orders)) return json({ error: "訂單紀錄暫時無法載入" }, { status: 503 });
  return json({ orders });
}

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
  const response = await fetch(url, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization } });
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
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/replace_member_cart`, {
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
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "點數服務尚未設定" }, { status: 503 });
  const headers = serviceHeaders(env);
  const member = memberHeaders(env, authResult.authorization);
  const [balanceResponse, ledgerResponse, settingsResponse, couponsResponse] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_point_balance`, {
      method: "POST",
      headers: { ...member, "Content-Type": "application/json" },
      body: "{}"
    }),
    // 點數紀錄以會員 JWT 讀取（RLS：members view own point ledger）；點數設定是全店共用設定，仍由 service role 讀。
    fetch(`${env.SUPABASE_URL}/rest/v1/point_ledger?select=id,kind,points,reason,created_at,orders(order_number)&member_id=eq.${authResult.user.id}&order=created_at.desc&limit=100`, { headers: member }),
    fetch(`${env.SUPABASE_URL}/rest/v1/point_settings?select=earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value&id=eq.true`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_available_coupons`, { method: "POST", headers: { ...member, "Content-Type": "application/json" }, body: "{}" })
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

export async function createOrder(request: Request, env: Env): Promise<Response> {
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
  const order = await loadOrder(env, orderId, user.id, authorization);
  if (!order) return json({ error: "訂單已建立，但明細載入失敗，請至我的訂單查看" }, { status: 502 });
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
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/submit_order_payment`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ p_order_id: orderId, p_bank_account_id: body.bank_account_id, p_payment_last_five: body.payment_last_five })
  });
  if (!response.ok) return databaseError(response);
  const order = await loadOrder(env, orderId, authResult.user.id, authResult.authorization);
  return json({ order });
}
