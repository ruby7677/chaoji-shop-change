// 產生比對 supabase_migrations.schema_migrations 與 supabase/migrations/ 的 SQL（只輸出 SQL，不連線資料庫）。
//   npm run db:history-sql            → 唯讀檢查：回傳 0 列代表紀錄與 repo 一致
//   npm run db:history-sql -- align   → 把以名稱對得上、但版本是套用時間戳（Supabase MCP／Dashboard 產生）的紀錄改成檔名版本
// 也會檢查檔名格式（12 碼版本_小寫名稱.sql）與版本、名稱不可重複；格式錯誤時以非零結束。
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const FILE_PATTERN = /^(\d{12})_([a-z0-9_]+)\.sql$/;
const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const problems = [];
const migrations = files.map((file) => {
  const match = FILE_PATTERN.exec(file);
  if (!match) problems.push(`檔名不符合 <12 碼版本>_<小寫名稱>.sql：${file}`);
  return match ? { version: match[1], name: match[2] } : null;
}).filter(Boolean);
for (const key of ["version", "name"]) {
  const seen = new Set();
  for (const migration of migrations) {
    if (seen.has(migration[key])) problems.push(`重複的 ${key}：${migration[key]}`);
    seen.add(migration[key]);
  }
}
if (problems.length) {
  process.stderr.write(problems.join("\n") + "\n");
  process.exit(1);
}

const repoValues = migrations.map(({ version, name }) => `  ('${version}', '${name}')`).join(",\n");
const mode = process.argv[2] ?? "check";

if (mode === "check") {
  process.stdout.write(`-- 唯讀：repo ${migrations.length} 支 migration 與遠端紀錄的差異，0 列代表一致。
with repo(version, name) as (values
${repoValues}
), history as (select version, name from supabase_migrations.schema_migrations)
select 'missing_in_history' as status, r.version, r.name from repo r where not exists (select 1 from history h where h.version = r.version)
union all
select 'not_in_repo', h.version, h.name from history h where not exists (select 1 from repo r where r.version = h.version)
union all
select 'name_mismatch', r.version, r.name || ' <> ' || coalesce(h.name, '(null)') from repo r join history h using (version) where h.name is distinct from r.name
order by 2, 1;
`);
} else if (mode === "align") {
  process.stdout.write(`-- 把名稱對得上、版本卻是 14 碼套用時間戳的紀錄改成 repo 檔名版本；不改 statements／created_by。
update supabase_migrations.schema_migrations h
   set version = r.version
  from (values
${repoValues}
  ) r(version, name)
 where h.name = r.name
   and h.version <> r.version
   and h.version ~ '^[0-9]{14}$'
returning r.version, r.name;
`);
} else {
  process.stderr.write(`未知模式：${mode}（可用 check、align）\n`);
  process.exit(1);
}
