# Migration 紀錄對齊（2026-09-24）

正式專案 `csiviervpnxdzyfcuamm` 的 `supabase_migrations.schema_migrations` 原本與 `supabase/migrations/` 對不起來：
44 列以 Supabase MCP／Dashboard 套用當下的 14 碼時間戳為版本，19 支早期以 SQL Editor 貼上的 migration 完全沒有紀錄。
本次將紀錄改成與檔名一一對應（12 碼版本），之後可用 `npm run db:history-sql` 直接比對。

## 對齊前的唯讀稽核

1. **內容比對**：44 列紀錄的 `statements` 與 repo 檔案內容比對（去頭尾空白後 md5），36 列完全相同；8 列不同，逐行比對後皆不影響功能（見下表「內容比對」欄）。
2. **結構指紋**：本機以 PostgreSQL 16 從零套用全部 63 支 migration，與正式 DB 比對 `public`／`private` 的欄位、約束、索引、view、trigger、RLS policy、table／column／function 權限、enum、pg_cron 排程與 storage bucket，逐類 md5 **全部相同**（29 張表欄位、154 個約束、72 個索引、28 個 policy、14 個 trigger）。
3. **函式本體**：60 支函式的屬性（security definer、search_path、volatility、回傳型別）與 EXECUTE 權限全部相同；本體有 12 支不同：
   - 9 支只差換行字元：正式 DB 的本體是 CRLF（當初從 Windows 貼到 SQL Editor），repo 是 LF。
   - `apply_points_from_order_history`、`private.protect_profile_identity_fields` 只差 2 行註解。
   - `calculate_shipping_fee`：正式 DB 為 `select 0`，repo 版本會先檢查配送方式、不合法時丟 `INVALID_DELIVERY_METHOD`。唯一呼叫者 `create_delivery_order`（8 參數核心）在呼叫前已做同樣檢查，實務上無法觸發差異；移除運費相容函式時一併處理即可。
4. 結論：19 支無紀錄的 migration 效果皆已存在於正式 DB，正式 DB 沒有 repo 以外的結構變更。

## 對齊內容

- 44 列：`version` 由時間戳改為檔名版本（`npm run db:history-sql -- align` 產生的 SQL，以名稱對應）；`statements`、`name`、`created_by` 不變。對齊後 44 列 `statements` 的指紋與對齊前相同。
- 19 列：新增 `version`＋`name`，`statements` 留空（無法得知當時實際貼上的內容，不以 repo 檔案冒充）：
  `202609080001_initial_schema`、`202609090001_patch_after_initial_schema`、`202609100001_order_payment_flow`、`202609100002_admin_catalog_management`、`202609100003_admin_order_management`、`202609100004_member_points`、`202609100005_product_images`、`202609100006_discounts`、`202609100007_line_notifications`、`202609110001_admin_order_completion`、`202609110002_delivery_methods`、`202609110003_remove_shipping_calculation`、`202609110004_store_payment`、`202609110005_final_payment_workflow`、`202609110006_harden_function_privileges`、`202609110007_storefront_product_details`、`202609110008_purchase_limit_management`、`202609120001_delivery_recipient_fields`、`202609140004_no_mfa_identity_guard`。
- 整筆在單一交易內執行，結尾檢查總數 63、全部 12 碼版本、名稱不重複，否則回滾。
- 對齊後正式 DB 執行 `npm run db:history-sql` 的唯讀 SQL 回傳 0 列；`verify_schema.sql` 104 項全部為 true（含新增的 `migration_history_uses_repo_versions`）。

## 版本對照（44 列）

| 新版本（檔名） | 舊版本（套用時間戳） | 名稱 | 內容比對 |
| --- | --- | --- | --- |
| `202609120002` | `20260912114632` | `seller_delivery_no_shipping_fee` | 相同 |
| `202609120003` | `20260912122444` | `seller_delivery_external_only` | 相同 |
| `202609130001` | `20260912160236` | `allow_verified_seller_delivery_orders` | 註解與 `comment on function` 說明文字（後續 migration 已覆寫該說明） |
| `202609130002` | `20260912160539` | `seller_delivery_completion` | 相同 |
| `202609140001` | `20260913192258` | `security_hardening` | 相同 |
| `202609140002` | `20260913193017` | `public_catalog_security` | 相同 |
| `202609140003` | `20260914024736` | `explicit_deny_policies` | 相同 |
| `202609140005` | `20260914060824` | `product_images_webp` | 相同 |
| `202609140006` | `20260914110719` | `bank_transfer_only_store_pickup` | 相同 |
| `202609150001` | `20260914182202` | `preorder_payment_deadline` | 註解 |
| `202609150002` | `20260914185901` | `preorder_seller_delivery_bank_transfer` | 相同 |
| `202609150003` | `20260914190842` | `split_mixed_order_guard` | 相同 |
| `202609150004` | `20260914192123` | `single_order_pickup_plan` | 相同 |
| `202609150005` | `20260914195209` | `member_cart_sync` | 相同 |
| `202609150006` | `20260914195350` | `member_cart_replace_rpc` | 相同 |
| `202609150007` | `20260915025517` | `telegram_notification_logs` | 相同 |
| `202609150008` | `20260915032436` | `telegram_notification_deny_policy` | 相同 |
| `202609150009` | `20260915044429` | `product_images_original_fallback` | 檔頭註解 |
| `202609150010` | `20260915052338` | `category_management` | 檔頭註解 |
| `202609180001` | `20260918091924` | `phase7_expired_orders_cron_frequency` | 相同 |
| `202609180002` | `20260918091949` | `phase8_hot_path_indexes` | 相同 |
| `202609180003` | `20260918092017` | `phase9_rls_initplan` | 相同 |
| `202609180004` | `20260918092046` | `phase10_revoke_legacy_delivery_rpc` | 相同 |
| `202609190001` | `20260919143807` | `instock_home_fulfillment_at_confirmed` | 相同 |
| `202609200001` | `20260919174600` | `home_fulfillment_in_pending_review` | 相同 |
| `202609200002` | `20260919191417` | `product_points_eligibility` | 註解 |
| `202609200003` | `20260919191516` | `product_points_admin_acl` | 相同 |
| `202609200004` | `20260920075443` | `storefront_points_eligibility` | 相同 |
| `202609200005` | `20260920090148` | `variant_compare_at_price` | 相同 |
| `202609210001` | `20260920180747` | `points_reversal_refund_and_cancel_repair` | 註解與同一段 `not exists` 換行排版 |
| `202609220001` | `20260922132038` | `member_point_balance_rpc` | 相同 |
| `202609220002` | `20260922132051` | `notification_delivery_state_machine` | 相同 |
| `202609220003` | `20260922132106` | `inventory_cancellation_returns` | 相同 |
| `202609220004` | `20260922132122` | `audit_logs_admin_search` | 相同 |
| `202609220005` | `20260922132139` | `audit_existing_admin_rpcs` | 相同 |
| `202609220006` | `20260922132153` | `admin_catalog_coupon_inventory_search` | 相同 |
| `202609220007` | `20260922132947` | `notification_claim_found_fix` | 相同 |
| `202609230001` | `20260922164240` | `notification_operations` | 相同 |
| `202609230002` | `20260922171054` | `notification_display_context` | 相同 |
| `202609230003` | `20260923111528` | `liff_session_vault` | repo 檔多 `begin;`／`commit;` |
| `202609240001` | `20260923145715` | `product_gallery_showcase` | repo 檔多 `begin;`／`commit;` |
| `202609250001` | `20260924142713` | `cancellation_notification_marker` | 相同 |
| `202609250002` | `20260924175913` | `catalog_column_grants` | 相同 |
| `202609250003` | `20260924181114` | `drop_legacy_rpcs` | 相同 |

若需還原，依此表以名稱把 `version` 改回舊值，並刪除上列 19 列。
