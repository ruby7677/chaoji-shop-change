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
    return refreshToken.length >= 16 ? refreshToken : null;
  } catch {
    return null;
  }
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

export async function refreshSupabaseSession(
  supabaseUrl: string,
  anonKey: string,
  refreshToken: string
): Promise<SupabaseRefreshSession | null> {
  const response = await fetch(supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
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
