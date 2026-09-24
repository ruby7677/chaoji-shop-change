// 後台分區資料（section）、稽核紀錄與通知紀錄查詢／重排。
import { loadAdminOverview } from "./admin-overview";
import { requireAdmin } from "./auth";
import { databaseError } from "./database-errors";
import { type Env } from "./env";
import { json, serviceHeaders } from "./http";

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

export async function adminDashboard(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  // 後台一律分區載入；舊的全量路徑（一次讀取 11 張表、各數百筆）已移除。
  const sectionParam = new URL(request.url).searchParams.get("section");
  if (!sectionParam || !ADMIN_DASHBOARD_SECTIONS.includes(sectionParam as AdminDashboardSection)) return json({ error: "管理資料分區不正確" }, { status: 400 });
  return adminDashboardSection(request, env, sectionParam as AdminDashboardSection, admin.user.id);
}

export async function adminAuditLogs(request: Request, env: Env): Promise<Response> {
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

export async function adminNotificationDeliveries(request: Request, env: Env): Promise<Response> {
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

export async function requeueAdminNotificationDelivery(request: Request, env: Env, channel: string, notificationId: string): Promise<Response> {
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
