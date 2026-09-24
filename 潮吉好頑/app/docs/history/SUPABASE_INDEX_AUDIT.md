# Supabase Index / Advisor Audit（Phase 8+）

本文件是唯讀審查紀錄。審查期間沒有執行 DDL、migration、`ANALYZE`、部署，也沒有修改 `src/`、`public/`、`supabase/migrations/` 或 `wrangler`。下方 SQL 全部只是候選草案，不能直接視為已套用。

## 審查範圍與資料時間

- 專案：Supabase `labubu`，ref `csiviervpnxdzyfcuamm`，Postgres 17.6.1，region `ap-northeast-1`。
- 遠端 migration 清單已到 `category_management`（對應本機 `app/supabase/migrations/202609150010_category_management.sql`）。本次讀取了初始 schema、訂單／庫存／折扣流程、security hardening、公開商品 view、購物車與分類管理等 migration，以及 Worker 的實際 API 查詢。
- 以 Supabase MCP read-only 工具讀取：Performance Advisors、table/column/FK 摘要、`pg_stat_user_tables`、`pg_stat_user_indexes`、`pg_stat_statements`、RLS policies、`cron.job`、函式與 view 定義。
- `pg_stat_database.stats_reset = 2026-08-25 20:33:23+00`；因此 scan/call 數是自該時間起累積，並非單次請求的 benchmark。`n_live_tup` 是統計估計／目前 table stats，不代表固定容量承諾。

## 結論先行

1. **真正有背景熱路徑證據的是 expired-order cleanup。** `chaoji-release-expired-orders` 每分鐘執行，`pg_stat_statements` 自 reset 後記錄 `select public.cancel_expired_orders()` 11,659 次，平均 4.668 ms。現有 `orders_member_status_created_idx (member_id, status, created_at)` 不適合 `status + payment_deadline` 的 cleanup predicate；未來最有價值的候選是只涵蓋 pending 狀態的 `payment_deadline` partial index。現在 orders 只有 2 筆，所以這是「應在規模增長前驗收」而非「目前延遲已失控」。
2. **庫存 reservation 有兩個不同 access pattern，不能用一個泛用 index 代替。** 下單／公開庫存 view 以 `variant_id` 聚合未釋放且未過期的數量；狀態 trigger／cleanup 則以 `order_id` 更新未釋放 reservation。兩個 partial composite index 是合理草案，但它們不一定會讓 Advisor 的 FK lint 消失；若目標是 lint=0，需在驗證後選擇完整 FK index，避免同時建立重複索引。
3. **`inventory_movements.created_at` 是真實的列表查詢 hot path，但目前只有 44 筆。** 管理台明確查 `order=created_at.desc&limit=50`（`app/src/index.ts:784`），目前平均約 1 ms；資料長大後再以 `created_at DESC` index 驗收「無 Sort、bounded scan」。
4. **`product_variants.product_id` 與 `coupon_members.member_id` 有明確查詢形狀，但資料量尚不足以證明立即收益。** 前者支援商品→規格的 nested catalog/admin 查詢；後者支援 `member_available_coupons()` 的會員反查。建議採能同時覆蓋 FK 與查詢形狀的 composite index，而不是盲目加 standalone index。
5. **`order_items.variant_id`、`products.category_id`、`coupon_products.product_id`、`coupon_redemptions.member_id` 及其餘低頻 FK 目前屬 hygiene／未來規模候選。** 現有 order-first composite/unique keys 已經服務主要訂單讀取，當前資料量低，沒有理由只為清掉 INFO lint 一次建立 20 個 index。
6. Advisor 的兩個 unused-index finding 不代表應刪除：`coupon_redemptions_usage_idx (coupon_id, member_id)` 正好對應優惠券總量／會員限額查詢，只是目前 redemption rows 為 0；`categories_active_order_idx` 只有在 query 帶 `is_active` filter 時才有機會使用。

## Advisor snapshot（2026-09-18）

Performance Advisor 回報：

| lint | level | count | 判讀 |
|---|---:|---:|---|
| `unindexed_foreign_keys` | INFO | 20 | 20 個 FK 沒有完整、可覆蓋該 FK 的 leading index；詳見下表。 |
| `auth_rls_initplan` | WARN | 4 | `profiles` 兩個 policy、`orders` 一個、`order_items` 一個仍逐 row 評估 `auth.uid()`。 |
| `unused_index` | INFO | 2 | `coupon_redemptions_usage_idx`、`categories_active_order_idx`；目前資料量不足以判定設計錯誤。 |
| `multiple_permissive_policies` | WARN | 1 | `member_cart_items` 的 authenticated SELECT 同時命中兩個相同 predicate 的 permissive policy。 |

Advisor remediation links：
[unindexed FK](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)、[RLS initplan](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan)、[unused index](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)、[multiple permissive policies](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies)。

## 目前資料量與統計證據

| table | `n_live_tup` | `seq_scan` | `idx_scan` | 審查解讀 |
|---|---:|---:|---:|---|
| `orders` | 2 | 18,617 | 3,375 | scan 次數高主要是每分鐘 cleanup、API/RPC；資料本身仍極小。 |
| `inventory_reservations` | 2 | 1,445 | 5 | reservation access pattern 已存在，但現在 Seq Scan 對 2 筆沒有實質延遲。 |
| `order_items` | 2 | 6,186 | 1,904 | order-first unique index 已被大量使用；沒有 variant-first 證據。 |
| `product_variants` | 4 | 3,665 | 7,579 | pkey／SKU 讀取很多；product_id FK/nested join index 尚不存在。 |
| `products` | 4 | 895 | 11,264 | category reverse join 尚小；沒有現行 category filter 的容量壓力。 |
| `inventory_movements` | 44 | 423 | 5 | pkey 不服務 newest-50；`created_at` index 是日後列表成長的第一候選。 |
| `coupon_members` | 0 | 1 | 281 | 目前無資料；281 次 index access 多半是 PK 或 metadata/API 查詢。 |
| `coupon_products` | 0 | 1 | 0 | 目前無資料；coupon-first PK 已足夠。 |
| `coupon_redemptions` | 0 | 6 | 63 | 目前無資料；usage index 仍應保留，不能用 unused finding 推論刪除。 |
| `categories` | 3 | 670 | 2,277 | 只有 3 筆；active-order index 未使用不構成現在的問題。 |

最有辨識力的 runtime 證據：

- `cron.job`：`chaoji-release-expired-orders` 為 `* * * * *`，command 是 `select public.cancel_expired_orders();`；birthday coupon job 則每日一次。
- `pg_stat_statements`：`select public.cancel_expired_orders()` 11,659 calls、total 54,422.18 ms、mean 4.668 ms、shared blocks hit 6,520,549。
- 管理台 inventory movement 查詢在 `app/src/index.ts:784`：選取最近 50 筆並 `order=created_at.desc`；同類 pg_stat entry 約 354 calls、mean 1.079 ms、shared blocks hit 30,911。
- Worker 的 cancelled notification 查詢在 `app/src/index.ts:388-397`，目前約 37 calls、mean 0.103 ms；若日後 orders 很大，才考慮 `cancelled_at` partial index。

## Phase 8+ access-path review

### A. Expired orders：優先驗收，現在可延後套用

Migration `202609140001_security_hardening.sql:205-235` 的現行函式以：

```sql
status in ('pending_payment', 'pending_review')
and payment_deadline <= current_timestamp
for update skip locked
```

逐筆取消 order，再以 `inventory_reservations.order_id` 釋放 reservation。現有 `orders_member_status_created_idx` 的 leading column 是 `member_id`，不能有效支援這個全表 pending deadline scan。

**SQL 草案（不執行）**：

```sql
-- time-dependent payment_deadline 不可直接放進 partial predicate；
-- 只把穩定的 status 條件放入 predicate。
create index orders_pending_deadline_idx
  on public.orders (payment_deadline)
  where status in ('pending_payment', 'pending_review');
```

這個 partial index 的 predicate 必須與函式查詢保持可由 planner 推導的形式。若要加速每小時的通知查詢，另有低優先候選：

```sql
-- SQL 草案（不執行）；目前 orders 只有 2 筆，先不要急著加。
create index orders_cancelled_at_idx
  on public.orders (cancelled_at)
  where status = 'cancelled';
```

兩者是不同 query：前者服務 pg_cron cleanup，後者服務 `status=cancelled and cancelled_at >= ... order by cancelled_at asc limit 100`。不要用其中一個假設能覆蓋另一個。

### B. Inventory reservations：兩條 hot path、兩個候選

Initial schema `202609080001_initial_schema.sql:61-69` 沒有 reservation index。庫存可用量在 initial/storefront/order migrations 中都會使用 `variant_id`，且條件是 `released_at is null and expires_at > now()`；訂單狀態 trigger／cleanup 則使用 `order_id = ... and released_at is null`。

**SQL 草案（不執行）**：

```sql
-- 下單與公開 storefront_available_stock 的聚合。
create index inventory_reservations_active_variant_expiry_idx
  on public.inventory_reservations (variant_id, expires_at)
  where released_at is null;

-- pending_review / confirmed / cancelled / expired cleanup 的 lifecycle update。
create index inventory_reservations_open_order_idx
  on public.inventory_reservations (order_id)
  where released_at is null;
```

這兩個是 partial index，適合 query 形狀但**不一定會讓 `unindexed_foreign_keys` 對 `variant_id`／`order_id` 消失**，因為 FK 需要涵蓋所有可能的 child rows。若產品決策是 Advisor 必須降為 0，改以完整 index 為準；不要在沒有 plan/size 證據時同時建立完整與 partial 兩套。

另外，現行 cleanup 沒有單獨以 `expires_at` 掃整張 reservation table，而是先從 expired orders 找 order 再依 `order_id` 釋放，所以目前不建議單獨建立 `inventory_reservations(expires_at)`。

### C. `order_items`：order-first 已是正確主要路徑

`202609140001_security_hardening.sql:97-99` 已有：

```sql
unique (order_id, variant_id)
```

這已服務 `admin_transition_order`（`202609110004_store_payment.sql:211-217`）和 PostgREST orders→order_items nested query。Advisor 仍標記 `order_items.variant_id`，因為 composite index 的 leading column 是 `order_id`，不能支援 variant-first join/FK maintenance。

**判定：低優先，除非出現 variant-centric 報表、variant history 或大量刪除／更新父 row。** 不要再建一個 `(order_id, variant_id)` 的重複 index；若確實需要反查才使用下列草案：

```sql
-- SQL 草案（不執行）；只在 variant-first EXPLAIN 證明需要時建立。
create index order_items_variant_id_idx
  on public.order_items (variant_id);
```

### D. `product_variants.product_id`：catalog/admin nested path，建議一個涵蓋式 index

`product_variants` 的 FK 在 `202609080001_initial_schema.sql:41-59`，公開 view `202609140002_public_catalog_security.sql:38-60` 直接 `products p join product_variants v on p.id = v.product_id`；admin dashboard 也從 products nested 取 variants（`app/src/index.ts:782`）。

**SQL 草案（不執行）**：

```sql
-- leading product_id 同時覆蓋 FK；display_order 可支援每商品規格排序。
create index product_variants_product_display_idx
  on public.product_variants (product_id, display_order);
```

如果實測 nested relation 沒有依 `display_order` 排序，較小的 `(product_id)` 也可以；不要兩個都建。因為 FK 必須涵蓋 unpublished rows，這裡不建議用只含 `is_published` 的 partial index 取代完整 index。

### E. Coupon 三表：分清 coupon-first 與 member/product-first

`202609100006_discounts.sql:26-45,71-73,168-176,203-225` 已經建立：

- `coupon_members` PK `(coupon_id, member_id)`：適合 admin 按 coupon 重建名單、checkout 先知道 coupon id 再檢查 member；不適合 `member_available_coupons()` 的 `where cm.member_id = auth.uid()`。
- `coupon_products` PK `(coupon_id, product_id)`：適合 checkout 的 `coupon_id` existence/product eligibility；目前沒有 product-first customer path。
- `coupon_redemptions_usage_idx (coupon_id, member_id)`：正好支援 coupon total usage 與 per-member usage count；目前 0 rows，所以 Advisor 標記 unused 是預期現象。

會員資料載入會呼叫 `rpc/member_available_coupons`（`app/src/index.ts:742-747`），因此真正有資料後，最合理的單一候選是：

```sql
-- SQL 草案（不執行）；同時服務 member-first query 與 member_id FK lint。
create index coupon_members_member_coupon_idx
  on public.coupon_members (member_id, coupon_id);
```

`coupon_products.product_id` 與 `coupon_redemptions.member_id` 目前都屬低優先。只有在新增「某商品有哪些 coupon」或「會員 redemption history」等反向查詢，或 FK delete/update 開始出現 lock/scan 問題時，才考慮 `(product_id, coupon_id)`／`(member_id, coupon_id)`。不要為了 unused `coupon_redemptions_usage_idx` 而刪除它。

### F. `products.category_id`：reverse category join 的容量候選

`202609150010_category_management.sql:6-10` 只在 categories 建了 `(is_active, display_order, name)`。公開 view 是 product-driven 的 `left join categories c on c.id = p.category_id`，categories 的 PK 已有 index；只有 category→products 的反向 join／統計（例如分類商品數）會直接受 `products.category_id` 影響。

**判定：目前低優先。** products 只有 4 筆，admin category count 也不是已證明的瓶頸。若 category/product 數量成長，候選為：

```sql
-- SQL 草案（不執行）；若只需要 FK/reverse join，使用單欄即可。
create index products_category_id_idx
  on public.products (category_id);
```

`categories_active_order_idx` 目前 unused 的原因也合理：目前 API 查詢 `order=display_order.asc,name.asc` 沒有 `is_active` equality filter；若未來查詢固定 `where is_active = true` 才能期待該 index 被使用。

### G. `inventory_movements.created_at`：列表 hot path，成長後優先

Initial schema `202609080001_initial_schema.sql:121-130` 只有 pkey。Admin dashboard 在 `app/src/index.ts:784` 取 movement 最近 50 筆並依 `created_at desc` 排序，現在 `inventory_movements` 有 44 筆、目前只有 pkey `idx_scan=5`；pg_stat 約 354 calls、平均 1.079 ms。

**SQL 草案（不執行）**：

```sql
create index inventory_movements_created_at_idx
  on public.inventory_movements (created_at desc);
```

若需要穩定同時間排序，可把 query 與 index 一起改成 `(created_at desc, id desc)`，但那會是行為／查詢契約變更，不能只加 index 就假設需要。`variant_id` 的 nested lookup 仍由 variant PK 完成；不要把 `created_at` index 誤當成 FK index。

## 20 個 unindexed FK 核對表

以下名稱與 Performance Advisor 的 20 findings 一一對應。`hot` 表示已有實際 query/access path；`hygiene` 表示主要是 FK maintenance、反向查詢或未來規模，不能從目前的小資料量推導立即收益。

| # | FK child column | Advisor 判定 | 建議 |
|---:|---|---|---|
| 1 | `birthday_coupon_settings.updated_by` | hygiene | singleton 設定；延後。 |
| 2 | `coupon_members.member_id` | hot candidate | 優先考慮 `(member_id, coupon_id)`，不要另建重複 standalone。 |
| 3 | `coupon_products.product_id` | hygiene | coupon-first PK 已覆蓋現行 checkout；product-first path 出現再加。 |
| 4 | `coupon_redemptions.member_id` | hygiene | 現行 usage index 已是 coupon-first；會員歷史出現再加。 |
| 5 | `coupons.created_by` | hygiene | 管理者欄位，沒有現行 reverse lookup。 |
| 6 | `inventory_movements.actor_id` | hygiene | audit actor 反查低頻。 |
| 7 | `inventory_movements.order_id` | medium | order audit/summary 可能反查；先與實際 EXPLAIN 一起評估。 |
| 8 | `inventory_movements.variant_id` | medium | admin nested join 會用到；但目前 movement 只有 44 筆。 |
| 9 | `inventory_reservations.order_id` | hot | lifecycle release/update；選 open-order partial 或完整 FK index。 |
| 10 | `inventory_reservations.variant_id` | hot | available-stock aggregation；選 active-variant partial 或完整 FK index。 |
| 11 | `member_cart_items.variant_id` | hygiene | replace path 以 member_id delete；變體刪除／反查才需要。 |
| 12 | `order_items.variant_id` | hygiene | 現行主要是 order-first，已有 `(order_id, variant_id)`。 |
| 13 | `order_status_history.actor_id` | hygiene | admin history 顯示 actor，但表小且低頻。 |
| 14 | `orders.bank_account_id` | hygiene | bank account 小表、目前 orders 2 筆。 |
| 15 | `orders.coupon_id` | hygiene | coupon 由 order 反查的需求尚未形成 hot path。 |
| 16 | `point_ledger.actor_id` | hygiene | admin ledger actor alias；目前點數表僅 36 筆。 |
| 17 | `point_settings.updated_by` | hygiene | singleton 設定。 |
| 18 | `product_variants.product_id` | medium/hot candidate | 商品→規格 nested catalog；採 `(product_id, display_order)`。 |
| 19 | `products.category_id` | low/medium | category→products reverse join；目前只有 4 products。 |
| 20 | `shipping_settings_legacy.updated_by` | hygiene | legacy singleton。 |

Advisor 沒有列出的相似 FK 並非漏看：例如 `order_items.order_id` 已由 `(order_id, variant_id)` 的 leading column 覆蓋、`coupon_members.coupon_id` 與 `coupon_products.coupon_id` 已由各自 PK 覆蓋、`coupon_redemptions.order_id` 有 unique index、`orders.member_id` 已由 `orders_member_status_created_idx` 覆蓋。這也是不能只看到 FK 數量就無差別建立 20 個 index 的原因。

### 20-FK lint-complete alternative（僅草案，不要與上方等價 hot composite 同時套用）

若產品決策是「優先讓 Advisor 的 20 個 INFO 全部消失」，可考慮以下完整 FK index；這是**另一個方案**，不是本次建議一次全部執行。對 `coupon_members.member_id`、`inventory_reservations.order_id/variant_id`、`product_variants.product_id` 應以能服務 hot query 的 composite/full index 取代對應的 standalone index。

```sql
-- SQL 草案（不執行；逐項與 hot-path plan、index size、write rate 核對）。
create index birthday_coupon_settings_updated_by_idx on public.birthday_coupon_settings (updated_by);
create index coupon_members_member_id_idx on public.coupon_members (member_id);
create index coupon_products_product_id_idx on public.coupon_products (product_id);
create index coupon_redemptions_member_id_idx on public.coupon_redemptions (member_id);
create index coupons_created_by_idx on public.coupons (created_by);
create index inventory_movements_actor_id_idx on public.inventory_movements (actor_id);
create index inventory_movements_order_id_idx on public.inventory_movements (order_id);
create index inventory_movements_variant_id_idx on public.inventory_movements (variant_id);
create index inventory_reservations_order_id_idx on public.inventory_reservations (order_id);
create index inventory_reservations_variant_id_idx on public.inventory_reservations (variant_id);
create index member_cart_items_variant_id_idx on public.member_cart_items (variant_id);
create index order_items_variant_id_idx on public.order_items (variant_id);
create index order_status_history_actor_id_idx on public.order_status_history (actor_id);
create index orders_bank_account_id_idx on public.orders (bank_account_id);
create index orders_coupon_id_idx on public.orders (coupon_id);
create index point_ledger_actor_id_idx on public.point_ledger (actor_id);
create index point_settings_updated_by_idx on public.point_settings (updated_by);
create index product_variants_product_id_idx on public.product_variants (product_id);
create index products_category_id_idx on public.products (category_id);
create index shipping_settings_legacy_updated_by_idx on public.shipping_settings_legacy (updated_by);
```

實際 migration 應在選定方案後重新命名、加入 `if not exists`／部署流程所需的 lock 策略，並處理與已選 composite index 的重複；上方只是審查用 SQL 草稿。若使用 `CREATE INDEX CONCURRENTLY`，不能放在一般 transaction migration 中，需另行安排 deployment procedure。

## RLS initplan：4 個 finding

目前 `pg_policies` 讀值如下：

- `profiles.members view own profile`：`auth.uid() = id`
- `profiles.members update own profile`：`auth.uid() = id`，且 check 內有 `current_user_is_admin()`
- `orders.members view own orders`：`member_id = auth.uid()`
- `order_items.members view own order items`：EXISTS orders，內層 `o.member_id = auth.uid()`

這四個 policy 都把不依 row 改變的 identity function 直接放在 policy expression，Advisor 因而報 `auth_rls_initplan`。Supabase 的 RLS performance guidance 建議用 `(select auth.uid())`，讓 planner 把它變成每 statement 一次的 initplan；同時要保留現有 ownership predicate 與 UPDATE 的 `WITH CHECK`。

**SQL 草案（不執行；需在 authenticated allow/deny 測試後套用）**：

```sql
alter policy "members view own profile" on public.profiles
  using ((select auth.uid()) = id);

alter policy "members update own profile" on public.profiles
  using ((select auth.uid()) = id)
  with check (
    (select auth.uid()) = id
    and is_admin = (select public.current_user_is_admin())
  );

alter policy "members view own orders" on public.orders
  using (member_id = (select auth.uid()));

alter policy "members view own order items" on public.order_items
  using (
    exists (
      select 1
      from public.orders o
      where o.id = order_items.order_id
        and o.member_id = (select auth.uid())
    )
  );
```

這不是 index replacement：`order_items.order_id` 的 order-first key、`orders.member_id` 的 existing composite index 仍需保留。Policy 修改後應驗證：本人可讀、他人不可讀、本人只能更新允許欄位，且不可變更 `is_admin`。

## Duplicate permissive policy：`member_cart_items`

目前有兩個 authenticated、PERMISSIVE、SELECT-effective policy：

- `members manage own cart`：`FOR ALL`，`(select auth.uid()) = member_id`
- `members view own cart`：`FOR SELECT`，相同 predicate

Postgres permissive policies 會 OR 合併；這裡兩個 predicate 相同，不會擴大權限，但 SELECT 會多評估一份相同 policy。因為 `FOR ALL` 已經包含 SELECT，最小行為改動是只移除重複的 view policy。

**SQL 草案（不執行）**：

```sql
drop policy if exists "members view own cart" on public.member_cart_items;
```

不要同時刪除 `members manage own cart`；它仍負責 authenticated 的 INSERT/UPDATE/DELETE 與 SELECT。若未來要細分最小權限，應另行設計三個 non-SELECT policy 並做完整 CRUD/RLS 測試，不要在這次 index audit 中順便改語意。

## EXPLAIN 驗收方式（未執行）

每個候選都要以「加 index 前／後、相同資料 snapshot、相同 bind values」比較。因為目前多數 table 只有 0–4 筆，planner 選 Seq Scan 是合理的；應在 staging/branch 用接近成長後的資料量驗收，而不是用 `enable_seqscan=off` 當 production 證據。

### 1. Expired orders

`cancel_expired_orders()` 會更新資料，不要在 production 直接對函式使用 `EXPLAIN ANALYZE`。先對其 candidate SELECT 做 plan-only：

```sql
explain (buffers, format text)
select o.id, o.status
from public.orders o
where o.status in ('pending_payment', 'pending_review')
  and o.payment_deadline <= current_timestamp
for update skip locked;
```

驗收：規模足夠且 expired rows 稀疏時，期待 `Index Scan`／`Bitmap Index Scan` 使用 `orders_pending_deadline_idx`，避免全表 Seq Scan；`FOR UPDATE SKIP LOCKED` 的 lock semantics 不得改變。若只有 2 筆仍是 Seq Scan，記錄為 planner 的合理選擇即可。

### 2. Reservations

```sql
explain (buffers, format text)
select coalesce(sum(r.quantity) filter (where r.released_at is null and r.expires_at > current_timestamp), 0)
from public.inventory_reservations r
where r.variant_id = '<variant-uuid>'::uuid;

explain (buffers, format text)
update public.inventory_reservations r
set released_at = current_timestamp
where r.order_id = '<order-uuid>'::uuid
  and r.released_at is null;
```

在 disposable/staging branch 才可用 `EXPLAIN (ANALYZE, BUFFERS)` 觀察 actual rows；production 對 update 只先 plan-only。驗收要同時確認 active partial predicate 命中、released row 不被誤選、寫入 lock scope 沒變寬。

### 3. Catalog／coupon／movement paths

```sql
explain (buffers, format text)
select p.id, v.id, v.display_order
from public.products p
join public.product_variants v on v.product_id = p.id
where p.id = '<product-uuid>'::uuid
order by v.display_order;

explain (buffers, format text)
select c.id, c.valid_until
from public.coupons c
join public.coupon_members cm on cm.coupon_id = c.id
where cm.member_id = '<member-uuid>'::uuid
  and c.is_active
  and current_timestamp between c.valid_from and c.valid_until
order by c.valid_until;

explain (buffers, format text)
select id, variant_id, kind, quantity_delta, reason, created_at
from public.inventory_movements
order by created_at desc
limit 50;
```

驗收：商品 nested path 應可用 `product_variants_product_display_idx`；會員優惠券應可用 `(member_id, coupon_id)`；movement newest-50 應沒有大表 Sort，且使用 `inventory_movements_created_at_idx` 的 bounded scan。coupon redemption 的 total/per-member count 要確認仍使用既有 `(coupon_id, member_id)`，不應因新增 member-first index 取代錯誤方向。

### 4. RLS／Advisor regression

以 authenticated session 分別跑本人與他人 UUID 的 SELECT/UPDATE `EXPLAIN (ANALYZE, BUFFERS)`（只在可丟棄 branch 或安全測試資料），確認 plan 出現 identity function 的 initplan／statement-level evaluation，並比較 execution time、rows removed、shared buffers。修改後重新讀取 Performance Advisor：預期 `auth_rls_initplan` 4 findings 消失；若使用 partial 而非完整 FK index，`unindexed_foreign_keys` 仍可能保留是預期結果。

## 風險與套用前檢查

- 每個 index 都會增加 insert/update/delete 的 WAL、CPU、storage；`inventory_movements` 是 append-heavy，reservation/status 更新也會使 partial index rows 進出 predicate。不要因 INFO lint 一次建立全部 20 個。
- Partial index predicate 必須是 immutable、且能被實際 query 推導；不能把 `payment_deadline <= now()` 放進 index predicate，所以草案只用穩定的 status/released_at 條件，把時間欄位作為 key。
- `(order_id, variant_id)`、`(coupon_id, member_id)` 等 existing composite keys 已涵蓋 order/coupon-first path；建立相同順序的重複 index 只增加寫入成本。
- RLS policy 不是純 performance refactor：`WITH CHECK`、`is_admin` guard、authenticated/anon grants 都要保留。duplicate policy 只刪除重複 SELECT policy。
- `CREATE INDEX CONCURRENTLY` 不能放在一般 transaction migration；正式 migration 需要先決定 lock window、失敗清理與命名，再由有授權的部署流程執行。
- 目前部分 table 的 `last_analyze` 為 null、`n_live_tup`/`reltuples` 仍可能是近似值；若之後需要容量決策，先安排正常的 stats/vacuum maintenance，再比較 `pg_stat_statements` delta，不在本 audit 內執行。

## 建議實施順序（下一個有授權的變更窗口）

1. 先不碰低資料量的 20-FK 全量方案；在 staging/branch 以成長資料做 expired-order、reservation、movement、product nested、member coupon 的 EXPLAIN baseline。
2. 若 cleanup plan 顯示全表 scan，先套 `orders_pending_deadline_idx`；若 reservation lifecycle/stock plan 顯示 scan，再從兩個 reservation partial 與完整 FK index 中擇一，避免重複。
3. 目錄／movement／coupon 真實 query 成長後，優先套用 `product_variants_product_display_idx`、`inventory_movements_created_at_idx`、`coupon_members_member_coupon_idx` 中被 EXPLAIN 證明的項目。
4. 另開小 migration 處理 4 個 RLS initplan 與 cart duplicate policy，做 allow/deny regression 後再重跑 Performance Advisor。
5. 僅在 FK lint=0 是明確 acceptance criterion 時，才逐項從 20-FK alternative block 補齊其餘 hygiene indexes，並每批記錄 index size、write overhead 與 Advisor 結果。
