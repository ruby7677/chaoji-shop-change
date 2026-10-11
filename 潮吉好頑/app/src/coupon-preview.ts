// 結帳「套用」優惠碼：以會員 JWT 呼叫唯讀試算 RPC，回傳折抵金額；不核銷，建單時仍由 create_delivery_order 重新驗證。
import { requireUser } from "./auth";
import { databaseError, databaseErrors } from "./database-errors";
import { type Env } from "./env";
import { MAX_JSON_REQUEST_BYTES, enforceRateLimit, fetchWithTimeout, json } from "./http";

const MAX_PREVIEW_ITEMS = 50;
const MAX_PREVIEW_QUANTITY = 100;
const MAX_COUPON_CODE_LENGTH = 32;

type PreviewItem = { variant_id?: unknown; quantity?: unknown };

function validItems(items: unknown): items is Array<{ variant_id: string; quantity: number }> {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_PREVIEW_ITEMS) return false;
  return items.every((item: PreviewItem) => typeof item?.variant_id === "string"
    && /^[0-9a-f-]{36}$/i.test(item.variant_id)
    && Number.isInteger(item.quantity) && Number(item.quantity) >= 1 && Number(item.quantity) <= MAX_PREVIEW_QUANTITY);
}

export async function previewCheckoutCoupon(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const { authorization, user } = authResult;
  // 與建單共用限流，避免用試算大量猜測優惠碼
  const rateLimitResponse = await enforceRateLimit(env.API_ORDER_RATE_LIMITER, `order:${user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "資料庫尚未設定" }, { status: 503 });
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_REQUEST_BYTES) return json({ error: databaseErrors.REQUEST_BODY_TOO_LARGE }, { status: 413 });
  let body: { items?: unknown; coupon_code?: unknown };
  try { body = await request.json(); } catch { return json({ error: "請求格式錯誤" }, { status: 400 }); }
  const code = typeof body.coupon_code === "string" ? body.coupon_code.trim() : "";
  if (!code || code.length > MAX_COUPON_CODE_LENGTH) return json({ error: "請輸入優惠碼" }, { status: 400 });
  if (!validItems(body.items)) return json({ error: "商品數量錯誤" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/preview_checkout_coupon`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_items: body.items.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity })),
      p_coupon_code: code
    })
  });
  if (!response.ok) return databaseError(response);
  return json({ coupon: await response.json() });
}
