// Server-side LIFF session storage keyed by a verified LINE `sub`.
// LINE WebViews may drop the HttpOnly session cookie between launches; the
// vault lets the Worker restore the member session from a fresh LIFF ID token
// without sending the user through another Supabase OAuth redirect chain.
// Callers must verify the LIFF ID token before using any of these helpers.
import { fetchWithTimeout, serviceHeaders } from "./http";

export interface LiffSessionVaultEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export type VaultReadResult =
  | { status: "found"; sealed: string }
  | { status: "missing" }
  | { status: "unavailable" };

const VAULT_TABLE = "liff_session_vault";

function vaultReady(env: LiffSessionVaultEnv) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

function vaultUrl(env: LiffSessionVaultEnv, lineUserId?: string) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${VAULT_TABLE}`);
  if (lineUserId) url.searchParams.set("line_user_id", `eq.${lineUserId}`);
  return url;
}

export async function readVaultedSession(env: LiffSessionVaultEnv, lineUserId: string): Promise<VaultReadResult> {
  if (!vaultReady(env)) return { status: "unavailable" };
  try {
    const url = vaultUrl(env, lineUserId);
    url.searchParams.set("select", "sealed_refresh_token");
    const response = await fetchWithTimeout(url, { headers: serviceHeaders(env) });
    // A missing table (migration not applied yet) must fall back to the
    // cookie-only behaviour instead of failing the whole restore.
    if (!response.ok) return { status: "unavailable" };
    const rows = await response.json() as Array<{ sealed_refresh_token?: unknown }>;
    const sealed = rows[0]?.sealed_refresh_token;
    return typeof sealed === "string" && sealed ? { status: "found", sealed } : { status: "missing" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function storeVaultedSession(
  env: LiffSessionVaultEnv,
  lineUserId: string,
  userId: string,
  sealed: string
): Promise<boolean> {
  if (!vaultReady(env)) return false;
  try {
    const url = vaultUrl(env);
    url.searchParams.set("on_conflict", "line_user_id");
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: serviceHeaders(env, "resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify({
        line_user_id: lineUserId,
        user_id: userId,
        sealed_refresh_token: sealed,
        updated_at: new Date().toISOString()
      })
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 只更新既有列的 token（輪替後查不到使用者時存回新 token）；不新增列，user_id 維持原本已驗證的值。
 * 只在該列仍是 `expectedSealed`（本次讀到的那筆）時才更新：期間另一次 LINE Login 寫入的新 token 不會被蓋掉。
 * 回傳是否真的更新到一列。
 */
export async function replaceVaultedToken(env: LiffSessionVaultEnv, lineUserId: string, sealed: string, expectedSealed: string): Promise<boolean> {
  if (!vaultReady(env)) return false;
  try {
    const url = vaultUrl(env, lineUserId);
    url.searchParams.set("sealed_refresh_token", `eq.${expectedSealed}`);
    url.searchParams.set("select", "line_user_id");
    const response = await fetchWithTimeout(url, {
      method: "PATCH",
      headers: serviceHeaders(env, "return=representation"),
      body: JSON.stringify({ sealed_refresh_token: sealed, updated_at: new Date().toISOString() })
    });
    if (!response.ok) return false;
    const rows = await response.json() as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/** 只刪除仍是 `expectedSealed` 的列；期間已被新的 LINE Login 覆寫時保留新 token。 */
export async function deleteVaultedSession(env: LiffSessionVaultEnv, lineUserId: string, expectedSealed: string): Promise<void> {
  if (!vaultReady(env)) return;
  try {
    const url = vaultUrl(env, lineUserId);
    url.searchParams.set("sealed_refresh_token", `eq.${expectedSealed}`);
    await fetchWithTimeout(url, { method: "DELETE", headers: serviceHeaders(env, "return=minimal") });
  } catch {
    // Best-effort cleanup: a stale row only fails its next refresh and is removed then.
  }
}
