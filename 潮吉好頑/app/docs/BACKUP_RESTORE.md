# 備份還原 Runbook

每日備份由 Worker 寫到私有 R2 bucket `chaoji-backups` 的 `daily/<台灣日期>/snapshot.json`（2026-10-13 以前是每週的 `weekly/`）。快照格式見 `supabase/migrations/202610130002_backup_auth_identities.sql`。

原則：

- 整庫還原**只還原到全新、隔離的 Supabase 專案**，驗證完成後由店主決定是否切換；不在正式資料庫直接覆寫。
- 單筆補回（誤刪訂單等）才在正式資料庫操作，必須在一個 transaction 內完成，先 `rollback` 演練一次。
- 快照含全部會員個資。下載的檔案放在本機加密磁碟或 scratchpad，用完即刪；不可上傳到聊天、Issue 或公開位置。
- 由單一負責人執行，完成後在 `SECURITY_OPERATIONS_CHECKLIST.md` 記錄日期、快照檔名與結果。

## 快照內容

| 欄位 | 內容 |
| --- | --- |
| `taken_at` | 快照時間（同一個資料庫快照內讀出，訂單與明細不會錯開） |
| `format` | `2`（舊的 `weekly/` 檔案沒有這個欄位，也沒有 `auth_users`） |
| `migration_version` | 產生快照時已套用的最新 migration 版本 |
| `auth_users` | 每個 auth 使用者的 `id`、`created_at`、`identities[]`（`provider`、`provider_id`、`sub`、`created_at`）；不含密碼、email、token、session |
| `tables.<資料表>` | 20 張營運資料表的完整列 |

不含 `liff_session_vault`、`member_cart_items`、`line_low_stock_states`、`notification_deliveries`：還原後會員要重新以 LINE 登入、購物車為空、通知佇列從零開始。

## 1. 取得快照

```powershell
$env:WRANGLER_WRITE_LOGS='0'; npx wrangler r2 object get chaoji-backups/daily/2026-10-13/snapshot.json --remote --file <本機路徑>\snapshot.json
```

確認 `format` 為 2，並記下 `migration_version`。

## 2. 整庫還原到隔離專案

1. 在 Supabase 建立新專案。在 Authentication 設定與正式專案相同的 LINE 自訂 provider（`custom:line-web`），Redirect URL 指向測試網址。
2. 依檔名順序套用 `supabase/migrations/` 到 `migration_version` 為止（含），並寫入 migration 紀錄（同 `npm run db:history-sql` 的流程）。
3. 用 psql 連線到**新專案**（不要用 SQL Editor 貼大型 JSON），把快照讀進暫存表：

   ```sql
   create table public._restore_input (s jsonb not null);
   \set snap `type <本機路徑>\snapshot.json`
   insert into public._restore_input values (:'snap'::jsonb);
   ```

4. 重建 auth 使用者與 LINE 身分（id 必須與快照相同，`profiles`／`orders` 才對得上）：

   ```sql
   begin;
   insert into auth.users (instance_id, id, aud, role, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
   select '00000000-0000-0000-0000-000000000000', (u->>'id')::uuid, 'authenticated', 'authenticated',
          (u->>'created_at')::timestamptz, now(),
          jsonb_build_object('provider', 'custom:line-web', 'providers', jsonb_build_array('custom:line-web')), '{}'::jsonb
   from public._restore_input, jsonb_array_elements(s->'auth_users') u;

   insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
   select i->>'provider_id', (u->>'id')::uuid,
          jsonb_build_object('sub', i->>'sub', 'provider_id', i->>'provider_id'),
          i->>'provider', (i->>'created_at')::timestamptz, now()
   from public._restore_input, jsonb_array_elements(s->'auth_users') u, jsonb_array_elements(u->'identities') i;
   commit;
   ```

5. 匯入營運資料。`session_replication_role = replica` 暫停觸發器與外鍵檢查（含 audit_logs 不可修改的觸發器），只在這個隔離專案使用：

   ```sql
   begin;
   set local session_replication_role = replica;
   truncate public.categories, public.products, public.product_variants, public.product_images, public.profiles,
     public.bank_accounts, public.point_settings, public.birthday_coupon_settings, public.coupons, public.coupon_members,
     public.coupon_products, public.orders, public.order_items, public.order_status_history, public.inventory_reservations,
     public.inventory_movements, public.point_ledger, public.coupon_redemptions, public.birthday_coupon_issues, public.audit_logs;
   do $$
   declare t text;
   begin
     foreach t in array array['categories','products','product_variants','product_images','profiles','bank_accounts',
       'point_settings','birthday_coupon_settings','coupons','coupon_members','coupon_products','orders','order_items',
       'order_status_history','inventory_reservations','inventory_movements','point_ledger','coupon_redemptions',
       'birthday_coupon_issues','audit_logs'] loop
       execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I, (select s->''tables''->%L from public._restore_input))', t, t, t);
     end loop;
   end;
   $$;
   commit;
   ```

6. 驗證：
   - 每張表列數與快照一致：`select t, jsonb_array_length(s->'tables'->t) from public._restore_input, jsonb_object_keys(s->'tables') t;` 對照 `count(*)`。
   - 執行 `supabase/verify_schema.sql`，所有欄位為 true。
   - 抽查幾筆訂單的明細、狀態歷程、點數與商品可售量。
   - **以真實 LINE 帳號登入測試站，確認登入後的 user id 與快照相同、看得到自己的訂單與點數**（Supabase 是否把既有 identity 對回同一個 user id 只有實測能確認）。
7. `drop table public._restore_input;`，刪除本機快照檔。
8. 是否把正式 Worker 的 `SUPABASE_URL`／金鑰改指向新專案，由店主決定；切換前先暫停接單，並依 AGENTS.md 部署流程處理。

## 3. 單筆補回（正式資料庫）

適用：誤刪訂單或某筆設定，且快照之後該資料沒有其他變更。快照之後的變更（例如狀態推進、付款）要另外依 Telegram 通知或後台紀錄補上。

1. 用 psql 連線正式資料庫，把快照讀進**暫存表**（`create temp table _restore_input (s jsonb)`，連線結束自動消失），讀法同上。
2. 先列出要補回的列，確認沒有同 id 的現存資料：

   ```sql
   select o from _restore_input, jsonb_array_elements(s->'tables'->'orders') o where o->>'order_number' = 'CJ-…';
   ```

3. 在 transaction 內依外鍵順序補回：`orders` → `order_items` → `order_status_history` → `inventory_reservations` → `inventory_movements` → `point_ledger` → `coupon_redemptions`，每張表用 `jsonb_populate_recordset(null::public.<表>, …)` 並以 `order_id` 篩選。**不可**使用 `session_replication_role`；若觸發器擋下（例如建單時的 LINE 好友檢查），只在 transaction 內 `alter table … disable trigger <名稱>`，補完立即 `enable`。
4. 庫存：快照裡的 `product_variants.stock` 是快照當時的值，不要整列覆寫。依該訂單的狀態判斷——已確認的訂單有 `sale` 異動，刪除時若已把庫存加回，補回後要再扣；未確認的訂單只要恢復保留量。
5. 先以 `rollback` 結尾演練並檢查結果，確認後改為 `commit`。在訂單 `admin_note` 記錄「YYYY-MM-DD 依備份補回」。
