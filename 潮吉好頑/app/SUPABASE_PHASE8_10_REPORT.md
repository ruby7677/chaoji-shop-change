# Supabase Phase 8–10 Review

本輪新增的三個 migration 已套用遠端資料庫；尚未部署本輪 Phase 8–10 相關 Worker 變更（本輪沒有新增 Worker 程式碼）。

## Phase 8：Hot-path indexes

新增 `202609180002_phase8_hot_path_indexes.sql`：

- `orders_pending_deadline_idx`：對應逾期訂單 `status + payment_deadline`。
- `inventory_reservations_order_active_idx`：對應依 `order_id` 更新未釋放 reservation。
- `inventory_reservations_variant_active_expiry_idx`：對應依 `variant_id` 聚合未釋放／未過期 reservation。
- `order_items_variant_idx`、`product_variants_product_idx`、`products_category_idx`：對應規格、商品與分類 join。
- `coupon_members_member_idx`、`coupon_products_product_idx`、`coupon_redemptions_member_idx`：對應會員優惠券、商品限定與會員 redemption 查詢。
- `inventory_movements_created_idx`：對應後台最近異動 `ORDER BY created_at DESC LIMIT 50`。

未加入低證據或重複索引：其他 Advisor FK hygiene 項目、已存在的主鍵／唯一鍵與目前沒有實際 hot path 的欄位，留待資料量成長與 EXPLAIN 驗證。

## Phase 9：RLS／policy performance

新增 `202609180003_phase9_rls_initplan.sql`：

- 四個 Advisor 指出的 `auth.uid()` policy 改成 `(select auth.uid())`。
- 移除 `member_cart_items` 重複 SELECT policy；保留相同 predicate 的 `members manage own cart` ALL policy。
- 角色範圍、會員歸屬、管理員欄位檢查未改寫成較寬鬆條件。

## Phase 10：SECURITY DEFINER

新增 `202609180004_phase10_revoke_legacy_delivery_rpc.sql`：

- 撤銷 authenticated 對舊版 8 參數 `create_delivery_order` overload 的 EXECUTE。
- 現行 Worker 使用的 10 參數版本保留 authenticated EXECUTE。
- `current_user_is_admin`、`member_available_coupons`、`submit_order_payment` 與現行下單 RPC 未撤銷，因仍由現行 policy／Worker call path 使用。
- 既有 SECURITY DEFINER 函式的固定 `search_path` 不在本輪重寫。

## 套用後 Advisor 結果

- `auth_rls_initplan`：由 4 筆降為 0。
- `multiple_permissive_policies`：由 1 筆降為 0。
- `unindexed_foreign_keys`：由 20 筆降為 12 筆；保留項目多為低頻／非本輪 hot path 的 FK。
- `authenticated_security_definer_function_executable`：由 5 筆降為 4 筆；現行下單、付款、會員優惠券與 admin policy call path 保留 authenticated EXECUTE。
- 新增 index 目前出現 unused INFO 是預期結果，因資料量小且統計尚未累積；不刪除已確認 hot-path index。

## 已完成的安全唯讀驗證與剩餘限制

- 遠端 migration、cron job、RLS policy、Advisor 與 SECURITY DEFINER ACL 已完成唯讀核對。
- 公開 health/config/catalog／圖片 smoke 與通知分流 deterministic test 已完成。
- Phase 11–12 的固定低流量 pg_stat before／after delta 已完成；完整數值見 `SUPABASE_PHASE11_12_REPORT.md`。
- RLS 允許／拒絕角色矩陣、inventory concurrency、first-bind identity write、交易／通知副作用與圖片失效寫入測試仍需隔離 fixture 與額外授權，因此本輪沒有建立訂單、付款、庫存 reservation、通知或真實交易資料。
