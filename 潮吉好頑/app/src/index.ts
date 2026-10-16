import { runFiveMinuteNotifications } from "./notification-schedule";
import { createProductShowcase, isShowcaseImageUpload } from "./product-showcase";
import { isShareMetaRequest, withShareMeta } from "./share-meta";
import { isOrdersPageRequest, withOrdersBootData } from "./orders-page";
import { backfillProductImageDimensions } from "./product-image-dimensions";
import { createWebSession } from "./web-session";
import { adjustInventory, archiveProduct, createAdminCategory, createAdminProduct, createVariant, updateAdminCategory, updateProduct, updateVariant } from "./admin-catalog";
import { adminAuditLogs, adminDashboard, adminNotificationDeliveries, requeueAdminNotificationDelivery } from "./admin-dashboard";
import { transitionAdminOrder, updateAdminOrderFulfillment } from "./admin-orders";
import { adjustMemberPoints, createBankAccount, issueBirthdayCoupons, saveCoupon, updateBankAccount, updateBirthdaySettings, updatePointSettings } from "./admin-settings";
import { forgetLiffSession, hasLineIdentity, refreshedAuthUser, rememberLiffSession, requireAdmin, restoreLiffSession, syncMemberIdentity, verifyLiffIdentity } from "./auth";
import { publicCatalog, runtimeConfig } from "./catalog";
import { serveProductImage, uploadProductImage } from "./product-image-primary";
import { databaseError, databaseErrors } from "./database-errors";
import { canonicalRedirect } from "./canonical-host";
import { listCvsStores, publishCvsStores, rollbackCvsStores, stageCvsCity } from "./cvs-stores-admin";
import { isCvsStoresRequest, serveCvsStores } from "./cvs-stores-serve";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, SECURITY_HEADERS, enforceRateLimit, json, serviceHeaders, withSecurityHeaders } from "./http";
import { previewCheckoutCoupon } from "./coupon-preview";
import { createOrder, listBankAccounts, listMemberCart, listOrders, memberLineFriendship, memberPoints, ordersForRestoredSession, replaceMemberCart, submitOrderPayment } from "./member-api";
import { notifyOrderEvent, notifyOrderEventToMember, runScheduledNotifications, testTelegramNotification } from "./notifications";
import { isKeepaliveHour, pingSupabase } from "./supabase-keepalive";
import { BACKUP_CRON, runDailyBackup } from "./database-backup";

const productShowcase = createProductShowcase<Env>({ json, serviceHeaders, requireAdmin, databaseError, securityHeaders: SECURITY_HEADERS });

const webSession = createWebSession<Env>({
  json,
  enforceRateLimit,
  lineMemberId: async (env, session) => {
    const user = await refreshedAuthUser(env, session);
    return user && hasLineIdentity(user, env) ? user.id : null;
  }
});

// 實際路由邏輯抽成獨立函式：Worker 的 fetch 進入點以 `return await handleRequest(...)`
// 呼叫它，讓外層 try/catch 真正攔截到內部各個 `return xxxHandler(...)`（未 await）路由分派
// 之後才發生的例外或 rejected promise，而不只是同步拋出的錯誤。
async function handleRequest(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const redirect = canonicalRedirect(request, env, url);
  if (redirect) return redirect;
  const isProductImageUpload = request.method === "POST" && /^\/api\/admin\/products\/[0-9a-f-]{36}\/image$/i.test(url.pathname);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (url.pathname.startsWith("/api/") && ["POST", "PUT", "PATCH"].includes(request.method) && !isProductImageUpload && !isShowcaseImageUpload(request, url) && Number.isFinite(contentLength) && contentLength > MAX_JSON_REQUEST_BYTES) {
    return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });
  }
  if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, store: env.STORE_NAME, database: Boolean(env.SUPABASE_URL) });
  if (request.method === "POST" && url.pathname === "/api/auth/liff/verify") return verifyLiffIdentity(request, env);
  if (request.method === "POST" && url.pathname === "/api/auth/session/remember") return rememberLiffSession(request, env);
  if (request.method === "POST" && url.pathname === "/api/auth/session/restore") return restoreLiffSession(request, env, ordersForRestoredSession);
  if (request.method === "POST" && url.pathname === "/api/auth/session/forget") return forgetLiffSession();
  const webSessionResponse = await webSession.route(request, env, url);
  if (webSessionResponse) return webSessionResponse;
  if (request.method === "GET" && url.pathname === "/api/config") {
    // Runtime config only contains public, non-member-specific bootstrap data.
    // Keep every other JSON response on the default no-store policy.
    return json(await runtimeConfig(env), { headers: { "Cache-Control": "public, max-age=300, s-maxage=300" } });
  }
  if (request.method === "GET" && url.pathname === "/api/catalog") {
    try { return json({ products: await publicCatalog(env, url.origin) }); }
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
  if (request.method === "POST" && url.pathname === "/api/checkout/coupon-preview") return previewCheckoutCoupon(request, env);
  if (request.method === "POST" && url.pathname === "/api/orders") {
    const response = await createOrder(request, env);
    if (response.ok) {
      try {
        const payload = await response.clone().json() as { order?: { id?: string } | null; order_id?: string };
        // 明細讀不到時回應只有 order_id；訂單已建立，通知照送（通知以 event key 去重，不會重複）
        const orderId = payload.order?.id ?? payload.order_id;
        if (orderId) ctx.waitUntil(notifyOrderEvent(env, orderId, "created"));
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
    if (response.ok) ctx.waitUntil(Promise.allSettled([notifyOrderEvent(env, orderTransitionMatch[1], "status_changed")]));
    return response;
  }
  const orderFulfillmentMatch = url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})\/fulfillment$/i);
  if (request.method === "PATCH" && orderFulfillmentMatch) {
    const response = await updateAdminOrderFulfillment(request, env, orderFulfillmentMatch[1]);
    if (!response.ok) return response;
    // 宅配運費／尾款通知是客人匯款的依據：等通知送出或交給重試機制後才回應，
    // 沒成功時告訴管理員重按一次（每次儲存都是新的通知事件）
    const notificationQueued = await notifyOrderEventToMember(env, orderFulfillmentMatch[1], "fulfillment_updated").catch(() => false);
    const body = await response.json() as Record<string, unknown>;
    return json({ ...body, notification_queued: notificationQueued });
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
  if (request.method === "POST" && url.pathname === "/api/admin/categories") return createAdminCategory(request, env);
  const categoryMatch = url.pathname.match(/^\/api\/admin\/categories\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && categoryMatch) return updateAdminCategory(request, env, categoryMatch[1]);
  if (request.method === "POST" && url.pathname === "/api/admin/products") return createAdminProduct(request, env);
  const productMatch = url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})$/i);
  const productImageUploadMatch = url.pathname.match(/^\/api\/admin\/products\/([0-9a-f-]{36})\/image$/i);
  if (request.method === "POST" && productImageUploadMatch) return uploadProductImage(request, env, productImageUploadMatch[1]);
  if (request.method === "PATCH" && productMatch) return updateProduct(request, env, productMatch[1]);
  if (request.method === "DELETE" && productMatch) return archiveProduct(request, env, productMatch[1]);
  if (request.method === "POST" && url.pathname === "/api/admin/variants") return createVariant(request, env);
  const variantMatch = url.pathname.match(/^\/api\/admin\/variants\/([0-9a-f-]{36})$/i);
  if (request.method === "PATCH" && variantMatch) return updateVariant(request, env, variantMatch[1]);
  const inventoryMatch = url.pathname.match(/^\/api\/admin\/variants\/([0-9a-f-]{36})\/inventory$/i);
  if (request.method === "POST" && inventoryMatch) {
    return adjustInventory(request, env, inventoryMatch[1]);
  }
  if (request.method === "GET" && url.pathname === "/api/admin/cvs-stores") return listCvsStores(request, env);
  if (request.method === "PUT" && url.pathname === "/api/admin/cvs-stores/stage") return stageCvsCity(request, env);
  if (request.method === "POST" && url.pathname === "/api/admin/cvs-stores/publish") return publishCvsStores(request, env);
  if (request.method === "POST" && url.pathname === "/api/admin/cvs-stores/rollback") return rollbackCvsStores(request, env);
  const showcaseResponse = await productShowcase.route(request, env, url, ctx);
  if (showcaseResponse) return showcaseResponse;
  if (url.pathname.startsWith("/api/")) return json({ error: "找不到 API" }, { status: 404 });
  if (isCvsStoresRequest(request, url)) return serveCvsStores(request, env, url);
  if (isShareMetaRequest(request, url)) return withSecurityHeaders(await withShareMeta(request, env, url, ctx));
  if (isOrdersPageRequest(request, url)) return withSecurityHeaders(await withOrdersBootData(request, env));
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      // 必須 await：否則 handleRequest 內 rejected 的 promise 會在離開 try 之後才拋出，攔不到
      return await handleRequest(request, env, ctx, url);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`Unhandled error handling ${request.method} ${url.pathname}: ${detail}`);
      return json({ error: "服務暫時無法使用，請稍後再試" }, { status: 503 });
    }
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 每日備份（19:00 UTC＝台灣隔日 03:00）獨立一次執行，不和通知排程共用子請求額度
    if (_controller.cron === BACKUP_CRON) return ctx.waitUntil(runDailyBackup(env, new Date(_controller.scheduledTime)));
    // 每 5 分鐘：通知重試，剩下的子請求額度（Workers Free 每次 50）補發建單通知與取消通知
    const task = _controller.cron === "*/5 * * * *"
      ? runFiveMinuteNotifications(env, new Date(_controller.scheduledTime))
        .catch((error) => console.error("通知重試或補送失敗", error))
      // 每小時：通知排程，並補齊尚未記錄寬高的商品主圖（補完後只剩一次查詢）。
      // 通知重試只在 5 分鐘排程執行（整點也會另外觸發一次），不和這裡共用 Workers Free 每次 50 個子請求的額度
      : Promise.all([runScheduledNotifications(env, new Date(_controller.scheduledTime)), backfillProductImageDimensions(env).catch((error) => console.error("商品主圖寬高補齊失敗", error))]).then(() => undefined);
    ctx.waitUntil(task);
    // 每日一次唯讀保活（每小時排程在固定時刻觸發），與通知任務互不影響。
    if (_controller.cron !== "*/5 * * * *" && isKeepaliveHour(_controller.scheduledTime)) ctx.waitUntil(pingSupabase(env));
  }
} satisfies ExportedHandler<Env>;
