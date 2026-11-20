// 每日資料備份：呼叫 backup_snapshot()（migration 202610100001，202610130002 補 Auth 身分與 schema 版本）在同一個資料庫快照內讀出所有營運資料表，
// 邊讀邊寫入私有 R2 bucket（BACKUPS，沒有公開網域）。分表分頁讀取會讀到不同時間點的資料，還原時可能違反外鍵。
// 由專用的每日 Cron Trigger 呼叫（見 wrangler.jsonc 與 index.ts）；回應本體不解析，CPU 與記憶體用量都很低。
// 舊備份由 bucket 的生命週期規則自動刪除（見 SECURITY_OPERATIONS_CHECKLIST.md）。
import type { Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { notifyBackupFailure, taipeiDate } from "./notifications";

/** 每天 19:00 UTC（台灣隔日 03:00，離峰）；必須與 wrangler.jsonc 的 crons 項目一致。 */
export const BACKUP_CRON = "0 19 * * *";

/**
 * 整次備份的時間上限：逾時訊號在取得回應後仍作用於本體讀取，而讀取期間會等待 R2 分段上傳，
 * 所以這是「下載＋上傳」的總預算，不是單純的請求逾時。Cron Trigger 每次最多執行 15 分鐘。
 */
export const BACKUP_TIMEOUT_MS = 10 * 60_000;

/** 執行一次備份；回傳寫入的 R2 key。缺設定時不做任何事；失敗時丟出錯誤，由呼叫端記錄。 */
export async function runDatabaseBackup(env: Env, now = new Date()): Promise<string | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.BACKUPS) {
    console.warn("database backup skipped: missing Supabase settings or BACKUPS binding");
    return null;
  }
  const response = await fetchWithTimeout(`${env.SUPABASE_URL}/rest/v1/rpc/backup_snapshot`, {
    method: "POST",
    headers: serviceHeaders(env),
    body: "{}"
  }, BACKUP_TIMEOUT_MS);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`backup_snapshot failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("backup_snapshot returned no body");
  const key = `daily/${taipeiDate(now)}/snapshot.json`;
  const stored = await storeStream(env.BACKUPS, key, response.body);
  // CPU 追查用（Workers Logs）：只記大小、區塊數與回應編碼，不記內容
  console.log(`backup stored: ${stored.bytes} bytes in ${stored.chunks} chunks, content-length ${response.headers.get("content-length") ?? "-"}, content-encoding ${response.headers.get("content-encoding") ?? "-"}`);
  return key;
}

/** R2 分段上傳每段大小（除最後一段外每段必須相同，且至少 5 MiB）。 */
export const BACKUP_PART_SIZE = 10 * 1024 * 1024;

/**
 * 每次從回應讀出的區塊大小。Supabase 回應的串流區塊只有約 2 KB（1.4 MB 快照約 780 塊），
 * 用 JS 逐塊 read() 時光是迴圈就用掉約 35ms CPU（Workers Free 上限 10ms）；改由執行環境一次讀滿一大塊。
 */
export const BACKUP_READ_BLOCK = 1024 * 1024;

/** Workers 的 BYOB reader 才有 readAtLeast（專案的 DOM 型別沒有） */
type BlockReader = ReadableStreamBYOBReader & { readAtLeast?: (minBytes: number, view: Uint8Array) => Promise<ReadableStreamReadResult<Uint8Array>> };

/** 依序產生回應本體的區塊：Workers 用 BYOB reader 的 readAtLeast 一次讀滿一塊（原生迴圈），其他環境退回一般 reader。 */
async function* readBlocks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  let byob: BlockReader | null = null;
  try {
    byob = body.getReader({ mode: "byob" }) as BlockReader;
  } catch { /* 不是位元組串流：用一般 reader */ }
  if (byob && typeof byob.readAtLeast === "function") {
    for (;;) {
      const { done, value } = await byob.readAtLeast(BACKUP_READ_BLOCK, new Uint8Array(BACKUP_READ_BLOCK));
      if (value?.byteLength) yield value;
      if (done) return;
    }
  }
  byob?.releaseLock();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

/**
 * 邊讀邊寫入 R2，記憶體只保留一段：小於一段時直接 put，否則改用分段上傳。
 * 快照會隨資料量成長，不能整份讀進 Worker 記憶體（上限 128 MB）。
 * 小於一段時只保留收到的區塊、以 Blob 一次寫入，不配置一段大小的緩衝區（2026-10 快照約 1.4 MB）。
 * 回傳寫入的位元組數與區塊數，供記錄追查 CPU 用量。
 */
export async function storeStream(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, partSize = BACKUP_PART_SIZE): Promise<{ bytes: number; chunks: number }> {
  const httpMetadata = { contentType: "application/json" };
  // 由 flushPart 在閉包內設定：用 as 初始化，避免 TypeScript 把它收窄成 null
  let upload = null as R2MultipartUpload | null;
  try {
    const head: Uint8Array[] = [];
    let part = null as Uint8Array | null;
    let filled = 0;
    let bytes = 0;
    let chunks = 0;
    const parts: R2UploadedPart[] = [];
    const flushPart = async (current: Uint8Array) => {
      upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
      parts.push(await upload.uploadPart(parts.length + 1, current.subarray(0, filled)));
      part = new Uint8Array(partSize);
      filled = 0;
    };
    const append = async (value: Uint8Array) => {
      for (let offset = 0; offset < value.length;) {
        const current = part ??= new Uint8Array(partSize);
        const count = Math.min(partSize - filled, value.length - offset);
        current.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === partSize) await flushPart(current);
      }
    };
    for await (const value of readBlocks(body)) {
      bytes += value.length;
      chunks += 1;
      if (part === null && bytes < partSize) {
        head.push(value);
        continue;
      }
      // 達到一段大小：改用分段上傳，先補上之前保留的區塊
      for (const earlier of head.splice(0)) await append(earlier);
      await append(value);
    }
    if (part === null) {
      await bucket.put(key, new Blob(head as BlobPart[]), { httpMetadata });
      return { bytes, chunks };
    }
    if (filled > 0) await flushPart(part);
    await upload?.complete(parts);
    return { bytes, chunks };
  } catch (error) {
    await upload?.abort().catch(() => undefined);
    throw error;
  }
}

/** 每日排程入口：執行備份，失敗（含缺少設定）時記錄並通知 Telegram 管理員；不丟錯。 */
export async function runDailyBackup(env: Env, now: Date) {
  try {
    if (!await runDatabaseBackup(env, now)) throw new Error("缺少 Supabase 設定或 BACKUPS 綁定");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("資料備份失敗", reason);
    await notifyBackupFailure(env, reason, now);
  }
}
