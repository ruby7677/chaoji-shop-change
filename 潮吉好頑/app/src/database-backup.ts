// 每週資料備份：呼叫 backup_snapshot()（migration 202610100001）在同一個資料庫快照內讀出所有營運資料表，
// 邊讀邊寫入私有 R2 bucket（BACKUPS，沒有公開網域）。分表分頁讀取會讀到不同時間點的資料，還原時可能違反外鍵。
// 由專用的每週 Cron Trigger 呼叫（見 wrangler.jsonc 與 index.ts）；回應本體不解析，CPU 與記憶體用量都很低。
// 舊備份由 bucket 的生命週期規則自動刪除（見 SECURITY_OPERATIONS_CHECKLIST.md）。
import type { Env } from "./env";
import { fetchWithTimeout, serviceHeaders } from "./http";
import { taipeiDate } from "./notifications";

/** 每週日 19:00 UTC（台灣週一 03:00，離峰）；必須與 wrangler.jsonc 的 crons 項目一致。 */
export const BACKUP_CRON = "0 19 * * 0";

/** 快照可能比一般 API 回應大，給較長的逾時。 */
const SNAPSHOT_TIMEOUT_MS = 60_000;

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
  }, SNAPSHOT_TIMEOUT_MS);
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`backup_snapshot failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("backup_snapshot returned no body");
  const key = `weekly/${taipeiDate(now)}/snapshot.json`;
  await storeStream(env.BACKUPS, key, response.body);
  return key;
}

/** R2 分段上傳每段大小（除最後一段外每段必須相同，且至少 5 MiB）。 */
export const BACKUP_PART_SIZE = 10 * 1024 * 1024;

/**
 * 邊讀邊寫入 R2，記憶體只保留一段：小於一段時直接 put，否則改用分段上傳。
 * 快照會隨資料量成長，不能整份讀進 Worker 記憶體（上限 128 MB）。
 */
export async function storeStream(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, partSize = BACKUP_PART_SIZE) {
  const httpMetadata = { contentType: "application/json" };
  const reader = body.getReader();
  let part = new Uint8Array(partSize);
  let filled = 0;
  let upload: R2MultipartUpload | null = null;
  const parts: R2UploadedPart[] = [];
  const flushPart = async () => {
    upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
    parts.push(await upload.uploadPart(parts.length + 1, part.subarray(0, filled)));
    part = new Uint8Array(partSize);
    filled = 0;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length;) {
        const count = Math.min(partSize - filled, value.length - offset);
        part.set(value.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === partSize) await flushPart();
      }
    }
    if (!upload) return void await bucket.put(key, part.subarray(0, filled), { httpMetadata });
    if (filled > 0) await flushPart();
    await (upload as R2MultipartUpload).complete(parts);
  } catch (error) {
    await (upload as R2MultipartUpload | null)?.abort().catch(() => undefined);
    throw error;
  }
}
