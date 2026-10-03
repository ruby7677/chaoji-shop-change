// 訂單事件、低庫存、生日券通知與每小時排程補送；實際發送與重試狀態機在 notification-delivery.ts。
import { type LinePushMessage, type OrderNotificationEventType, buildBirthdayCouponMessage, buildLineBirthdayFlexMessage, buildLineOrderFlexMessage, buildLowStockMessage, buildOrderNotificationMessage, buildTelegramOrderNotificationMessage, buildTelegramTestMessage, routeOrderNotificationRecipients } from "./line-notification-messages";
import { type DeliveryResult, deliverLineNotification, deliverTelegramNotification } from "./notification-delivery";
import { requireAdmin } from "./auth";
import { type Env } from "./env";
import { fetchWithTimeout, json, serviceHeaders } from "./http";

const lineOrderStatusLabels: Record<string, string> = {
  pending_payment: "待付款", pending_review: "待確認款項", confirmed: "已確認付款",
  partially_ready: "部分到貨", ready_for_pickup: "配送處理中", completed: "已完成訂單",
  cancelled: "已取消"
};

// 狀態文字帶出實際金額：確認付款顯示後台確認收到的金額（paid_amount），取消顯示退款金額（refunded_amount）
export function orderStatusLabel(status: string, refundedAmount?: number | null, paidAmount?: number | null) {
  const ntd = (value: number) => `NT$${value.toLocaleString("zh-TW")}`;
  const refund = Number(refundedAmount || 0);
  const paid = Number(paidAmount || 0);
  if (status === "confirmed" && paid > 0) return `已確認付款 ${ntd(paid)}`;
  if (status === "cancelled") return refund > 0 ? `已取消訂單，並已退款 ${ntd(refund)}` : "已取消訂單";
  return lineOrderStatusLabels[status] || status;
}

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

export async function testTelegramNotification(request: Request, env: Env): Promise<Response> {
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
  url.searchParams.set("select", "id,order_number,status,delivery_method,bank_account_id,shipping_fee,shipping_address,shipping_recipient_name,shipping_phone,shipping_fee_notified_at,paid_amount,refunded_amount,final_payment_last_five,final_payment_confirmed_at,updated_at,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,profiles!orders_member_id_fkey(full_name,line_user_id,is_admin),order_items(product_name,variant_name,quantity,kind)");
  url.searchParams.set("id", `eq.${orderId}`);
  let response: Response;
  // 這裡沒有上層 try/catch（呼叫端以 ctx.waitUntil 執行），逾時或網路錯誤需自行吞掉，
  // 否則會變成未處理的 rejection；失敗一律視為「這次通知讀不到訂單」，回 null。
  try { response = await fetchWithTimeout(url, { headers: serviceHeaders(env) }); }
  catch { return null; }
  if (!response.ok) return null;
  const rows = await response.json() as unknown[];
  return rows[0] as { order_number: string; status: string; delivery_method?: string; bank_account_id?: string | null; shipping_fee?: number; shipping_address?: string | null; shipping_recipient_name?: string | null; shipping_phone?: string | null; shipping_fee_notified_at?: string | null; paid_amount?: number; refunded_amount?: number | null; final_payment_last_five?: string | null; final_payment_confirmed_at?: string | null; updated_at?: string; subtotal: number; coupon_discount: number; point_discount: number; amount_due: number; deposit_due: number; payment_deadline: string; profiles?: { full_name?: string; line_user_id?: string; is_admin?: boolean }; order_items?: Array<{ product_name: string; variant_name: string; quantity: number; kind?: string }> };
}

/** Resolves true once every recipient's notification is sent or owned by the delivery state machine. */

export async function notifyOrderEvent(env: Env, orderId: string, eventType: OrderNotificationEventType): Promise<boolean> {
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
    statusLabel: orderStatusLabel(order.status, order.refunded_amount, order.paid_amount),
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

export async function notifyLowStock(env: Env) {
  const recipients = telegramAdminRecipients(env);
  if (!telegramNotificationEnabled(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !recipients.length) return;
  const base = env.SUPABASE_URL;
  const headers = serviceHeaders(env);
  // 低庫存唯一定義在資料庫 low_stock_variants（商品與規格都上架、庫存 ≤ 安全庫存），與後台統計、清單一致。
  const [lowResponse, statesResponse] = await Promise.all([
    fetchWithTimeout(`${base}/rest/v1/rpc/low_stock_variants`, { method: "POST", headers, body: "{}" }),
    fetchWithTimeout(`${base}/rest/v1/line_low_stock_states?select=variant_id,last_notified_stock,last_notified_at`, { headers })
  ]);
  if (!lowResponse.ok || !statesResponse.ok) return;
  const low = await lowResponse.json() as Array<{ id: string; name: string; sku: string; product_name: string | null; stock_on_hand: number; safety_stock: number }>;
  const states = await statesResponse.json() as Array<{ variant_id: string; last_notified_stock: number | null }>;
  const stateMap = new Map(states.map((state) => [state.variant_id, state]));
  const lowIds = new Set(low.map((variant) => variant.id));
  const toNotify = low.filter((variant) => {
    const previous = stateMap.get(variant.id)?.last_notified_stock;
    return previous == null || variant.stock_on_hand < previous;
  });
  // 已通知過、但現在不在低庫存名單（補貨或下架）的規格重設狀態，之後再低於門檻會重新通知。
  const recovered = states.filter((state) => state.last_notified_stock != null && !lowIds.has(state.variant_id)).map((state) => state.variant_id);
  if (recovered.length) {
    await fetchWithTimeout(`${base}/rest/v1/line_low_stock_states?variant_id=in.(${recovered.join(",")})`, { method: "PATCH", headers: serviceHeaders(env, "return=minimal"), body: JSON.stringify({ last_notified_stock: null, last_notified_at: null, updated_at: new Date().toISOString() }) });
  }
  if (!toNotify.length) return;
  const lines = toNotify.map((variant) => `• ${variant.product_name || "商品"} · ${variant.name}：剩 ${variant.stock_on_hand} 件`);
  // 以台灣日期去重：同一台灣日內相同庫存狀態只通知一次（原本用 UTC 日期，台灣早上 8 點才換日）。
  const eventKey = `low-stock:${taipeiDate(new Date())}:${toNotify.map((item) => `${item.id}-${item.stock_on_hand}`).join(",")}`;
  const sent = await Promise.all(recipients.map((chatId) => notifyTelegram(env, eventKey, chatId, "low_stock", buildLowStockMessage(env.STORE_NAME, lines))));
  if (sent.some((result) => result.sent)) {
    for (const variant of toNotify) {
      await fetchWithTimeout(`${base}/rest/v1/line_low_stock_states`, { method: "POST", headers: serviceHeaders(env, "resolution=merge-duplicates,return=minimal"), body: JSON.stringify({ variant_id: variant.id, last_notified_stock: variant.stock_on_hand, last_notified_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
    }
  }
}

const BIRTHDAY_COUPON_WINDOW_MS = 48 * 60 * 60 * 1000;

/** 台灣日期（YYYY-MM-DD）。 */
export function taipeiDate(date: Date) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date);
}

export async function notifyBirthdayCoupons(env: Env) {
  if (!lineNotificationEnabled(env) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  // 近 48 小時內發出的生日券。原本以 Worker 的 UTC 午夜為「今天」起點，台灣早上 8 點前手動發券會在
  // 下一次每小時排程跨過 UTC 午夜後漏發；event key 以券 id 去重，視窗重疊不會重複通知。
  const start = new Date(Date.now() - BIRTHDAY_COUPON_WINDOW_MS);
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/coupons`);
  url.searchParams.set("select", "id,code,name,discount_amount,coupon_members(member_id,profiles(line_user_id))");
  url.searchParams.set("is_birthday", "eq.true");
  url.searchParams.set("created_at", `gte.${start.toISOString()}`);
  const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
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
    const response = await fetchWithTimeout(url, { headers });
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
      await fetchWithTimeout(markUrl, {
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

export async function runScheduledNotifications(env: Env) {
  await notifyRecentlyCancelledOrders(env);
  await notifyBirthdayCoupons(env);
  await notifyLowStock(env);
}
