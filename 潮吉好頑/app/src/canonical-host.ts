// 舊網址 workers.dev 的網頁一律 301 轉到正式網域（CANONICAL_HOST）。
// 只轉 GET／HEAD 的頁面請求；/api/* 不轉，已開啟的舊頁面與尚未更新的客戶端仍可呼叫。
// 只有 run_worker_first 列出的路徑會進到 Worker，新增入口頁時要一併加進去才會被轉址。
import { type Env } from "./env";
import { SECURITY_HEADERS } from "./http";

// 瀏覽器會長期快取 301；設有限時間，之後要調整或撤回時舊瀏覽器一天內就會重新詢問
const REDIRECT_CACHE = "public, max-age=86400";

export function canonicalRedirect(request: Request, env: Env, url: URL): Response | null {
  const canonical = env.CANONICAL_HOST?.trim().toLowerCase();
  const legacy = env.LEGACY_HOST?.trim().toLowerCase();
  if (!canonical || !legacy || url.hostname.toLowerCase() !== legacy) return null;
  if (!["GET", "HEAD"].includes(request.method) || url.pathname.startsWith("/api/")) return null;
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Location", `https://${canonical}${url.pathname}${url.search}`);
  headers.set("Cache-Control", REDIRECT_CACHE);
  return new Response(null, { status: 301, headers });
}
