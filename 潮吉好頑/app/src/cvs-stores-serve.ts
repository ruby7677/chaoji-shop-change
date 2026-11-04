// 公開讀取 /cvs-stores/index.json 與 /cvs-stores/<slug>.json：有後台發佈的 R2 版本就讀它，否則回到 repo 內建的靜態檔。
// 只有 wrangler.jsonc 的 run_worker_first 列出 /cvs-stores/* 才會進到這裡。
import { CVS_POINTER_KEY, CVS_SLUGS, cvsVersionKey, type CvsPointer } from "./cvs-stores";
import { type Env } from "./env";
import { SECURITY_HEADERS, json } from "./http";

const PATH = /^\/cvs-stores\/([a-z-]+)\.json$/;
// 瀏覽器與 Cloudflare 邊緣各快取 5 分鐘、結帳頁內再快取 5 分鐘，後台發佈後客人約 10 分鐘內換到新版
const CACHE_CONTROL = "public, max-age=300";

function jsonResponse(body: BodyInit | null) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", CACHE_CONTROL);
  return new Response(body, { status: 200, headers });
}

export function isCvsStoresRequest(request: Request, url: URL) {
  return ["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/cvs-stores/");
}

export async function serveCvsStores(request: Request, env: Env, url: URL): Promise<Response> {
  const name = url.pathname.match(PATH)?.[1];
  if (!name || (name !== "index" && !CVS_SLUGS.has(name))) return json({ error: "找不到門市資料" }, { status: 404 });
  const bucket = env.PRODUCT_IMAGES;
  if (bucket) {
    try {
      const pointerObject = await bucket.get(CVS_POINTER_KEY);
      const pointer = pointerObject ? await pointerObject.json<CvsPointer>() : null;
      if (pointer?.version) {
        const object = await bucket.get(cvsVersionKey(pointer.version, name));
        if (object) return jsonResponse(request.method === "HEAD" ? null : object.body);
      }
    } catch (error) {
      // R2 暫時讀不到時退回內建靜態檔，結帳不中斷
      console.error("讀取 R2 門市資料失敗，改用內建檔", error);
    }
  }
  const asset = await env.ASSETS.fetch(request);
  // 沒有這個靜態檔時資產層會回 SPA 的 index.html（200），不能當門市資料
  if (!asset.ok || !(asset.headers.get("Content-Type") || "").includes("json")) return json({ error: "找不到門市資料" }, { status: 404 });
  const headers = new Headers(asset.headers);
  Object.entries(SECURITY_HEADERS).forEach(([key, value]) => headers.set(key, value));
  headers.set("Cache-Control", CACHE_CONTROL);
  return new Response(asset.body, { status: 200, headers });
}
