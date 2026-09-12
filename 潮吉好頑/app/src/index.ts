import {
  buildBirthdayCouponMessage,
  buildLineTestMessage,
  buildLowStockMessage,
  buildOrderNotificationMessage,
  type LineOrderEventType
} from "./line-notification-messages";

interface Env {
  ASSETS: Fetcher;
  STORE_NAME: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_CUSTOM_PROVIDER?: string;
  LINE_AUTH_ENABLED?: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
  LINE_ADMIN_USER_IDS?: string;
  LINE_NOTIFY_ENABLED?: string;
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
  price: number;
  stock: number;
  type: "現貨" | "預購";
  preorder_arrival?: string;
  seller_link?: string;
  image_url?: string;
};

type AuthUser = {
  id: string;
  user_metadata?: Record<string, unknown>;
  identities?: Array<{ identity_data?: Record<string, unknown> }>;
};

const demoProducts: Product[] = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", seller_link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "Cache-Control": "no-store", ...init.headers } });
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith("Bearer ") ? authorization : null;
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
  await syncLineIdentity(env, user);
  return { authorization, user };
}

async function requireAdmin(request: Request, env: Env): Promise<{ authorization: string; user: AuthUser } | Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "管理服務尚未設定" }, { status: 503 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=is_admin&id=eq.${authResult.user.id}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) return json({ error: "無法確認管理員權限" }, { status: 503 });
  const rows = await response.json() as Array<{ is_admin?: boolean }>;
  if (!rows[0]?.is_admin) return json({ error: "僅限管理員使用" }, { status: 403 });
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
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const metadataSources = [user.user_metadata || {}, ...(user.identities || []).map((identity) => identity.identity_data || {})];
  const lineId = metadataSources.flatMap((metadata) => [metadata.line_user_id, metadata.lineUserId, metadata.user_id, metadata.sub])
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  if (!lineId) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}`, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ line_user_id: lineId.trim() })
  });
}

const lineOrderStatusLabels: Record<string, string> = {
  pending_payment: "待付款", pending_review: "待確認款項", confirmed: "已確認付款",
  partially_ready: "部分可取貨", ready_for_pickup: "可取貨", completed: "已完成",
  cancelled: "已取消", refund_pending: "退款處理中", refunded: "已退款"
};

function lineAdminRecipients(env: Env) {
  return (env.LINE_ADMIN_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
}

function lineNotificationEnabled(env: Env) {
  return env.LINE_NOTIFY_ENABLED !== "false" && Boolean(env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN);
}

async function notifyLine(env: Env, eventKey: string, recipientId: string, eventType: string, message: string) {
  if (!lineNotificationEnabled(env) || !recipientId) return false;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return false;
  const claim = await fetch(`${env.SUPABASE_URL}/rest/v1/line_notification_logs`, {
    method: "POST",
    headers: serviceHeaders(env, "resolution=ignore-duplicates,return=representation"),
    body: JSON.stringify({ event_key: eventKey, recipient_id: recipientId, event_type: eventType })
  });
  if (!claim.ok) return false;
  const claimed = await claim.json() as unknown[];
  if (!claimed.length) return true;
  const push = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: recipientId, messages: [{ type: "text", text: message.slice(0, 5000) }] })
  });
  const pushError = push.ok ? null : `LINE ${push.status}: ${(await push.text()).slice(0, 500)}`;
  const logUrl = new URL(`${env.SUPABASE_URL}/rest/v1/line_notification_logs`);
  logUrl.searchParams.set("event_key", `eq.${eventKey}`);
  logUrl.searchParams.set("recipient_id", `eq.${recipientId}`);
  await fetch(logUrl, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=minimal"),
    body: JSON.stringify({ status: push.ok ? "sent" : "failed", error_message: pushError, sent_at: push.ok ? new Date().toISOString() : null })
  });
  return push.ok;
}

async function testLineNotification(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (env.LINE_NOTIFY_ENABLED === "false") return json({ error: "LINE 通知目前已停用" }, { status: 503 });
  if (!env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) return json({ error: "尚未設定 LINE_MESSAGING_CHANNEL_ACCESS_TOKEN" }, { status: 503 });
  const recipients = lineAdminRecipients(env);
  if (!recipients.length) return json({ error: "尚未設定 LINE_ADMIN_USER_IDS" }, { status: 503 });
  const eventKey = `line-test:${crypto.randomUUID()}`;
  const timestamp = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const message = buildLineTestMessage(env.STORE_NAME, timestamp);
  const results = await Promise.allSettled(recipients.map(async (recipientId) => notifyLine(env, `${eventKey}:${recipientId}`, recipientId, "line_test", message)));
  const sent = results.filter((result): result is PromiseFulfilledResult<boolean> => result.status === "fulfilled" && result.value).length;
  if (!sent) return json({ error: "LINE 測試通知未送出，請確認管理員 LINE ID、頻道權杖與 Bot 好友關係" }, { status: 502 });
  return json({ ok: true, sent, total: recipients.length, message: `LINE 測試通知已送出 ${sent}/${recipients.length} 位管理員` });
}

async function loadOrderNotification(env: Env, orderId: string) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set("select", "id,order_number,status,delivery_method,bank_account_id,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,paid_amount,final_payment_last_five,final_payment_confirmed_at,updated_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,profiles!orders_member_id_fkey(full_name,line_user_id),order_items(product_name,variant_name,quantity)");
  url.searchParams.set("id", `eq.${orderId}`);
  const response = await fetch(url, { headers: serviceHeaders(env) });
  if (!response.ok) return null;
  const rows = await response.json() as unknown[];
  return rows[0] as { order_number: string; status: string; delivery_method?: string; bank_account_id?: string | null; shipping_fee?: number; shipping_address?: string | null; shipping_recipient_name?: string | null; shipping_phone?: string | null; shipping_fee_notified_at?: string | null; paid_amount?: number; final_payment_last_five?: string | null; final_payment_confirmed_at?: string | null; updated_at?: string; subtotal: number; coupon_discount: number; point_discount: number; amount_due: number; deposit_due: number; payment_deadline: string; profiles?: { full_name?: string; line_user_id?: string }; order_items?: Array<{ product_name: string; variant_name: string; quantity: number }> };
}

async function notifyOrderEvent(env: Env, orderId: string, eventType: LineOrderEventType) {
  const order = await loadOrderNotification(env, orderId);
  if (!order || !lineNotificationEnabled(env)) return;
  const items = (order.order_items || []).map((item) => `${item.product_name}${item.variant_name === "單一規格" ? "" : ` · ${item.variant_name}`} ×${item.quantity}`).join("、");
  const deliveryLabels: Record<string, string> = { store_pickup: "到店取貨", seller_delivery: "賣貨便", home_delivery: "宅配" };
  const deliveryLine = deliveryLabels[order.delivery_method || "store_pickup"] || "到店取貨";
  const paymentLine = order.bank_account_id ? "匯款／轉帳" : "到店支付";
  const message = buildOrderNotificationMessage({
    storeName: env.STORE_NAME,
    eventType,
    orderStatus: order.status,
    statusLabel: lineOrderStatusLabels[order.status] || order.status,
    orderNumber: order.order_number,
    items,
    deliveryLine,
    paymentLine,
    amountDue: order.amount_due,
    depositDue: order.deposit_due,
    paidAmount: order.paid_amount ?? order.deposit_due,
    shippingFee: order.shipping_fee ?? 0,
    finalPaymentConfirmed: Boolean(order.final_payment_confirmed_at),
    shippingRecipientName: order.shipping_recipient_name,
    shippingPhone: order.shipping_phone,
    shippingAddress: order.shipping_address
  });
  const recipients = new Set<string>(lineAdminRecipients(env));
  // 會員回報匯款只通知管理員；管理員確認訂金後的 status_changed 才通知會員。
  if (eventType !== "payment_reported" && order.profiles?.line_user_id) recipients.add(order.profiles.line_user_id);
  const eventKey = eventType === "status_changed"
    ? `${eventType}:${orderId}:${order.status}:${order.updated_at || "current"}`
    : eventType === "fulfillment_updated"
      ? `${eventType}:${orderId}:${order.updated_at || "current"}`
      : `${eventType}:${orderId}`;
  await Promise.allSettled([...recipients].map((recipient) => notifyLine(env, eventKey, recipient, `order_${eventType}`, message)));
}

async function notifyLowStock(env: Env) {
  if (!lineNotificationEnabled(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !lineAdminRecipients(env).length) return;
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
  const sent = await Promise.all(lineAdminRecipients(env).map((recipient) => notifyLine(env, eventKey, recipient, "low_stock", buildLowStockMessage(env.STORE_NAME, lines))));
  if (sent.some(Boolean)) {
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
    await notifyLine(env, `birthday:${coupon.id}`, member.profiles.line_user_id, "birthday_coupon", buildBirthdayCouponMessage(env.STORE_NAME, { name: coupon.name, code: coupon.code, discountAmount: coupon.discount_amount }));
  }
}

async function runScheduledNotifications(env: Env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/issue_birthday_coupons`, { method: "POST", headers: serviceHeaders(env), body: "{}" });
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
  STORE_PAYMENT_ONLY_STORE_PICKUP: "到店支付僅適用到店取貨",
  STORE_PAYMENT_PREORDER_NOT_ALLOWED: "預購商品必須先匯款支付訂金",
  INVALID_BANK_ACCOUNT: "收款帳戶無效或已停用",
  INVALID_PAYMENT_LAST_FIVE: "匯款帳號末五碼格式不正確",
  INVALID_FINAL_PAYMENT_LAST_FIVE: "尾款匯款末五碼格式不正確",
  INVALID_SHIPPING_FEE: "實際運費必須是 0 或正整數",
  SHIPPING_FEE_STORE_PICKUP: "到店取貨不可設定寄送運費",
  SELLER_DELIVERY_NO_SHIPPING_FEE: "賣貨便運費由 7-11 向客戶收取，不計入訂單",
  FINAL_PAYMENT_REQUIRED: "請填寫尾款匯款末五碼並確認尾款與運費已入帳",
  FINAL_PAYMENT_NOT_ALLOWED: "訂單尚未進入可出貨或可取貨狀態",
  ORDER_FULFILLMENT_NOT_EDITABLE: "此訂單目前不可修改尾款或運費資訊",
  INVALID_QUANTITY: "商品數量不正確",
  PRODUCT_NOT_FOUND: "商品已下架或不存在",
  INSUFFICIENT_STOCK: "商品庫存不足，請重新整理購物車",
  ORDER_NOT_PAYABLE: "訂單已逾期、已回報付款或無法付款",
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
  INVALID_BIRTHDAY_SETTINGS: "生日券設定不正確"
};

async function databaseError(response: Response) {
  let payload: { message?: string } = {};
  try { payload = await response.json() as { message?: string }; } catch { /* ignore malformed upstream errors */ }
  const matched = Object.keys(databaseErrors).find((code) => payload.message?.includes(code));
  return json({ error: matched ? databaseErrors[matched] : "訂單服務暫時無法處理" }, { status: response.status >= 500 ? 503 : 400 });
}

async function publicCatalog(env: Env): Promise<Product[]> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return demoProducts;
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/storefront_variants?select=*&is_published=eq.true&order=display_order.asc`, {
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

const PRODUCT_IMAGE_BUCKET = "product-images";
const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PRODUCT_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
};

function storageObjectUrl(env: Env, path: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_IMAGE_BUCKET}/${encodedPath}`;
}

async function serveProductImage(env: Env, productId: string): Promise<Response> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "圖片服務尚未設定" }, { status: 503 });
  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=image_path&id=eq.${productId}&limit=1`, {
    headers: serviceHeaders(env)
  });
  if (!productResponse.ok) return json({ error: "圖片暫時無法載入" }, { status: 503 });
  const products = await productResponse.json() as Array<{ image_path?: string }>;
  const imagePath = products[0]?.image_path;
  if (!imagePath) return json({ error: "商品尚未上傳照片" }, { status: 404 });
  const imageResponse = await fetch(storageObjectUrl(env, imagePath), {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!imageResponse.ok || !imageResponse.body) return json({ error: "圖片暫時無法載入" }, { status: imageResponse.status === 404 ? 404 : 503 });
  return new Response(imageResponse.body, {
    headers: {
      "Content-Type": imageResponse.headers.get("Content-Type") || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    }
  });
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

  const productResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?select=id,image_path&id=eq.${productId}&limit=1`, { headers: serviceHeaders(env) });
  if (!productResponse.ok) return json({ error: "無法確認商品資料" }, { status: 503 });
  const productRows = await productResponse.json() as Array<{ id: string; image_path?: string }>;
  if (!productRows.length) return json({ error: "找不到商品" }, { status: 404 });
  const previousImagePath = productRows[0].image_path;

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
  const updateResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
    method: "PATCH",
    headers: serviceHeaders(env, "return=representation"),
    body: JSON.stringify({ image_path: imagePath, image_updated_at: updatedAt, updated_at: updatedAt })
  });
  if (!updateResponse.ok) return databaseError(updateResponse);
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
    authEnabled: lineEnabled
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

async function memberPoints(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "點數服務尚未設定" }, { status: 503 });
  const headers = serviceHeaders(env);
  const [ledgerResponse, settingsResponse, couponsResponse] = await Promise.all([
    fetch(`${env.SUPABASE_URL}/rest/v1/point_ledger?select=id,kind,points,reason,created_at,orders(order_number)&member_id=eq.${authResult.user.id}&order=created_at.desc&limit=100`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/point_settings?select=earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value&id=eq.true`, { headers }),
    fetch(`${env.SUPABASE_URL}/rest/v1/rpc/member_available_coupons`, { method: "POST", headers: { apikey: env.SUPABASE_ANON_KEY as string, Authorization: authResult.authorization, "Content-Type": "application/json" }, body: "{}" })
  ]);
  if (!ledgerResponse.ok || !settingsResponse.ok || !couponsResponse.ok) return json({ error: "點數與優惠券資料暫時無法載入" }, { status: 503 });
  const ledger = await ledgerResponse.json() as Array<{ points: number }>;
  const settings = await settingsResponse.json() as unknown[];
  return json({ balance: ledger.reduce((sum, entry) => sum + entry.points, 0), ledger, settings: settings[0] || null, coupons: await couponsResponse.json() });
}

async function memberLineFriendship(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN) return json({ error: "LINE 好友狀態服務尚未設定" }, { status: 503 });
  const profileResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=line_user_id&id=eq.${authResult.user.id}&limit=1`, { headers: serviceHeaders(env) });
  if (!profileResponse.ok) return json({ error: "無法讀取 LINE 會員資料" }, { status: 503 });
  const profiles = await profileResponse.json() as Array<{ line_user_id?: string | null }>;
  const lineUserId = profiles[0]?.line_user_id;
  if (!lineUserId) return json({ friendFlag: false, reason: "LINE_ID_MISSING" });
  const lineLoginAccessToken = request.headers.get("X-LINE-Login-Access-Token");
  if (lineLoginAccessToken) {
    const [friendshipResponse, profileCheckResponse] = await Promise.all([
      fetch("https://api.line.me/friendship/v1/status", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } }),
      fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${lineLoginAccessToken}` } })
    ]);
    if (friendshipResponse.ok && profileCheckResponse.ok) {
      const friendship = await friendshipResponse.json() as { friendFlag?: boolean };
      const lineProfile = await profileCheckResponse.json() as { userId?: string };
      if (lineProfile.userId !== lineUserId) return json({ error: "LINE 會員驗證不一致，請重新登入" }, { status: 401 });
      return json({ friendFlag: friendship.friendFlag === true, source: "line_login" });
    }
    if ([401, 403].includes(friendshipResponse.status) || [401, 403].includes(profileCheckResponse.status)) return json({ error: "LINE 登入授權已過期，請重新登入" }, { status: 401 });
  }
  const lineResponse = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
    headers: { Authorization: `Bearer ${env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN}` }
  });
  if (lineResponse.ok) return json({ friendFlag: true });
  if (lineResponse.status === 404) return json({ friendFlag: false, reason: "NOT_FRIEND_OR_BLOCKED" });
  return json({ error: "LINE 好友狀態暫時無法確認" }, { status: 503 });
}

async function adminDashboard(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const base = env.SUPABASE_URL as string;
  const headers = serviceHeaders(env);
  const [productsResponse, accountsResponse, movementsResponse, ordersResponse, historyResponse, membersResponse, pointsResponse, pointSettingsResponse, couponsResponse, birthdaySettingsResponse] = await Promise.all([
    fetch(`${base}/rest/v1/products?select=id,name,description,image_path,image_updated_at,purchase_limit,is_published,display_order,category_id,categories(name),product_variants(id,name,sku,kind,price,stock_on_hand,safety_stock,preorder_arrival,deposit_rate,seller_link,is_published,display_order,updated_at)&order=display_order.asc`, { headers }),
    fetch(`${base}/rest/v1/bank_accounts?select=id,label,bank_name,account_name,account_number,is_active,display_order,created_at&order=display_order.asc`, { headers }),
    fetch(`${base}/rest/v1/inventory_movements?select=id,variant_id,kind,quantity_delta,reason,created_at,product_variants(name,sku,products(name))&order=created_at.desc&limit=50`, { headers }),
    fetch(`${base}/rest/v1/orders?select=id,member_id,order_number,status,pickup_plan,delivery_method,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,final_payment_last_five,final_payment_confirmed_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,paid_amount,payment_deadline,payment_last_five,bank_account_id,admin_note,confirmed_at,payment_confirmed_at,completed_at,cancelled_at,created_at,profiles!orders_member_id_fkey(full_name,phone),bank_accounts(label,bank_name,account_name,account_number),order_items(id,product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)&order=created_at.desc&limit=200`, { headers }),
    fetch(`${base}/rest/v1/order_status_history?select=id,order_id,from_status,to_status,note,created_at,profiles(full_name)&order=created_at.desc&limit=500`, { headers }),
    fetch(`${base}/rest/v1/admin_member_summary?select=id,full_name,phone,birthday,address,is_admin,created_at,point_balance,lifetime_spend,order_count&order=created_at.desc`, { headers }),
    fetch(`${base}/rest/v1/point_ledger?select=id,member_id,order_id,kind,points,reason,created_at,profiles!point_ledger_member_id_fkey(full_name),actor:profiles!point_ledger_actor_id_fkey(full_name),orders(order_number)&order=created_at.desc&limit=500`, { headers }),
    fetch(`${base}/rest/v1/point_settings?select=earn_amount_per_point,point_value,min_redeem_points,max_redeem_mode,max_redeem_value,updated_at&id=eq.true`, { headers }),
    fetch(`${base}/rest/v1/coupons?select=id,code,name,discount_amount,combinable_with_points,valid_from,valid_until,total_usage_limit,per_member_limit,is_active,is_birthday,created_at,coupon_products(product_id),coupon_members(member_id),coupon_redemptions(id)&order=created_at.desc`, { headers }),
    fetch(`${base}/rest/v1/birthday_coupon_settings?select=enabled,discount_amount,issue_days_before,valid_days,combinable_with_points,updated_at&id=eq.true`, { headers })
  ]);
  if (![productsResponse, accountsResponse, movementsResponse, ordersResponse, historyResponse, membersResponse, pointsResponse, pointSettingsResponse, couponsResponse, birthdaySettingsResponse].every((response) => response.ok)) {
    return json({ error: "管理資料暫時無法載入" }, { status: 503 });
  }
  const [products, accounts, movements, orders, orderHistory, members, pointEntries, pointSettings, coupons, birthdaySettings] = await Promise.all([
    productsResponse.json(), accountsResponse.json(), movementsResponse.json(), ordersResponse.json() as Promise<Array<{ status: string }>>, historyResponse.json(), membersResponse.json(), pointsResponse.json(), pointSettingsResponse.json() as Promise<unknown[]>, couponsResponse.json(), birthdaySettingsResponse.json() as Promise<unknown[]>
  ]);
  return json({
    products,
    accounts,
    movements,
    orders,
    orderHistory,
    members,
    pointEntries,
    pointSettings: pointSettings[0] || null,
    coupons,
    birthdaySettings: birthdaySettings[0] || null,
    stats: {
      pendingReview: orders.filter((order) => order.status === "pending_review").length,
      readyForPickup: orders.filter((order) => ["partially_ready", "ready_for_pickup"].includes(order.status)).length,
      lowStock: (products as Array<{ product_variants?: Array<{ stock_on_hand: number; safety_stock: number }> }>).flatMap((product) => product.product_variants || []).filter((variant) => variant.stock_on_hand <= variant.safety_stock).length,
      memberCount: (members as unknown[]).length
    }
  });
}

const adminOrderStatuses = ["pending_payment", "pending_review", "confirmed", "partially_ready", "ready_for_pickup", "completed", "cancelled", "refund_pending", "refunded"] as const;

async function transitionAdminOrder(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { target_status?: string; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!adminOrderStatuses.includes(body.target_status as typeof adminOrderStatuses[number])) return json({ error: "訂單狀態不正確" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_transition_order`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_order_id: orderId, p_target_status: body.target_status, p_note: body.note?.trim() || null })
  });
  if (!response.ok) return databaseError(response);
  return json({ order: await response.json() });
}

async function updateAdminOrderFulfillment(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { shipping_fee?: number; final_payment_confirmed?: boolean; final_payment_last_five?: string; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.shipping_fee) || (body.shipping_fee as number) < 0) return json({ error: "實際運費必須是 0 或正整數" }, { status: 400 });
  if (body.final_payment_last_five && !/^\d{5}$/.test(body.final_payment_last_five)) return json({ error: "尾款匯款末五碼須為 5 位數字" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  const orderLookup = await fetch(`${env.SUPABASE_URL}/rest/v1/orders?select=delivery_method&id=eq.${orderId}&limit=1`, { headers: serviceHeaders(env) });
  if (!orderLookup.ok) return json({ error: "訂單資料暫時無法讀取" }, { status: 503 });
  const orderRows = await orderLookup.json() as Array<{ delivery_method?: string }>;
  if (!orderRows.length) return json({ error: "找不到訂單" }, { status: 404 });
  const sellerDelivery = orderRows[0].delivery_method === "seller_delivery";
  if (sellerDelivery && body.shipping_fee !== 0) return json({ error: "賣貨便運費由 7-11 向客戶收取，不計入訂單" }, { status: 400 });
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
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/bank_accounts`, {
    method: "POST", headers: serviceHeaders(env, "return=representation"), body: JSON.stringify(validated.value)
  });
  if (!response.ok) return databaseError(response);
  return json({ account: (await response.json() as unknown[])[0] }, { status: 201 });
}

async function updateBankAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: BankAccountInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateBankAccount(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/bank_accounts?id=eq.${accountId}`, {
    method: "PATCH", headers: serviceHeaders(env, "return=representation"), body: JSON.stringify(validated.value)
  });
  if (!response.ok) return databaseError(response);
  const rows = await response.json() as unknown[];
  if (!rows.length) return json({ error: "找不到收款帳戶" }, { status: 404 });
  return json({ account: rows[0] });
}

type ProductInput = {
  category_name?: string; product_name?: string; description?: string; variant_name?: string; sku?: string;
  kind?: "in_stock" | "preorder"; price?: number; stock?: number; preorder_arrival?: string;
  deposit_rate?: number; seller_link?: string; purchase_limit?: number | null; is_published?: boolean;
};

async function createAdminProduct(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: ProductInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.category_name?.trim() || !body.product_name?.trim() || !body.sku?.trim()) return json({ error: "請填寫分類、商品名稱與 SKU" }, { status: 400 });
  if (!Number.isInteger(body.price) || (body.price as number) < 0 || !Number.isInteger(body.stock) || (body.stock as number) < 0) return json({ error: "價格與庫存須為非負整數" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return json({ error: "商品類型不正確" }, { status: 400 });
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_product`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_category_name: body.category_name,
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
      p_purchase_limit: body.purchase_limit ?? null
    })
  });
  if (!response.ok) return databaseError(response);
  const ids = await response.json() as { product_id?: string; variant_id?: string };
  return json({ ids }, { status: 201 });
}

type VariantInput = {
  product_id?: string; name?: string; sku?: string; kind?: "in_stock" | "preorder"; price?: number;
  safety_stock?: number; preorder_arrival?: string; deposit_rate?: number; seller_link?: string;
  is_published?: boolean; display_order?: number;
};

function normalizedVariant(body: VariantInput, includeProduct = false) {
  if (!body.name?.trim() || !body.sku?.trim() || !Number.isInteger(body.price) || (body.price as number) < 0) return { error: "請填寫規格名稱、SKU 與正確價格" };
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return { error: "商品類型不正確" };
  if (includeProduct && !body.product_id) return { error: "請選擇商品" };
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  if (!Number.isFinite(depositRate) || depositRate < 0 || depositRate > 1) return { error: "訂金比例須介於 0% 至 100%" };
  return { value: {
    ...(includeProduct ? { product_id: body.product_id } : {}), name: body.name.trim(), sku: body.sku.trim().toUpperCase(), kind: body.kind,
    price: body.price, safety_stock: Number.isInteger(body.safety_stock) ? body.safety_stock : 3,
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
  const payload = { ...validated.value, stock_on_hand: 0 };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/product_variants`, {
    method: "POST", headers: serviceHeaders(env, "return=representation"), body: JSON.stringify(payload)
  });
  if (!response.ok) return databaseError(response);
  return json({ variant: (await response.json() as unknown[])[0] }, { status: 201 });
}

async function updateVariant(request: Request, env: Env, variantId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: VariantInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = normalizedVariant(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/product_variants?id=eq.${variantId}`, {
    method: "PATCH", headers: serviceHeaders(env, "return=representation"), body: JSON.stringify(validated.value)
  });
  if (!response.ok) return databaseError(response);
  const rows = await response.json() as unknown[];
  if (!rows.length) return json({ error: "找不到商品規格" }, { status: 404 });
  return json({ variant: rows[0] });
}

async function updateProduct(request: Request, env: Env, productId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { name?: string; description?: string; category_id?: string; purchase_limit?: number | null; is_published?: boolean; display_order?: number };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.name?.trim()) return json({ error: "請填寫商品名稱" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  const payload = { name: body.name.trim(), description: body.description || "", category_id: body.category_id || null, purchase_limit: body.purchase_limit ?? null, is_published: body.is_published === true, display_order: Number.isInteger(body.display_order) ? body.display_order : 0, updated_at: new Date().toISOString() };
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/products?id=eq.${productId}`, {
    method: "PATCH", headers: serviceHeaders(env, "return=representation"), body: JSON.stringify(payload)
  });
  if (!response.ok) return databaseError(response);
  const rows = await response.json() as unknown[];
  if (!rows.length) return json({ error: "找不到商品" }, { status: 404 });
  return json({ product: rows[0] });
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
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  let body: { items?: Array<{ variant_id: string; quantity: number }>; pickup_plan?: "together" | "split"; delivery_method?: "store_pickup" | "seller_delivery" | "home_delivery"; payment_method?: "bank_transfer" | "store_payment"; shipping_address?: string; shipping_recipient_name?: string; shipping_phone?: string; coupon_code?: string; points_to_redeem?: number; bank_account_id?: string; payment_last_five?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Array.isArray(body.items) || body.items.length === 0) return json({ error: "購物車不可為空" }, { status: 400 });
  if (body.items.some((item) => !item.variant_id || !Number.isInteger(item.quantity) || item.quantity < 1)) return json({ error: "商品數量錯誤" }, { status: 400 });
  const paymentMethod = body.payment_method ?? (body.bank_account_id ? "bank_transfer" : "store_payment");
  if (!['bank_transfer', 'store_payment'].includes(paymentMethod)) return json({ error: "付款方式不正確" }, { status: 400 });
  if (paymentMethod === "store_payment" && body.delivery_method && body.delivery_method !== "store_pickup") return json({ error: "到店支付僅適用到店取貨" }, { status: 400 });
  if (paymentMethod === "bank_transfer" && !body.bank_account_id) return json({ error: "請選擇收款帳戶" }, { status: 400 });
  if (!Number.isInteger(body.points_to_redeem ?? 0) || (body.points_to_redeem ?? 0) < 0) return json({ error: "點數使用數量不正確" }, { status: 400 });
  const deliveryMethod = body.delivery_method ?? "store_pickup";
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
    if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, store: env.STORE_NAME, database: Boolean(env.SUPABASE_URL) });
    if (request.method === "GET" && url.pathname === "/api/config") return json(await runtimeConfig(env));
    if (request.method === "GET" && url.pathname === "/api/catalog") {
      try { return json({ products: await publicCatalog(env) }); }
      catch { return json({ error: "商品暫時無法載入" }, { status: 503 }); }
    }
    const productImageMatch = url.pathname.match(/^\/api\/product-images\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && productImageMatch) return serveProductImage(env, productImageMatch[1]);
    if (request.method === "GET" && url.pathname === "/api/bank-accounts") return listBankAccounts(request, env);
    if (request.method === "GET" && url.pathname === "/api/orders") return listOrders(request, env);
    if (request.method === "GET" && url.pathname === "/api/member/points") return memberPoints(request, env);
    if (request.method === "GET" && url.pathname === "/api/member/line-friendship") return memberLineFriendship(request, env);
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
    if (request.method === "POST" && url.pathname === "/api/admin/line-test") return testLineNotification(request, env);
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
    if (url.pathname.startsWith("/api/")) return json({ error: "找不到 API" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduledNotifications(env));
  }
} satisfies ExportedHandler<Env>;
