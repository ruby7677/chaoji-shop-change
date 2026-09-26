// HTTP 回應共用工具：安全 header、JSON 回應、速率限制與 Supabase service-role header。
import { type Env } from "./env";

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' https://static.line-scdn.net; style-src 'self' 'sha256-L0NsGOdCgMq8WQ+53SoJ4y/OJrxNakwWYcLt+wUiWoE='; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.supabase.co https://api.line.me https://access.line.me https://liff.line.me https://liffsdk.line-scdn.net; form-action 'self'; upgrade-insecure-requests",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000"
};

export function withSecurityHeaders(response: Response) {
  const headers = new Headers(response.headers);
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Cache-Control", "no-store");
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return Response.json(data, { ...init, headers });
}

export const MAX_JSON_REQUEST_BYTES = 128 * 1024;

// 對外連線逾時：Supabase、LINE、Telegram 預設 10 秒；上傳或下載圖片檔案 30 秒
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPLOAD_TIMEOUT_MS = 30_000;

// 呼叫當下才取用全域 fetch（測試會替換 globalThis.fetch）；呼叫端自帶的 signal 與逾時任一觸發都會中止
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

export async function enforceRateLimit(limiter: RateLimit | undefined, key: string): Promise<Response | null> {
  if (!limiter) return null;
  try {
    const outcome = await limiter.limit({ key });
    return outcome.success ? null : json({ error: "請求過於頻繁，請稍後再試" }, { status: 429, headers: { "Retry-After": "60" } });
  } catch {
    return json({ error: "安全限制服務暫時無法使用，請稍後再試" }, { status: 503 });
  }
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("Authorization");
  return authorization?.startsWith("Bearer ") ? authorization : null;
}

/** Supabase service role 標頭；只需要 service role key，通知模組的精簡 env 型別也能直接使用。 */
export function serviceHeaders(env: Pick<Env, "SUPABASE_SERVICE_ROLE_KEY">, prefer?: string) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}
