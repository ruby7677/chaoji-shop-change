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
