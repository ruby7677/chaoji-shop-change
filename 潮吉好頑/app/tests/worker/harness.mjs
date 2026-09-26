// Worker 測試共用工具：用 esbuild 把 src/index.ts 打包成 ESM 後直接呼叫 fetch／scheduled，
// 外部服務（Supabase、LINE、Telegram）全部以假的 globalThis.fetch 取代，不連任何真實服務。
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundles = new Map();

/** 以 esbuild 打包 src/ 下的模組（預設為 Worker 入口 index.ts）後動態載入；同一模組只打包一次。 */
export function loadSourceModule(relativePath = "index.ts") {
  if (!bundles.has(relativePath)) bundles.set(relativePath, (async () => {
    const dir = await mkdtemp(join(tmpdir(), "cj-worker-test-"));
    const outfile = join(dir, "module.mjs");
    await build({
      entryPoints: [join(appRoot, "src", relativePath)],
      bundle: true,
      format: "esm",
      platform: "neutral",
      outfile,
      logLevel: "warning"
    });
    const module = await import(pathToFileURL(outfile).href);
    await rm(dir, { recursive: true, force: true });
    return module;
  })());
  return bundles.get(relativePath);
}

export async function loadWorker() {
  return (await loadSourceModule()).default;
}

export const baseEnv = Object.freeze({
  STORE_NAME: "潮吉好頑",
  SUPABASE_URL: "https://db.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  AUTH_SESSION_SECRET: "x".repeat(40),
  LINE_AUTH_ENABLED: "true",
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: "line-token",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  TELEGRAM_ADMIN_CHAT_IDS: "111,222",
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }) }
});

export const ctx = () => {
  const pending = [];
  return { waitUntil: (promise) => pending.push(promise), settle: () => Promise.all(pending) };
};

export const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Replaces globalThis.fetch for one test; the handler receives (URL, init, bodyJson). Returns the restore function. */
export function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let body = null;
    if (typeof init.body === "string" && init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return handler(url, init, body);
  };
  return () => { globalThis.fetch = original; };
}

export const LINE_USER_ID = "U" + "a".repeat(32);
export const lineUser = (id) => ({ id, identities: [{ provider: "custom:line-web", identity_data: { sub: LINE_USER_ID } }] });

/** A RateLimit binding fake that always reports the limit as exceeded. */
export const deniedRateLimit = { limit: async () => ({ success: false }) };

/**
 * A RateLimit binding fake keyed per call: `shouldDeny` is either an array of
 * exact key strings to deny, or a predicate `(key) => boolean`. Every key seen
 * is recorded on `.calls` so a test can assert which key a route used.
 */
export function keyedRateLimit(shouldDeny = []) {
  const denyFn = typeof shouldDeny === "function" ? shouldDeny : (key) => shouldDeny.includes(key);
  const calls = [];
  return {
    calls,
    limit: async ({ key }) => {
      calls.push(key);
      return { success: !denyFn(key) };
    }
  };
}

/**
 * Serializes a FormData body the same way a real client upload would, so the
 * resulting Content-Length header reflects real bytes instead of being
 * absent (a Request built directly from a FormData body in Node never gets a
 * Content-Length header, unlike an actual incoming HTTP request).
 */
export async function formDataRequestInit(formData) {
  const body = await new Response(formData).blob();
  return { body, headers: { "Content-Type": body.type, "Content-Length": String(body.size) } };
}
