#!/usr/bin/env bash
# 交易測試：在一般 PostgreSQL（需 pg_cron）上建立全新資料庫，依序套用 Supabase 模擬層與全部 migration，
# 執行 verify_schema.sql，再跑 tests/db/*.test.sql。每個測試案例自行 begin … rollback。
#
# 連線使用標準 PG* 環境變數（PGHOST、PGPORT、PGUSER、PGPASSWORD）；資料庫名稱由 CJ_TEST_DB 指定，
# 預設 cj_test，且必須與 postgresql.conf 的 cron.database_name 相同。會刪除並重建該資料庫，
# 絕對不要指向正式或共用資料庫。
set -euo pipefail

cd "$(dirname "$0")/../.."
DB="${CJ_TEST_DB:-cj_test}"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 --no-psqlrc)

case "$DB" in
  postgres|template0|template1) echo "refusing to use database '$DB'" >&2; exit 1 ;;
esac

"${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\" with (force)" -c "create database \"$DB\""
"${PSQL[@]}" -d "$DB" -f tests/db/supabase-shim.sql

count=0
for migration in supabase/migrations/*.sql; do
  if ! output=$("${PSQL[@]}" -d "$DB" -f "$migration" 2>&1); then
    echo "migration failed: $migration" >&2
    echo "$output" >&2
    exit 1
  fi
  count=$((count + 1))
done
echo "applied $count migrations"

failed_checks=$({ echo "with v as ("; sed '1d;$ s/;$//' supabase/verify_schema.sql; echo ") select e.key from v, jsonb_each(to_jsonb(v)) e where e.value::text <> 'true';"; } | "${PSQL[@]}" -At -d "$DB")
if [ -n "$failed_checks" ]; then
  echo "verify_schema.sql checks not true:" >&2
  echo "$failed_checks" >&2
  exit 1
fi
echo "verify_schema.sql: all checks true"

"${PSQL[@]}" -d "$DB" -f tests/db/helpers.sql

status=0
for test_file in tests/db/*.test.sql; do
  if output=$("${PSQL[@]}" -d "$DB" -f "$test_file" 2>&1 >/dev/null); then
    echo "ok   $test_file"
  else
    echo "FAIL $test_file" >&2
    echo "$output" | grep -E "ERROR|ASSERTION|LINE [0-9]+|psql:" >&2 || echo "$output" >&2
    status=1
  fi
done
exit $status
