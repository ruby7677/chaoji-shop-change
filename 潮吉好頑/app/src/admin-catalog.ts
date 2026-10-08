// 後台商品管理：分類、商品、規格與庫存調整。
import { invalidateCatalogCache } from "./catalog";
import { purgeProductImageCache } from "./product-image-storage";
import { requireAdmin } from "./auth";
import { databaseError } from "./database-errors";
import { type Env } from "./env";
import { fetchWithTimeout, json, serviceHeaders } from "./http";

type CategoryInput = { name?: string; display_order?: number; is_active?: boolean };

function validateCategory(body: CategoryInput) {
  const name = body.name?.trim();
  if (!name) return { error: "請填寫分類名稱" };
  if (name.length > 50) return { error: "分類名稱不可超過 50 個字" };
  if (body.display_order != null && (!Number.isInteger(body.display_order) || body.display_order < 0)) return { error: "分類排序須為 0 或正整數" };
  return { value: { name, display_order: Number.isInteger(body.display_order) ? body.display_order : 0, is_active: body.is_active !== false } };
}

export async function createAdminCategory(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: CategoryInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateCategory(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_category`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_name: validated.value.name, p_display_order: validated.value.display_order, p_is_active: validated.value.is_active
    })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  return json({ category: await response.json() }, { status: 201 });
}

export async function updateAdminCategory(request: Request, env: Env, categoryId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: CategoryInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateCategory(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_category`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_category_id: categoryId, p_name: validated.value.name,
      p_display_order: validated.value.display_order, p_is_active: validated.value.is_active
    })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  return json({ category: await response.json() });
}

type ProductInput = {
  category_id?: string; category_name?: string; product_name?: string; description?: string; variant_name?: string; sku?: string;
  kind?: "in_stock" | "preorder"; price?: number; stock?: number; preorder_arrival?: string;
  deposit_rate?: number; seller_link?: string; purchase_limit?: number | null; points_eligible?: boolean; compare_at_price?: number | null; is_published?: boolean;
};

export async function createAdminProduct(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: ProductInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  let categoryName = body.category_name?.trim() || "";
  const categoryId = body.category_id?.trim() || "";
  if (categoryId) {
    if (!/^[0-9a-f-]{36}$/i.test(categoryId)) return json({ error: "商品分類資料不正確" }, { status: 400 });
    const categoryResponse = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/categories?select=id,name,is_active&id=eq.${categoryId}&limit=1`, { headers: serviceHeaders(env) });
    if (!categoryResponse.ok) return json({ error: "無法確認商品分類" }, { status: 503 });
    const categories = await categoryResponse.json() as Array<{ id: string; name: string; is_active?: boolean }>;
    if (!categories[0]) return json({ error: "找不到商品分類" }, { status: 400 });
    if (categories[0].is_active === false) return json({ error: "請選擇啟用中的商品分類" }, { status: 400 });
    categoryName = categories[0].name;
  }
  if (!categoryName || !body.product_name?.trim()) return json({ error: "請填寫分類與商品名稱" }, { status: 400 });
  if (!Number.isInteger(body.price) || (body.price as number) < 0 || !Number.isInteger(body.stock) || (body.stock as number) < 0) return json({ error: "價格與庫存須為非負整數" }, { status: 400 });
  const price = body.price as number;
  const compareAtPrice = body.compare_at_price == null ? null : Number(body.compare_at_price);
  if (compareAtPrice != null && (!Number.isInteger(compareAtPrice) || compareAtPrice < 0 || compareAtPrice < price)) return json({ error: "原價須為 0 或正整數，且不可低於售價" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return json({ error: "商品類型不正確" }, { status: 400 });
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_product`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id,
      p_category_name: categoryName,
      p_product_name: body.product_name,
      p_description: body.description || "",
      p_variant_name: body.variant_name || "單一規格",
      p_sku: body.sku?.trim() || null, // 沒填由資料庫自動產生內部編號
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
  await invalidateCatalogCache(request);
  const ids = await response.json() as { product_id?: string; variant_id?: string };
  return json({ ids }, { status: 201 });
}

type VariantInput = {
  product_id?: string; name?: string; sku?: string; kind?: "in_stock" | "preorder"; price?: number;
  safety_stock?: number; preorder_arrival?: string; deposit_rate?: number; seller_link?: string; compare_at_price?: number | null;
  is_published?: boolean; display_order?: number; move_to_top?: boolean;
};

function normalizedVariant(body: VariantInput, includeProduct = false) {
  if (!body.name?.trim() || !Number.isInteger(body.price) || (body.price as number) < 0) return { error: "請填寫規格名稱與正確價格" };
  if (!['in_stock', 'preorder'].includes(body.kind || '')) return { error: "商品類型不正確" };
  if (includeProduct && !body.product_id) return { error: "請選擇商品" };
  const depositRate = body.kind === "preorder" ? 0.5 : Number(body.deposit_rate ?? 0);
  if (!Number.isFinite(depositRate) || depositRate < 0 || depositRate > 1) return { error: "訂金比例須介於 0% 至 100%" };
  const price = body.price as number;
  const compareAtPrice = body.compare_at_price == null ? null : Number(body.compare_at_price);
  if (compareAtPrice != null && (!Number.isInteger(compareAtPrice) || compareAtPrice < 0 || compareAtPrice < price)) return { error: "原價須為 0 或正整數，且不可低於售價" };
  return { value: {
    ...(includeProduct ? { product_id: body.product_id } : {}), name: body.name.trim(), sku: body.sku?.trim().toUpperCase() || null, kind: body.kind,
    price: body.price, compare_at_price: compareAtPrice, safety_stock: Number.isInteger(body.safety_stock) ? body.safety_stock : 0,
    preorder_arrival: body.preorder_arrival?.trim() || null, deposit_rate: depositRate,
    seller_link: body.seller_link?.trim() || null, is_published: body.is_published === true,
    display_order: Number.isInteger(body.display_order) ? body.display_order : 0, updated_at: new Date().toISOString()
  } };
}

export async function createVariant(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: VariantInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = normalizedVariant(body, true);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const payload = validated.value;
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_variant`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_product_id: payload.product_id, p_name: payload.name, p_sku: payload.sku,
      p_kind: payload.kind, p_price: payload.price, p_compare_at_price: payload.compare_at_price,
      p_safety_stock: payload.safety_stock, p_preorder_arrival: payload.preorder_arrival,
      p_deposit_rate: payload.deposit_rate, p_seller_link: payload.seller_link,
      // 未指定排序時交給資料庫自動接在同商品最後一個規格之後
      p_is_published: payload.is_published, p_display_order: Number.isInteger(body.display_order) ? payload.display_order : null
    })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  return json({ variant: await response.json() }, { status: 201 });
}

export async function updateVariant(request: Request, env: Env, variantId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: VariantInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = normalizedVariant(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const payload = { ...validated.value };
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_variant`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_variant_id: variantId, p_name: payload.name, p_sku: payload.sku,
      p_kind: payload.kind, p_price: payload.price, p_compare_at_price: payload.compare_at_price ?? null,
      p_update_compare_at_price: body.compare_at_price !== undefined, p_safety_stock: payload.safety_stock,
      p_preorder_arrival: payload.preorder_arrival, p_deposit_rate: payload.deposit_rate,
      p_seller_link: payload.seller_link, p_is_published: payload.is_published, p_display_order: payload.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  const variant = await response.json() as { is_published?: boolean };
  // 重新上架時選擇「排到最前面」：上架成功後才移動；移動失敗不影響已完成的上架，回傳提示讓後台顯示
  if (body.move_to_top !== true || variant?.is_published !== true) return json({ variant });
  const moved = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_move_variant_to_top`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_variant_id: variantId })
  });
  if (!moved.ok) return json({ variant, moveError: "已上架，但排到最前面失敗，請在編輯中手動調整前台排序" });
  return json({ variant: await moved.json() });
}

export async function updateProduct(request: Request, env: Env, productId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { name?: string; description?: string; category_id?: string; purchase_limit?: number | null; points_eligible?: boolean; is_published?: boolean; display_order?: number };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.name?.trim()) return json({ error: "請填寫商品名稱" }, { status: 400 });
  if (body.purchase_limit != null && (!Number.isInteger(body.purchase_limit) || body.purchase_limit < 1)) return json({ error: "限購數量必須為正整數或不限購" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_product`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_product_id: productId, p_name: body.name.trim(), p_description: body.description || "",
      p_category_id: body.category_id || null, p_purchase_limit: body.purchase_limit ?? null,
      p_points_eligible: typeof body.points_eligible === "boolean" ? body.points_eligible : null,
      p_is_published: body.is_published === true, p_display_order: Number.isInteger(body.display_order) ? body.display_order : 0
    })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  const product = await response.json() as { image_updated_at?: string | null };
  // This mutation includes is_published; purge the current primary image here.
  // Other data centers drop it within the edge TTL (s-maxage) after unpublishing.
  await purgeProductImageCache(request, productId, undefined, product.image_updated_at || "1");
  return json({ product });
}

export async function adjustInventory(request: Request, env: Env, variantId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { quantity_delta?: number; reason?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.quantity_delta) || body.quantity_delta === 0 || !body.reason?.trim()) return json({ error: "請填寫非 0 的異動數量與原因" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_adjust_inventory`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_variant_id: variantId, p_quantity_delta: body.quantity_delta, p_reason: body.reason.trim() })
  });
  if (!response.ok) return databaseError(response);
  await invalidateCatalogCache(request);
  return json({ stock_on_hand: await response.json() });
}
