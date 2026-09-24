-- 唯讀驗證：應全部回傳 true。
select
  to_regclass('public.profiles') is not null as profiles_exists,
  to_regclass('public.storefront_variants') is not null as storefront_view_exists,
  to_regprocedure('public.create_pending_order(jsonb,text,integer,integer,uuid,text)') is not null as create_order_rpc_exists,
  to_regprocedure('public.handle_new_auth_user()') is not null as auth_profile_function_exists,
  to_regprocedure('public.submit_order_payment(uuid,uuid,text)') is not null as submit_payment_rpc_exists,
  to_regprocedure('public.cancel_expired_orders()') is not null as cancel_expired_orders_exists,
  to_regprocedure('public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean)') is not null as admin_create_product_exists,
  to_regprocedure('public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer)') is not null as admin_create_product_purchase_limit_exists,
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
  to_regprocedure('public.create_discounted_order(jsonb,text,text,integer,uuid,text)') is not null as discounted_order_rpc_exists,
  to_regprocedure('public.create_delivery_order(jsonb,text,text,text,integer,uuid,text,text,text,text)') is not null as delivery_order_rpc_exists,
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
  to_regclass('public.line_notification_logs') is not null as line_notification_logs_exists,
  to_regclass('public.telegram_notification_logs') is not null as telegram_notification_logs_exists,
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
    from information_schema.columns
    where table_schema = 'public' and table_name in ('line_notification_logs', 'telegram_notification_logs')
      and column_name = 'claim_token'
    group by table_schema, column_name
    having count(*) = 2
  ) as notification_claim_token_columns_exist,
  exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'telegram_notification_logs'
      and policyname = 'deny api roles'
  ) as telegram_notification_deny_policy_exists,
  to_regclass('public.line_low_stock_states') is not null as line_low_stock_states_exists,
  to_regclass('public.inventory_return_confirmations') is not null as inventory_return_confirmations_exists,
  to_regprocedure('public.admin_confirm_order_return(uuid,uuid,integer,integer,integer,text)') is not null as admin_confirm_order_return_exists,
  to_regprocedure('public.admin_dashboard_stats(uuid)') is not null as admin_dashboard_stats_exists,
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
  to_regclass('public.orders_cancellation_notification_pending_idx') is not null as cancellation_notification_pending_index_exists;
