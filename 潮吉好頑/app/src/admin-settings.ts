// 後台設定：點數規則、會員點數調整、優惠券、生日券與收款帳戶。
import { requireAdmin } from "./auth";
import { databaseError } from "./database-errors";
import { type Env } from "./env";
import { fetchWithTimeout, json, serviceHeaders } from "./http";
import { notifyBirthdayCoupons } from "./notifications";

export async function updatePointSettings(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { earn_amount_per_point?: number; point_value?: number; min_redeem_points?: number; max_redeem_mode?: string; max_redeem_value?: number };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const numbers = [body.earn_amount_per_point, body.point_value, body.min_redeem_points, body.max_redeem_value];
  if (!numbers.every(Number.isInteger) || (body.earn_amount_per_point as number) <= 0 || (body.point_value as number) <= 0 || (body.min_redeem_points as number) <= 0 || (body.max_redeem_value as number) < 0) return json({ error: "請填寫正確的點數規則" }, { status: 400 });
  if (!["percent", "fixed"].includes(body.max_redeem_mode || "") || (body.max_redeem_mode === "percent" && (body.max_redeem_value as number) > 100)) return json({ error: "折抵上限設定不正確" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_point_settings`, {
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

export async function adjustMemberPoints(request: Request, env: Env, memberId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { points?: number; reason?: string };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.points) || body.points === 0 || !body.reason?.trim()) return json({ error: "請填寫非 0 點數與異動原因" }, { status: 400 });
  if (body.reason.length > 200) return json({ error: "異動原因不可超過 200 字" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_adjust_member_points`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_member_id: memberId, p_points: body.points, p_reason: body.reason.trim() })
  });
  if (!response.ok) return databaseError(response);
  return json({ balance: await response.json() });
}

export async function saveCoupon(request: Request, env: Env, couponId: string | null): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { code?: string; name?: string; discount_amount?: number; combinable_with_points?: boolean; valid_from?: string; valid_until?: string; total_usage_limit?: number | null; per_member_limit?: number; is_active?: boolean; product_ids?: string[]; member_ids?: string[] };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!body.code?.trim() || !body.name?.trim() || !Number.isInteger(body.discount_amount) || (body.discount_amount as number) <= 0 || !body.valid_from || !body.valid_until || !Number.isInteger(body.per_member_limit) || (body.per_member_limit as number) <= 0) return json({ error: "請填寫完整優惠券資料" }, { status: 400 });
  if (body.total_usage_limit != null && (!Number.isInteger(body.total_usage_limit) || body.total_usage_limit <= 0)) return json({ error: "總使用次數必須為正整數" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_save_coupon`, {
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

export async function updateBirthdaySettings(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: { enabled?: boolean; discount_amount?: number; issue_days_before?: number; valid_days?: number; combinable_with_points?: boolean };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  if (!Number.isInteger(body.discount_amount) || (body.discount_amount as number) <= 0 || !Number.isInteger(body.issue_days_before) || !Number.isInteger(body.valid_days)) return json({ error: "生日券設定不正確" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_birthday_coupon_settings`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({ p_actor_id: admin.user.id, p_enabled: body.enabled === true, p_discount_amount: body.discount_amount, p_issue_days_before: body.issue_days_before, p_valid_days: body.valid_days, p_combinable: body.combinable_with_points === true })
  });
  if (!response.ok) return databaseError(response);
  return json({ settings: await response.json() });
}

export async function issueBirthdayCoupons(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/issue_birthday_coupons`, {
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

export async function createBankAccount(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: BankAccountInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateBankAccount(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_create_bank_account`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_label: validated.value.label, p_bank_name: validated.value.bank_name,
      p_account_name: validated.value.account_name, p_account_number: validated.value.account_number,
      p_is_active: validated.value.is_active, p_display_order: validated.value.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ account: await response.json() }, { status: 201 });
}

export async function updateBankAccount(request: Request, env: Env, accountId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  let body: BankAccountInput;
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const validated = validateBankAccount(body);
  if ("error" in validated) return json({ error: validated.error }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_update_bank_account`, {
    method: "POST", headers: serviceHeaders(env), body: JSON.stringify({
      p_actor_id: admin.user.id, p_account_id: accountId, p_label: validated.value.label, p_bank_name: validated.value.bank_name,
      p_account_name: validated.value.account_name, p_account_number: validated.value.account_number,
      p_is_active: validated.value.is_active, p_display_order: validated.value.display_order
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ account: await response.json() });
}
