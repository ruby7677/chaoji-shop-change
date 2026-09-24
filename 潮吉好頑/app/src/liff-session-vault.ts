// Server-side LIFF session storage keyed by a verified LINE `sub`.
// LINE WebViews may drop the HttpOnly session cookie between launches; the
// vault lets the Worker restore the member session from a fresh LIFF ID token
// without sending the user through another Supabase OAuth redirect chain.
// Callers must verify the LIFF ID token before using any of these helpers.

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

function vaultHeaders(env: LiffSessionVaultEnv, prefer?: string) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
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
    const response = await fetch(url, { headers: vaultHeaders(env) });
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
    const response = await fetch(url, {
      method: "POST",
      headers: vaultHeaders(env, "resolution=merge-duplicates,return=minimal"),
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

export async function deleteVaultedSession(env: LiffSessionVaultEnv, lineUserId: string): Promise<void> {
  if (!vaultReady(env)) return;
  try {
    await fetch(vaultUrl(env, lineUserId), { method: "DELETE", headers: vaultHeaders(env, "return=minimal") });
  } catch {
    // Best-effort cleanup: a stale row only fails its next refresh and is removed then.
  }
}
