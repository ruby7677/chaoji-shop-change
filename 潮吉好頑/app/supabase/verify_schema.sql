-- 唯讀驗證：應全部回傳 true。
select
  to_regclass('public.profiles') is not null as profiles_exists,
  to_regclass('public.storefront_variants') is not null as storefront_view_exists,
  -- 202609250003_drop_legacy_rpcs：舊下單 RPC 與 admin_create_product 舊 overload 已移除。
  to_regprocedure('public.create_pending_order(jsonb,text,integer,integer,uuid,text)') is null as legacy_create_pending_order_removed,
  to_regprocedure('public.handle_new_auth_user()') is not null as auth_profile_function_exists,
  to_regprocedure('public.submit_order_payment(uuid,uuid,text)') is not null as submit_payment_rpc_exists,
  to_regprocedure('public.cancel_expired_orders()') is not null as cancel_expired_orders_exists,
  (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_create_product') as admin_create_product_single_overload,
  to_regprocedure('public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer)') is not null as admin_create_product_latest_exists,
  to_regprocedure('public.admin_adjust_inventory(uuid,uuid,integer,text)') is not null as admin_adjust_inventory_exists,
  to_regclass('public.order_status_history') is not null as order_status_history_exists,
  to_regprocedure('public.admin_transition_order(uuid,uuid,public.order_status,text)') is not null as admin_transition_order_exists,
  to_regprocedure('public.sync_order_confirmation_timestamp()') is not null as order_confirmation_timestamp_trigger_exists,
  to_regclass('public.point_settings') is not null as point_settings_exists,
  to_regclass('public.admin_member_summary') is not null as admin_member_summary_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'image_path'
  ) as product_image_column_exists,
  exists (
    select 1
    from storage.buckets
    where id = 'product-images'
      and public = false
  ) as private_product_image_bucket_exists,
  exists (
    select 1
    from storage.buckets
    where id = 'product-images'
      and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']::text[]
  ) as product_image_formats_enabled,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'categories'
      and column_name = 'is_active'
  ) as category_active_column_exists,
  to_regprocedure('public.admin_update_point_settings(uuid,integer,integer,integer,text,integer)') is not null as admin_update_point_settings_exists,
  to_regprocedure('public.admin_adjust_member_points(uuid,uuid,integer,text)') is not null as admin_adjust_member_points_exists,
  to_regclass('public.coupons') is not null as coupons_exists,
  to_regclass('public.coupon_redemptions') is not null as coupon_redemptions_exists,
  to_regclass('public.birthday_coupon_settings') is not null as birthday_coupon_settings_exists,
  to_regprocedure('public.create_discounted_order(jsonb,text,text,integer,uuid,text)') is null as legacy_create_discounted_order_removed,
  to_regprocedure('public.create_delivery_order(jsonb,text,text,text,integer,uuid,text,text,text,text)') is not null as delivery_order_rpc_exists,
  -- 8 參數版是 10 參數版呼叫的核心實作：必須存在，且只有 service_role 可直接執行。
  coalesce((
    select not has_function_privilege('anon', fn, 'EXECUTE')
       and not has_function_privilege('authenticated', fn, 'EXECUTE')
    from (select to_regprocedure('public.create_delivery_order(jsonb,text,text,text,integer,uuid,text,text)') as fn) f
    where fn is not null
  ), false) as delivery_order_core_exists_and_blocked_for_api_roles,
  -- 202609250006_taipei_order_number：訂單編號以台灣時間產生。
  coalesce((
    select 'TimeZone=Asia/Taipei' = any(proconfig) and 'search_path=""' = any(proconfig)
    from pg_proc where oid = to_regprocedure('public.create_delivery_order(jsonb,text,text,text,integer,uuid,text,text)')
  ), false) as delivery_order_number_uses_taipei_time,
  to_regprocedure('public.admin_update_order_fulfillment(uuid,uuid,integer,boolean,text,text)') is not null as final_payment_workflow_rpc_exists,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_variants'
      and column_name in ('product_name', 'description', 'variant_name', 'purchase_limit')
    group by table_schema, table_name
    having count(*) = 4
  ) as storefront_product_detail_columns_exist,
  to_regprocedure('public.calculate_shipping_fee(text,integer)') is not null as shipping_fee_compatibility_function_exists,
  to_regprocedure('public.admin_update_shipping_settings(uuid,integer,integer,integer,integer,integer)') is null as admin_shipping_settings_removed,
  to_regclass('public.shipping_settings') is null as shipping_settings_removed,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_variants' and column_name = 'shipping_units'
  ) as variant_shipping_units_exists,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name in ('delivery_method', 'shipping_fee', 'shipping_address')
    group by table_schema, table_name
    having count(*) = 3
  ) as order_delivery_columns_exist,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders'
      and column_name in ('shipping_fee_notified_at', 'final_payment_last_five', 'final_payment_confirmed_at')
    group by table_schema, table_name
    having count(*) = 3
  ) as final_payment_columns_exist,
  to_regprocedure('public.admin_save_coupon(uuid,uuid,text,text,integer,boolean,timestamp with time zone,timestamp with time zone,integer,integer,boolean,uuid[],uuid[])') is not null as admin_save_coupon_exists,
  to_regprocedure('public.issue_birthday_coupons()') is not null as issue_birthday_coupons_exists,
  -- 202609250004_unify_notification_deliveries：LINE／Telegram 通知紀錄合併為單表，函式改為靜態 SQL。
  to_regclass('public.notification_deliveries') is not null as notification_deliveries_exists,
  to_regclass('public.line_notification_logs') is null and to_regclass('public.telegram_notification_logs') is null as legacy_notification_log_tables_removed,
  to_regprocedure('public.member_point_balance()') is not null as member_point_balance_rpc_exists,
  to_regprocedure('public.claim_notification_delivery(text,text,text,text,jsonb,integer)') is not null as notification_claim_rpc_exists,
  to_regprocedure('public.claim_due_notification_deliveries(text,integer,integer)') is not null as notification_due_claim_rpc_exists,
  to_regprocedure('public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer)') is not null as notification_complete_rpc_exists,
  exists (
    select 1
    from pg_proc p
    where p.oid = to_regprocedure('public.claim_notification_delivery(text,text,text,text,jsonb,integer)')
      and pg_get_functiondef(p.oid) ilike '%get diagnostics v_updated = row_count%'
  ) as notification_claim_row_count_fix_exists,
  exists (
    select 1
    from pg_proc p
    where p.oid = to_regprocedure('public.admin_list_notification_deliveries(uuid,text,text,integer,integer)')
      and pg_get_functiondef(p.oid) ilike '%recipient_name%'
      and pg_get_functiondef(p.oid) ilike '%order_number%'
  ) as notification_display_context_exists,
  exists (
    select 1
    from pg_constraint
    where conrelid = to_regclass('public.notification_deliveries')
      and conname = 'notification_deliveries_channel_event_recipient_key'
      and pg_get_constraintdef(oid) = 'UNIQUE (channel, event_key, recipient_id)'
  ) as notification_deliveries_unique_per_channel_event_recipient,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'notification_deliveries' and column_name = 'claim_token'
  ) as notification_claim_token_column_exists,
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.notification_deliveries')), false) as notification_deliveries_rls_enabled,
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notification_deliveries' and policyname = 'deny api roles'
  ) as notification_deliveries_deny_policy_exists,
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where to_regclass('public.notification_deliveries') is null
       or has_table_privilege(r.role_name, 'public.notification_deliveries', p.privilege)
  ) as notification_deliveries_api_roles_blocked,
  -- 通知函式不再以動態 SQL 切換表名，建立時即檢查欄位。
  not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('claim_notification_delivery', 'claim_due_notification_deliveries', 'complete_notification_delivery',
                        'admin_list_notification_deliveries', 'admin_requeue_notification_delivery', 'purge_notification_deliveries')
      and p.prosrc ~* 'execute\s+format'
  ) as notification_functions_use_static_sql,
  coalesce((
    select not has_function_privilege('anon', fn, 'EXECUTE')
       and not has_function_privilege('authenticated', fn, 'EXECUTE')
       and not has_function_privilege('service_role', fn, 'EXECUTE')
    from (select to_regprocedure('public.purge_notification_deliveries(integer)') as fn) f
    where fn is not null
  ), false) as notification_purge_exists_and_blocked_for_api_roles,
  exists (
    select 1 from cron.job
    where jobname = 'chaoji-purge-notification-deliveries' and command = 'select public.purge_notification_deliveries();'
  ) as notification_purge_cron_exists,
  to_regclass('public.line_low_stock_states') is not null as line_low_stock_states_exists,
  to_regclass('public.inventory_return_confirmations') is not null as inventory_return_confirmations_exists,
  to_regprocedure('public.admin_confirm_order_return(uuid,uuid,integer,integer,integer,text)') is not null as admin_confirm_order_return_exists,
  to_regprocedure('public.admin_dashboard_stats(uuid)') is not null as admin_dashboard_stats_exists,
  -- 202609250007_unified_low_stock：低庫存唯一定義，後台統計共用。
  coalesce((
    select has_function_privilege('service_role', fn, 'EXECUTE')
       and not has_function_privilege('anon', fn, 'EXECUTE')
       and not has_function_privilege('authenticated', fn, 'EXECUTE')
    from (select to_regprocedure('public.low_stock_variants(integer)') as fn) f
    where fn is not null
  ), false) as low_stock_variants_exists_for_service_role_only,
  exists (
    select 1 from pg_proc
    where oid = to_regprocedure('public.admin_dashboard_stats(uuid)') and prosrc like '%public.low_stock_variants()%'
  ) as dashboard_low_stock_uses_shared_definition,
  to_regclass('public.audit_logs') is not null as audit_logs_exists,
  to_regprocedure('public.append_audit_log(uuid,text,text,text,jsonb,jsonb)') is not null as append_audit_log_exists,
  to_regprocedure('public.admin_search_order_ids(uuid,text,text,integer,integer)') is not null as admin_search_order_ids_exists,
  to_regprocedure('public.admin_search_member_ids(uuid,text,integer,integer)') is not null as admin_search_member_ids_exists,
  to_regprocedure('public.admin_create_bank_account(uuid,text,text,text,text,boolean,integer)') is not null as admin_create_bank_account_exists,
  to_regprocedure('public.admin_update_bank_account(uuid,uuid,text,text,text,text,boolean,integer)') is not null as admin_update_bank_account_exists,
  to_regprocedure('public.admin_create_category(uuid,text,integer,boolean)') is not null as admin_create_category_exists,
  to_regprocedure('public.admin_update_category(uuid,uuid,text,integer,boolean)') is not null as admin_update_category_exists,
  to_regprocedure('public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer)') is not null as admin_create_variant_exists,
  to_regprocedure('public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer)') is not null as admin_update_variant_exists,
  to_regprocedure('public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer)') is not null as admin_update_product_exists,
  to_regprocedure('public.admin_update_product_image(uuid,uuid,text,timestamp with time zone)') is not null as admin_update_product_image_exists,
  to_regprocedure('public.admin_search_product_ids(uuid,text,text,integer,integer)') is not null as admin_search_product_ids_exists,
  to_regprocedure('public.admin_search_coupon_ids(uuid,text,integer,integer)') is not null as admin_search_coupon_ids_exists,
  to_regprocedure('public.admin_search_inventory_movement_ids(uuid,uuid,integer,integer)') is not null as admin_search_inventory_movement_ids_exists,
  to_regprocedure('public.admin_management_options(uuid)') is not null as admin_management_options_exists,
  to_regprocedure('public.admin_list_notification_deliveries(uuid,text,text,integer,integer)') is not null as admin_list_notification_deliveries_exists,
  to_regprocedure('public.admin_requeue_notification_delivery(uuid,text,uuid)') is not null as admin_requeue_notification_delivery_exists,
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname in ('audit_logs_action_check', 'audit_logs_resource_check')
      and pg_get_constraintdef(oid) like '%retry%'
  ) as audit_logs_notification_retry_constraint_exists,
  exists (select 1 from pg_trigger where tgname = 'audit_logs_immutable' and not tgisinternal) as audit_logs_immutable_trigger_exists,
  exists (select 1 from pg_trigger where tgname = 'audit_logs_immutable_truncate' and not tgisinternal) as audit_logs_immutable_truncate_trigger_exists,
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'deny api roles') as audit_logs_deny_policy_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public' and table_name = 'inventory_movements'
      and column_name in ('source_movement_id', 'return_confirmation_id')
    group by table_schema, table_name
    having count(*) = 2
  ) as inventory_return_link_columns_exist,
  exists (
    select 1
    from pg_trigger
    where tgname = 'create_profile_after_signup'
      and not tgisinternal
  ) as auth_profile_trigger_exists,
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'members update own profile'
  ) as profile_update_policy_exists,
  exists (
    select 1
    from cron.job
    where jobname = 'chaoji-release-expired-orders'
  ) as expired_order_cron_exists,
  exists (
    select 1
    from cron.job
    where jobname = 'chaoji-issue-birthday-coupons'
  ) as birthday_coupon_cron_exists,
  exists (
    select 1
    from pg_trigger
    where tgname = 'sync_reservations_after_order_status'
      and not tgisinternal
  ) as order_reservation_trigger_exists,
  exists (
    select 1
    from pg_trigger
    where tgname = 'apply_points_after_order_transition'
      and not tgisinternal
  ) as automatic_points_trigger_exists,
  exists (
    select 1
    from pg_trigger
    where tgname = 'reject_unverified_order_discounts'
      and not tgisinternal
  ) as unverified_discount_guard_exists,
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'cancellation_notified_at'
  ) as cancellation_notification_marker_exists,
  to_regclass('public.orders_cancellation_notification_pending_idx') is not null as cancellation_notification_pending_index_exists,
  -- 202609230003_liff_session_vault：僅 service_role 可讀寫加密 refresh token。
  to_regclass('public.liff_session_vault') is not null as liff_session_vault_exists,
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.liff_session_vault')), false) as liff_session_vault_rls_enabled,
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'liff_session_vault' and policyname = 'deny api roles'
  ) as liff_session_vault_deny_policy_exists,
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where to_regclass('public.liff_session_vault') is null
       or has_table_privilege(r.role_name, 'public.liff_session_vault', p.privilege)
  ) as liff_session_vault_api_roles_blocked,
  to_regclass('public.liff_session_vault_user_id_idx') is not null as liff_session_vault_user_index_exists,
  -- 202609240001_product_gallery_showcase：商品多圖、商品頁介紹與 Hero 輪播。
  (
    select count(*) = 3
    from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name in ('details', 'hero_rank', 'hero_tagline')
  ) as product_showcase_columns_exist,
  (
    select count(*) = 3
    from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname in ('products_details_length_check', 'products_hero_rank_check', 'products_hero_tagline_length_check')
  ) as product_showcase_constraints_exist,
  to_regclass('public.product_images') is not null as product_images_exists,
  coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.product_images')), false) as product_images_rls_enabled,
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'product_images' and policyname = 'deny api roles'
  ) as product_images_deny_policy_exists,
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege)
    where to_regclass('public.product_images') is null
       or has_table_privilege(r.role_name, 'public.product_images', p.privilege)
  ) as product_images_api_roles_blocked,
  exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.product_images')
      and conname = 'product_images_product_sort_key'
      and condeferrable and condeferred
  ) as product_images_sort_key_deferred,
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.audit_logs'::regclass
      and conname = 'audit_logs_action_check'
      and pg_get_constraintdef(oid) like '%''retry''%'
      and pg_get_constraintdef(oid) like '%''delete''%'
  ) as audit_logs_action_allows_retry_and_delete,
  (
    select count(*) = 6
      and bool_and(fn is not null)
      and bool_and(fn is null or not has_function_privilege('anon', fn, 'EXECUTE'))
      and bool_and(fn is null or not has_function_privilege('authenticated', fn, 'EXECUTE'))
    from (values
      (to_regprocedure('private.sync_product_primary_image(uuid)')),
      (to_regprocedure('public.admin_update_product_image(uuid,uuid,text,timestamptz)')),
      (to_regprocedure('public.admin_add_product_image(uuid,uuid,uuid,text,integer,integer,text)')),
      (to_regprocedure('public.admin_reorder_product_images(uuid,uuid,uuid[])')),
      (to_regprocedure('public.admin_delete_product_image(uuid,uuid,uuid)')),
      (to_regprocedure('public.admin_update_product_showcase(uuid,uuid,text,integer,text)'))
    ) f(fn)
  ) as product_gallery_rpcs_exist_and_blocked_for_api_roles,
  (
    select bool_and(fn is not null and has_function_privilege('service_role', fn, 'EXECUTE'))
    from (values
      (to_regprocedure('public.admin_update_product_image(uuid,uuid,text,timestamptz)')),
      (to_regprocedure('public.admin_add_product_image(uuid,uuid,uuid,text,integer,integer,text)')),
      (to_regprocedure('public.admin_reorder_product_images(uuid,uuid,uuid[])')),
      (to_regprocedure('public.admin_delete_product_image(uuid,uuid,uuid)')),
      (to_regprocedure('public.admin_update_product_showcase(uuid,uuid,text,integer,text)'))
    ) f(fn)
  ) as product_gallery_rpcs_service_role_executable,
  (
    select count(*) = 2
    from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_variants'
      and column_name in ('hero_rank', 'hero_tagline')
  ) as storefront_hero_columns_exist,
  coalesce((
    select 'security_invoker=true' = any(reloptions)
    from pg_class where oid = 'public.storefront_variants'::regclass
  ), false) as storefront_view_security_invoker,
  -- 202609250002_catalog_column_grants：型錄底層表只授權前台 view 用到的欄位，成本與庫存不公開。
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('public.categories'), ('public.products'), ('public.product_variants')) t(table_name)
    where has_table_privilege(r.role_name, t.table_name, 'SELECT')
  ) as catalog_tables_have_no_table_level_select,
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('cost'), ('sku'), ('safety_stock'), ('stock_on_hand'), ('deposit_rate')) c(column_name)
    where has_column_privilege(r.role_name, 'public.product_variants', c.column_name, 'SELECT')
  ) as variant_private_columns_hidden_from_api_roles,
  has_table_privilege('anon', 'public.storefront_variants', 'SELECT') as storefront_view_readable_by_anon,
  -- 202609250005_member_point_ledger_rls：會員以 JWT 讀本人點數紀錄，actor_id 不公開。
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'point_ledger' and policyname = 'members view own point ledger'
      and cmd = 'SELECT' and roles = '{authenticated}'
  ) as point_ledger_member_select_policy_exists,
  has_column_privilege('authenticated', 'public.point_ledger', 'points', 'SELECT')
    and not has_column_privilege('authenticated', 'public.point_ledger', 'actor_id', 'SELECT')
    and not has_table_privilege('authenticated', 'public.point_ledger', 'INSERT')
    and not has_table_privilege('anon', 'public.point_ledger', 'SELECT') as point_ledger_member_columns_only,
  -- migration 紀錄使用 repo 檔名的 12 碼版本；Supabase MCP／Dashboard 套用後會留下 14 碼時間戳，
  -- 需以 npm run db:history-sql -- align 改回檔名版本。
  not exists (
    select 1 from supabase_migrations.schema_migrations where version !~ '^[0-9]{12}$'
  ) as migration_history_uses_repo_versions,
  -- 資料一致性：products.image_path 必須等於多圖排序第一張。
  to_regclass('public.product_images') is not null and not exists (
    select 1
    from public.products p
    where p.image_path is distinct from (
      select i.storage_path from public.product_images i
      where i.product_id = p.id
      order by i.sort_order, i.created_at
      limit 1
    )
  ) as product_primary_image_in_sync;
