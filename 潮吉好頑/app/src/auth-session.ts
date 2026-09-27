import { fetchWithTimeout } from "./http";

const SESSION_COOKIE = "__Host-cj-session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type SupabaseRefreshSession = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  token_type?: string;
  user?: unknown;
};

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealRefreshToken(secret: string, refreshToken: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(refreshToken)
  );
  return "v1." + toBase64Url(iv) + "." + toBase64Url(new Uint8Array(encrypted));
}

export async function openRefreshToken(secret: string, sealed: string) {
  try {
    const [version, encodedIv, encodedCiphertext] = sealed.split(".");
    if (version !== "v1" || !encodedIv || !encodedCiphertext) return null;
    const key = await sessionKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(encodedIv) },
      key,
      fromBase64Url(encodedCiphertext)
    );
    const refreshToken = new TextDecoder().decode(decrypted);
    // AES-GCM 已保證內容完整；Supabase 的 refresh token 可能只有 12 字元，不另設最低長度
    // （曾因 >= 16 的限制把有效 token 判為無效，LINE 內每次開啟都被迫重新 OAuth）
    return refreshToken ? refreshToken : null;
  } catch {
    return null;
  }
}

// 一般瀏覽器（非 LINE App）的登入續期 cookie。與 LIFF 的 v1 格式分開：前綴不同且以
// AES-GCM additional data 綁定用途，兩種 cookie 不能互換使用。payload 帶首次登入時間，
// 讓 Worker 強制最長登入時間；cookie 不設 Max-Age，關閉瀏覽器即失效。
const WEB_SESSION_COOKIE = "__Host-cj-web-session";
// 前端可讀的存在提示（不含任何憑證），避免每位訪客載入頁面都呼叫一次續期 API。
const WEB_SESSION_HINT_COOKIE = "__Host-cj-web-hint";
const WEB_SESSION_AAD = new TextEncoder().encode("cj-web-session:w1");

export type WebSessionPayload = { rt: string; iat: number; uid: string };

export async function sealWebSession(secret: string, payload: WebSessionPayload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: WEB_SESSION_AAD },
    key,
    new TextEncoder().encode(JSON.stringify(payload))
  );
  return "w1." + toBase64Url(iv) + "." + toBase64Url(new Uint8Array(encrypted));
}

export async function openWebSession(secret: string, sealed: string): Promise<WebSessionPayload | null> {
  try {
    const [version, encodedIv, encodedCiphertext] = sealed.split(".");
    if (version !== "w1" || !encodedIv || !encodedCiphertext) return null;
    const key = await sessionKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(encodedIv), additionalData: WEB_SESSION_AAD },
      key,
      fromBase64Url(encodedCiphertext)
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as Partial<WebSessionPayload>;
    if (typeof payload.rt !== "string" || !payload.rt || typeof payload.uid !== "string" || !Number.isFinite(payload.iat)) return null;
    return { rt: payload.rt, iat: Number(payload.iat), uid: payload.uid };
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + "=")) return trimmed.slice(name.length + 1);
  }
  return null;
}

export function readWebSessionCookie(request: Request) {
  return readCookie(request, WEB_SESSION_COOKIE);
}

/** Browser-session cookies (no Max-Age): closing the browser ends the web login. */
export function webSessionCookies(sealed: string) {
  return [
    WEB_SESSION_COOKIE + "=" + sealed + "; Path=/; HttpOnly; Secure; SameSite=Strict",
    WEB_SESSION_HINT_COOKIE + "=1; Path=/; Secure; SameSite=Strict"
  ];
}

export function clearWebSessionCookies() {
  return [
    WEB_SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
    WEB_SESSION_HINT_COOKIE + "=; Path=/; Max-Age=0; Secure; SameSite=Strict"
  ];
}

export function readRefreshSessionCookie(request: Request) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(SESSION_COOKIE + "=")) return trimmed.slice(SESSION_COOKIE.length + 1);
  }
  return null;
}

export function refreshSessionCookie(sealed: string) {
  return SESSION_COOKIE + "=" + sealed + "; Path=/; Max-Age=" + SESSION_MAX_AGE_SECONDS + "; HttpOnly; Secure; SameSite=Lax";
}

export function clearRefreshSessionCookie() {
  return SESSION_COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

export type SupabaseRefreshResult =
  | { ok: true; session: SupabaseRefreshSession }
  | { ok: false; retryable: boolean };

/** Distinguishes a rejected refresh token (4xx) from a transient Supabase/network failure. */
export async function requestSupabaseRefresh(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string
): Promise<SupabaseRefreshResult> {
  let response: Response;
  try {
    response = await fetchWithTimeout(supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
  } catch {
    return { ok: false, retryable: true };
  }
  if (!response.ok) return { ok: false, retryable: response.status === 429 || response.status >= 500 };
  const payload = await response.json().catch(() => null) as Partial<SupabaseRefreshSession> | null;
  if (typeof payload?.access_token !== "string" || typeof payload.refresh_token !== "string") return { ok: false, retryable: true };
  return { ok: true, session: payload as SupabaseRefreshSession };
}

export async function refreshSupabaseSession(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string
): Promise<SupabaseRefreshSession | null> {
  const response = await fetchWithTimeout(supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: {
      apikey: anonKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!response.ok) return null;
  const payload = await response.json() as Partial<SupabaseRefreshSession>;
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") return null;
  return payload as SupabaseRefreshSession;
}
