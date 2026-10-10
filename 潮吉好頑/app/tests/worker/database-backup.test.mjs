// 每週資料備份（src/database-backup.ts）：只讀取清單內的資料表、依 Content-Range 分頁、單表失敗不影響其他表、不寫出 service key。
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, fakeR2, loadSourceModule, stubFetch } from "./harness.mjs";

const backup = await loadSourceModule("database-backup");
const NOW = new Date(Date.UTC(2026, 9, 11, 19, 0));
const PREFIX = "weekly/2026-10-12";

let restoreFetch = () => {};
afterEach(() => restoreFetch());

const page = (rows, start, total) => new Response(JSON.stringify(rows), {
  headers: { "Content-Type": "application/json", "Content-Range": rows.length ? `${start}-${start + rows.length - 1}/${total}` : `*/${total}` }
});

function stubTables(handler) {
  const calls = [];
  restoreFetch = stubFetch((url, init) => {
    calls.push({ table: url.pathname.replace("/rest/v1/", ""), offset: Number(url.searchParams.get("offset")), url, init });
    return handler(url) ?? page([], 0, 0);
  });
  return calls;
}

test("totalFromContentRange reads the total and rejects missing totals", () => {
  assert.equal(backup.totalFromContentRange("0-999/1234"), 1234);
  assert.equal(backup.totalFromContentRange("*/0"), 0);
  assert.equal(backup.totalFromContentRange("0-9/*"), null);
  assert.equal(backup.totalFromContentRange(null), null);
});

test("only listed tables are read, never session or cart tables, with the service key in headers only", async () => {
  const calls = stubTables(() => null);
  const bucket = fakeR2();
  await backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW);
  const tables = calls.map((call) => call.table);
  assert.deepEqual(tables, backup.BACKUP_TABLES.map(([table]) => table));
  for (const excluded of ["liff_session_vault", "member_cart_items", "line_low_stock_states", "notification_deliveries"]) assert.ok(!tables.includes(excluded));
  for (const call of calls) {
    assert.equal(call.init.method ?? "GET", "GET");
    assert.ok(!call.url.href.includes("service-key"));
    assert.equal(call.init.headers.Prefer, "count=exact");
  }
});

test("pages follow Content-Range and each page is stored as its own object", async () => {
  const size = backup.BACKUP_PAGE_SIZE;
  const calls = stubTables((url) => {
    if (url.pathname !== "/rest/v1/audit_logs") return null;
    const offset = Number(url.searchParams.get("offset"));
    const total = size + 2;
    const count = Math.min(size, total - offset);
    return page(Array.from({ length: count }, (_, i) => ({ id: offset + i })), offset, total);
  });
  const bucket = fakeR2();
  const results = await backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW);
  assert.deepEqual(calls.filter((call) => call.table === "audit_logs").map((call) => call.offset), [0, size]);
  assert.ok(bucket.objects.has(`${PREFIX}/audit_logs/000.json`));
  assert.ok(bucket.objects.has(`${PREFIX}/audit_logs/001.json`));
  assert.deepEqual(results.find((item) => item.table === "audit_logs"), { table: "audit_logs", rows: size + 2, pages: 2 });
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${PREFIX}/manifest.json`).bytes));
  assert.equal(manifest.complete, true);
});

test("one failing table is reported in the manifest without stopping the others", async () => {
  stubTables((url) => (url.pathname === "/rest/v1/orders" ? new Response("boom", { status: 500 }) : null));
  const bucket = fakeR2();
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW);
  } finally {
    console.error = originalError;
  }
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${PREFIX}/manifest.json`).bytes));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.tables.find((item) => item.table === "orders").error, "HTTP 500");
  assert.ok(bucket.objects.has(`${PREFIX}/audit_logs/000.json`));
  assert.ok(logged.some((line) => line.includes("orders")));
  assert.ok(!logged.some((line) => line.includes("service-key")));
});

test("stops at the fetch budget and marks the backup incomplete", async () => {
  const size = backup.BACKUP_PAGE_SIZE;
  const calls = stubTables((url) => {
    const offset = Number(url.searchParams.get("offset"));
    return page([{ id: offset }], offset, size * 100);
  });
  const bucket = fakeR2();
  const originalError = console.error;
  console.error = () => {};
  try {
    await backup.runDatabaseBackup({ ...baseEnv, BACKUPS: bucket }, NOW);
  } finally {
    console.error = originalError;
  }
  assert.equal(calls.length, backup.BACKUP_FETCH_BUDGET);
  const manifest = JSON.parse(new TextDecoder().decode(bucket.objects.get(`${PREFIX}/manifest.json`).bytes));
  assert.equal(manifest.complete, false);
});

test("does nothing without the BACKUPS binding or Supabase settings", async () => {
  const calls = stubTables(() => null);
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

test("the weekly backup cron runs only the backup, and wrangler.jsonc schedules it", async () => {
  const { loadWorker, ctx } = await import("./harness.mjs");
  const { readFile } = await import("node:fs/promises");
  const worker = await loadWorker();
  const calls = stubTables(() => null);
  const bucket = fakeR2();
  const context = ctx();
  worker.scheduled({ cron: backup.BACKUP_CRON, scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: bucket }, context);
  await context.settle();
  assert.deepEqual(calls.map((call) => call.table), backup.BACKUP_TABLES.map(([table]) => table));
  assert.ok(bucket.objects.has(`${PREFIX}/manifest.json`));
  const config = await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert.ok(config.includes(`"${backup.BACKUP_CRON}"`));
});

test("the hourly cron never runs the backup", async () => {
  const { loadWorker, ctx } = await import("./harness.mjs");
  const worker = await loadWorker();
  const calls = stubTables(() => null);
  const context = ctx();
  worker.scheduled({ cron: "0 * * * *", scheduledTime: NOW.getTime() }, { ...baseEnv, BACKUPS: fakeR2() }, context);
  await context.settle();
  assert.ok(!calls.some((call) => call.table === "audit_logs"));
});
