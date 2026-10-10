// 每週資料備份（src/database-backup.ts）：一次呼叫 backup_snapshot() 並原樣寫入 R2；只在每週排程執行，失敗會丟錯、不寫出 service key。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { baseEnv, ctx, fakeR2, jsonResponse, loadSourceModule, loadWorker, stubFetch } from "./harness.mjs";

const backup = await loadSourceModule("database-backup");
const worker = await loadWorker();
const NOW = new Date(Date.UTC(2026, 9, 11, 19, 0));
const KEY = "weekly/2026-10-12/snapshot.json";
const SNAPSHOT = { taken_at: "2026-10-11T19:00:00Z", tables: { orders: [{ id: "o1" }] } };

let restoreFetch = () => {};
afterEach(() => restoreFetch());

function stubSnapshot(response = () => jsonResponse(SNAPSHOT)) {
  const calls = [];
  restoreFetch = stubFetch((url, init) => { calls.push({ url, init }); return response(); });
  return calls;
}

test("one POST to backup_snapshot, stored unchanged under the Taipei date", async () => {
  const calls = stubSnapshot();
  const bucket = fakeR2();
  assert.equal(await backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW), KEY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://db.test/rest/v1/rpc/backup_snapshot");
  assert.equal(calls[0].init.method, "POST");
  assert.ok(!calls[0].url.href.includes("service-key"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bucket.objects.get(KEY).bytes)), SNAPSHOT);
  assert.equal(bucket.objects.get(KEY).httpMetadata.contentType, "application/json");
});

test("a failed snapshot throws without writing to R2 or exposing the key", async () => {
  stubSnapshot(() => new Response("denied", { status: 403 }));
  const bucket = fakeR2();
  await assert.rejects(backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW), (error) => error.message.includes("HTTP 403") && !error.message.includes("service-key"));
  assert.equal(bucket.objects.size, 0);
});

test("does nothing without the BACKUPS binding or Supabase settings", async () => {
  const calls = stubSnapshot();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await backup.runDatabaseBackup({ ...baseEnv }, NOW), null);
    assert.equal(await backup.runDatabaseBackup({ BACKUPS: fakeR2() }, NOW), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 0);
});

test("the weekly cron runs the backup with its scheduled time, and wrangler.jsonc schedules it", async () => {
  const calls = stubSnapshot();
  const bucket = fakeR2();
  const context = ctx();
  worker.scheduled({ cron: backup.BACKUP_CRON, scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: bucket }, context);
  await context.settle();
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/rest/v1/rpc/backup_snapshot"]);
  assert.ok(bucket.objects.has(KEY));
  const config = await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(config.includes(`"${backup.BACKUP_CRON}"`));
});

test("a failing weekly backup is logged, not thrown out of the scheduled handler", async () => {
  stubSnapshot(() => new Response("boom", { status: 500 }));
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    const context = ctx();
    worker.scheduled({ cron: backup.BACKUP_CRON, scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: fakeR2() }, context);
    await context.settle();
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((line) => line.includes("HTTP 500")));
});

test("the hourly cron never runs the backup", async () => {
  const calls = stubSnapshot(() => jsonResponse([]));
  const context = ctx();
  worker.scheduled({ cron: "0 * * * *", scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: fakeR2() }, context);
  await context.settle();
  assert.ok(!calls.some((call) => call.url.pathname === "/rest/v1/rpc/backup_snapshot"));
});

function multipartBucket({ failPart = 0 } = {}) {
  const events = [];
  const bucket = fakeR2({ events });
  bucket.createMultipartUpload = async (key) => {
    const uploaded = [];
    events.push(["create", key]);
    return {
      async uploadPart(number, bytes) {
        if (number === failPart) throw new Error(`part ${number} failed`);
        uploaded.push([number, new Uint8Array(bytes)]);
        events.push(["part", number, bytes.length]);
        return { partNumber: number, etag: `e${number}` };
      },
      async complete(parts) {
        events.push(["complete", parts.map((part) => part.partNumber)]);
        const all = uploaded.sort((a, b) => a[0] - b[0]).flatMap(([, bytes]) => [...bytes]);
        await bucket.put(key, new Uint8Array(all));
      },
      async abort() { events.push(["abort"]); }
    };
  };
  return { bucket, events };
}

const streamOf = (...chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });

test("streams large snapshots in equal-sized parts and reassembles them exactly", async () => {
  const { bucket, events } = multipartBucket();
  await backup.storeStream(bucket, "k", streamOf("abc", "defgh", "ij"), 4);
  assert.deepEqual(events.filter(([type]) => type === "part").map(([, number, size]) => [number, size]), [[1, 4], [2, 4], [3, 2]]);
  assert.deepEqual(events.find(([type]) => type === "complete"), ["complete", [1, 2, 3]]);
  assert.equal(new TextDecoder().decode(bucket.objects.get("k").bytes), "abcdefghij");
});

test("a snapshot smaller than one part uses a single put", async () => {
  const { bucket, events } = multipartBucket();
  await backup.storeStream(bucket, "k", streamOf("ab", "c"), 4);
  assert.ok(!events.some(([type]) => type === "create"));
  assert.equal(new TextDecoder().decode(bucket.objects.get("k").bytes), "abc");
});

test("a failed part aborts the upload and leaves no object", async () => {
  const { bucket, events } = multipartBucket({ failPart: 2 });
  await assert.rejects(backup.storeStream(bucket, "k", streamOf("abcdefghij"), 4), /part 2 failed/);
  assert.ok(events.some(([type]) => type === "abort"));
  assert.ok(!bucket.objects.has("k"));
});

test("the backup time budget covers download and R2 uploads but stays inside the 15-minute cron limit", () => {
  assert.ok(backup.BACKUP_TIMEOUT_MS >= 5 * 60_000);
  assert.ok(backup.BACKUP_TIMEOUT_MS < 15 * 60_000);
});

test("slow R2 parts do not abort a body that is still within the backup budget", async () => {
  const { bucket } = multipartBucket();
  const slowPart = bucket.createMultipartUpload;
  bucket.createMultipartUpload = async (key) => {
    const upload = await slowPart(key);
    const uploadPart = upload.uploadPart;
    upload.uploadPart = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 30)); return uploadPart(...args); };
    return upload;
  };
  // 本體讀取綁定逾時訊號（同 fetchWithTimeout）；上傳等待 30ms × 3 段仍在預算內
  const signal = AbortSignal.timeout(500);
  const source = streamOf("abcdefghij");
  const body = source.pipeThrough(new TransformStream(), { signal });
  await backup.storeStream(bucket, "k", body, 4);
  assert.equal(new TextDecoder().decode(bucket.objects.get("k").bytes), "abcdefghij");
});

// 備份失敗通知：先排入通知佇列；資料庫無法使用（佇列寫不進去）時直接送 Telegram；成功時不通知。
async function runWeekly(env, handler) {
  const seen = { claims: [], direct: [] };
  restoreFetch = stubFetch((url, init, body) => {
    if (url.hostname === "api.telegram.org") { seen.direct.push(body); return jsonResponse({ ok: true }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") {
      seen.claims.push(body);
      return handler.claim ? handler.claim() : jsonResponse({ id: "n1", claim_token: null, status: "sent", attempt_count: 1, payload: {}, claimed: false });
    }
    if (url.pathname === "/rest/v1/rpc/backup_snapshot") return handler.snapshot();
    throw new Error(`unexpected request ${url}`);
  });
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    const context = ctx();
    worker.scheduled({ cron: backup.BACKUP_CRON, scheduledTime: NOW.getTime() }, env, context);
    await context.settle();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  return seen;
}

test("a failed weekly backup queues one Telegram alert per admin with the reason", async () => {
  const seen = await runWeekly({ ...baseEnv, BACKUPS: fakeR2() }, { snapshot: () => new Response("boom", { status: 500 }) });
  assert.deepEqual(seen.claims.map((claim) => claim.p_recipient_id), ["111", "222"]);
  for (const claim of seen.claims) {
    assert.equal(claim.p_channel, "telegram");
    assert.equal(claim.p_event_type, "backup_failed");
    assert.equal(claim.p_event_key, "backup-failed:2026-10-12");
    assert.match(claim.p_payload.text, /每週資料備份失敗[\s\S]*備份日期：2026-10-12[\s\S]*原因：backup_snapshot failed: HTTP 500/);
    assert.ok(!claim.p_payload.text.includes("service-key"));
  }
  assert.equal(seen.direct.length, 0);
});

test("when the database cannot queue the alert, it is sent to Telegram directly", async () => {
  const seen = await runWeekly({ ...baseEnv, BACKUPS: fakeR2() }, {
    snapshot: () => new Response("down", { status: 503 }),
    claim: () => new Response("down", { status: 503 })
  });
  assert.deepEqual(seen.direct.map((message) => message.chat_id), ["111", "222"]);
  assert.match(seen.direct[0].text, /HTTP 503/);
});

test("a lost completion after Telegram accepted the alert is not sent again directly", async () => {
  const sent = [];
  restoreFetch = stubFetch((url, init, body) => {
    if (url.hostname === "api.telegram.org") { sent.push(body.chat_id); return jsonResponse({ ok: true, result: {} }); }
    if (url.pathname === "/rest/v1/rpc/claim_notification_delivery") return jsonResponse({ id: `n-${body.p_recipient_id}`, claim_token: "t", status: "sending", attempt_count: 1, payload: body.p_payload, claimed: true });
    if (url.pathname === "/rest/v1/rpc/complete_notification_delivery") throw new TypeError("connection reset");
    if (url.pathname === "/rest/v1/rpc/backup_snapshot") return new Response("boom", { status: 500 });
    throw new Error(`unexpected request ${url}`);
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    const context = ctx();
    worker.scheduled({ cron: backup.BACKUP_CRON, scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: fakeR2() }, context);
    await context.settle();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(sent.sort(), ["111", "222"], "each admin gets exactly one message");
});

test("a missing BACKUPS binding is reported as a failure", async () => {
  const seen = await runWeekly({ ...baseEnv }, { snapshot: () => jsonResponse({}) });
  assert.equal(seen.claims.length, 2);
  assert.match(seen.claims[0].p_payload.text, /缺少 Supabase 設定或 BACKUPS 綁定/);
});

test("a successful weekly backup sends no alert", async () => {
  const bucket = fakeR2();
  const seen = await runWeekly({ ...baseEnv, BACKUPS: bucket }, { snapshot: () => jsonResponse(SNAPSHOT) });
  assert.ok(bucket.objects.has(KEY));
  assert.equal(seen.claims.length + seen.direct.length, 0);
});

test("the alert stays quiet when Telegram notifications are disabled", async () => {
  const seen = await runWeekly({ ...baseEnv, TELEGRAM_NOTIFY_ENABLED: "false", BACKUPS: fakeR2() }, { snapshot: () => new Response("boom", { status: 500 }) });
  assert.equal(seen.claims.length + seen.direct.length, 0);
});
