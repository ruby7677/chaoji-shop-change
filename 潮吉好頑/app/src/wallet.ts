// 會員儲值金：會員讀取餘額與紀錄、管理員加值／退款／調整與沖正（線上一番賞 Stage 2）。
// 寫入一律經由 security definer RPC，帳戶餘額與帳本在同一交易內更新；這裡只做格式檢查與身分驗證。
import { requireAdmin, requireUser } from "./auth";
import { databaseError } from "./database-errors";
import { type Env } from "./env";
import { enforceRateLimit, fetchWithTimeout, json, serviceHeaders } from "./http";

const WALLET_KINDS = new Set(["topup", "adjust", "refund"]);
const MAX_WALLET_AMOUNT = 1_000_000;
const MEMBER_LEDGER_LIMIT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WalletResult = { entry_id?: string; balance?: number; replayed?: boolean };

async function readJson<T>(request: Request): Promise<T | null> {
  try { return await request.json() as T; } catch { return null; }
}

function trimmed(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function walletResponse(result: WalletResult) {
  return json({ entryId: result.entry_id, balance: result.balance, replayed: result.replayed === true });
}

export async function memberWallet(request: Request, env: Env): Promise<Response> {
  const authResult = await requireUser(request, env);
  if (authResult instanceof Response) return authResult;
  const rateLimitResponse = await enforceRateLimit(env.API_MEMBER_RATE_LIMITER, `wallet:${authResult.user.id}`);
  if (rateLimitResponse) return rateLimitResponse;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return json({ error: "儲值金服務尚未設定" }, { status: 503 });
  // 以會員 JWT 讀取：餘額函式只看 auth.uid()，紀錄受 RLS 與欄位權限限制（看不到操作者與匯款參照）。
  const member = { apikey: env.SUPABASE_ANON_KEY, Authorization: authResult.authorization };
  const ledgerUrl = new URL(`${env.SUPABASE_URL}/rest/v1/wallet_ledger`);
  ledgerUrl.searchParams.set("select", "id,kind,amount,balance_after,reason,created_at");
  ledgerUrl.searchParams.set("member_id", `eq.${authResult.user.id}`);
  ledgerUrl.searchParams.set("order", "created_at.desc");
  ledgerUrl.searchParams.set("limit", String(MEMBER_LEDGER_LIMIT));
  const [balanceResponse, ledgerResponse] = await Promise.all([
    fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/member_wallet_balance`, { method: "POST", headers: { ...member, "Content-Type": "application/json" }, body: "{}" }),
    fetchWithTimeout(ledgerUrl, { headers: member })
  ]);
  if (!balanceResponse.ok || !ledgerResponse.ok) return json({ error: "儲值金資料暫時無法載入" }, { status: 503 });
  return json({ balance: Number(await balanceResponse.json()), ledger: await ledgerResponse.json() });
}

export async function adjustMemberWallet(request: Request, env: Env, memberId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const body = await readJson<{ kind?: unknown; amount?: unknown; reason?: unknown; requestId?: unknown; transferRef?: unknown }>(request);
  if (!body) return json({ error: "請求格式錯誤" }, { status: 400 });
  const kind = trimmed(body.kind);
  const amount = body.amount;
  const reason = trimmed(body.reason);
  const requestId = trimmed(body.requestId);
  const transferRef = trimmed(body.transferRef);
  if (!WALLET_KINDS.has(kind)) return json({ error: "請選擇加值、調整或退款" }, { status: 400 });
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount as number) > MAX_WALLET_AMOUNT) return json({ error: `金額必須是非 0 的整數，且不超過 ${MAX_WALLET_AMOUNT.toLocaleString("en-US")} 元` }, { status: 400 });
  if ((kind === "topup" && (amount as number) < 0) || (kind === "refund" && (amount as number) > 0)) return json({ error: "加值金額必須為正數，退款金額必須為負數" }, { status: 400 });
  if (!reason || reason.length > 200) return json({ error: "請填寫 200 字以內的原因" }, { status: 400 });
  if (transferRef.length > 60) return json({ error: "匯款參照不可超過 60 字" }, { status: 400 });
  if (!UUID_PATTERN.test(requestId)) return json({ error: "請求識別碼不正確，請重新整理後再試" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_adjust_wallet`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({
      p_actor_id: admin.user.id, p_member_id: memberId, p_kind: kind, p_amount: amount,
      p_reason: reason, p_request_id: requestId, p_transfer_ref: transferRef || null
    })
  });
  if (!response.ok) return databaseError(response);
  return walletResponse(await response.json() as WalletResult);
}

export async function reverseWalletEntry(request: Request, env: Env, entryId: string): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const body = await readJson<{ reason?: unknown; requestId?: unknown }>(request);
  if (!body) return json({ error: "請求格式錯誤" }, { status: 400 });
  const reason = trimmed(body.reason);
  const requestId = trimmed(body.requestId);
  if (!reason || reason.length > 200) return json({ error: "請填寫 200 字以內的沖正原因" }, { status: 400 });
  if (!UUID_PATTERN.test(requestId)) return json({ error: "請求識別碼不正確，請重新整理後再試" }, { status: 400 });
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/admin_reverse_wallet_entry`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: JSON.stringify({ p_actor_id: admin.user.id, p_entry_id: entryId, p_reason: reason, p_request_id: requestId })
  });
  if (!response.ok) return databaseError(response);
  return walletResponse(await response.json() as WalletResult);
}
