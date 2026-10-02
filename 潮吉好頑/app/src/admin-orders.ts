// 後台訂單操作：狀態轉換、宅配尾款／運費、退貨驗收。
import { invalidateCatalogCache } from "./catalog";
import { requireAdmin } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env } from "./env";
import { fetchWithTimeout, json, serviceHeaders } from "./http";

const adminOrderStatuses = ["pending_payment", "pending_review", "confirmed", "partially_ready", "ready_for_pickup", "completed", "cancelled", "refund_pending", "refunded"] as const;

export async function transitionAdminOrder(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { target_status?: string; note?: string; refund_amount?: number | null };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const targetStatus = body.target_status;
  // 退款金額只在取消／確認已退款時送出；最終上限與「未付款必為 0」由 admin_transition_order 檢查
  const refundAmount = body.refund_amount ?? null;
  if (refundAmount !== null && (!Number.isInteger(refundAmount) || refundAmount < 0)) return json({ error: "退款金額必須是 0 或正整數" }, { status: 400 });
  if (!targetStatus || !adminOrderStatuses.includes(targetStatus as typeof adminOrderStatuses[number])) return json({ error: "訂單狀態不正確" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  if (["partially_ready", "ready_for_pickup"].includes(targetStatus)) {
    const orderUrl = new URL(`${env.SUPABASE_URL}/rest/v1/orders`);
    orderUrl.searchParams.set("select", "delivery_method,pickup_plan,order_items(kind)");
    orderUrl.searchParams.set("id", `eq.${orderId}`);
    orderUrl.searchParams.set("limit", "1");
    const orderResponse = await fetchWithTimeout(orderUrl, { headers: serviceHeaders(env) });
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
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_transition_order`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_order_id: orderId, p_target_status: targetStatus, p_note: body.note?.trim() || null, p_refund_amount: refundAmount })
  });
  if (!response.ok) return databaseError(response);
  // 取消會釋放保留量，改變前台型錄的可售量
  invalidateCatalogCache();
  return json({ order: await response.json() });
}

export async function updateAdminOrderFulfillment(request: Request, env: Env, orderId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { shipping_fee?: number; final_payment_confirmed?: boolean; final_payment_last_five?: string; note?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.shipping_fee) || (body.shipping_fee as number) < 0) return json({ error: "實際運費必須是 0 或正整數" }, { status: 400 });
  if (body.final_payment_last_five && !/^\d{5}$/.test(body.final_payment_last_five)) return json({ error: "尾款匯款末五碼須為 5 位數字" }, { status: 400 });
  if ((body.note || "").length > 1000) return json({ error: "管理備註不可超過 1000 字" }, { status: 400 });
  const orderLookup = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/orders?select=status,delivery_method,order_items(kind)&id=eq.${orderId}&limit=1`, { headers: serviceHeaders(env) });
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
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_order_fulfillment`, {
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

export async function confirmAdminOrderReturn(request: Request, env: Env, orderItemId: string): Promise<Response> {
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
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_confirm_order_return`, {
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
  // 退貨驗收會把可再售數量回補庫存，影響前台型錄的可售量。
  invalidateCatalogCache();
  return json({ return_confirmation: await response.json() });
}
