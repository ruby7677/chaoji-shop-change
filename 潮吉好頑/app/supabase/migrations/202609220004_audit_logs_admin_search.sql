-- 管理操作稽核與後台搜尋分頁。
-- audit_logs 只允許 service_role 寫入／讀取；UPDATE、DELETE、TRUNCATE 由權限與 trigger 同時阻擋。
-- 管理 mutation 透過固定名稱 RPC 寫入 audit 與資料變更，避免 REST PATCH 與稽核分離。

begin;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null,
  resource text not null,
  target text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_action_check') then
    alter table public.audit_logs add constraint audit_logs_action_check
      check (action in ('create', 'update', 'adjust', 'upload'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_resource_check') then
    alter table public.audit_logs add constraint audit_logs_resource_check
      check (resource in ('product', 'product_variant', 'category', 'bank_account', 'coupon', 'birthday_coupon_settings', 'point_settings', 'member_points', 'product_image'));
  end if;
end;
$$;

create index if not exists audit_logs_created_idx on public.audit_logs(created_at desc, id desc);
create index if not exists audit_logs_resource_target_idx on public.audit_logs(resource, target, created_at desc);
create index if not exists audit_logs_actor_created_idx on public.audit_logs(actor_id, created_at desc);

alter table public.audit_logs enable row level security;
drop policy if exists "deny api roles" on public.audit_logs;
create policy "deny api roles"
  on public.audit_logs
  for all to anon, authenticated
  using (false)
  with check (false);
revoke all on public.audit_logs from public, anon, authenticated;
grant select, insert on public.audit_logs to service_role;
revoke update, delete, truncate on public.audit_logs from service_role;

create or replace function public.prevent_audit_log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'AUDIT_LOG_IMMUTABLE';
end;
$function$;

drop trigger if exists audit_logs_immutable on public.audit_logs;
create trigger audit_logs_immutable
before update or delete on public.audit_logs
for each row execute function public.prevent_audit_log_mutation();
drop trigger if exists audit_logs_immutable_truncate on public.audit_logs;
create trigger audit_logs_immutable_truncate
before truncate on public.audit_logs
for each statement execute function public.prevent_audit_log_mutation();

revoke all on function public.prevent_audit_log_mutation() from public, anon, authenticated, service_role;

create or replace function public.append_audit_log(
  p_actor_id uuid,
  p_action text,
  p_resource text,
  p_target text,
  p_before_data jsonb default null,
  p_after_data jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if nullif(trim(coalesce(p_target, '')), '') is null then
    raise exception 'AUDIT_TARGET_REQUIRED';
  end if;
  insert into public.audit_logs(actor_id, action, resource, target, before_data, after_data)
  values (p_actor_id, p_action, p_resource, trim(p_target), p_before_data, p_after_data)
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function public.append_audit_log(uuid,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.append_audit_log(uuid,text,text,text,jsonb,jsonb) to service_role;

create or replace function public.admin_create_bank_account(
  p_actor_id uuid, p_label text, p_bank_name text, p_account_name text,
  p_account_number text, p_is_active boolean default true, p_display_order integer default 0
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.bank_accounts%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if nullif(trim(p_label), '') is null or nullif(trim(p_bank_name), '') is null or nullif(trim(p_account_name), '') is null
     or regexp_replace(coalesce(p_account_number, ''), '[[:space:]-]', '', 'g') !~ '^[0-9]{8,20}$'
     or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_BANK_ACCOUNT'; end if;
  insert into public.bank_accounts(label, bank_name, account_name, account_number, is_active, display_order)
  values (trim(p_label), trim(p_bank_name), trim(p_account_name), regexp_replace(p_account_number, '[[:space:]-]', '', 'g'), coalesce(p_is_active, true), coalesce(p_display_order, 0))
  returning * into v_row;
  perform public.append_audit_log(p_actor_id, 'create', 'bank_account', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
end;
$function$;

create or replace function public.admin_update_bank_account(
  p_actor_id uuid, p_account_id uuid, p_label text, p_bank_name text, p_account_name text,
  p_account_number text, p_is_active boolean default true, p_display_order integer default 0
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.bank_accounts%rowtype; v_after public.bank_accounts%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.bank_accounts where id = p_account_id for update;
  if not found then raise exception 'BANK_ACCOUNT_NOT_FOUND'; end if;
  if nullif(trim(p_label), '') is null or nullif(trim(p_bank_name), '') is null or nullif(trim(p_account_name), '') is null
     or regexp_replace(coalesce(p_account_number, ''), '[[:space:]-]', '', 'g') !~ '^[0-9]{8,20}$'
     or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_BANK_ACCOUNT'; end if;
  update public.bank_accounts
     set label = trim(p_label), bank_name = trim(p_bank_name), account_name = trim(p_account_name),
         account_number = regexp_replace(p_account_number, '[[:space:]-]', '', 'g'),
         is_active = coalesce(p_is_active, true), display_order = coalesce(p_display_order, 0)
   where id = p_account_id
   returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'bank_account', p_account_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$function$;

create or replace function public.admin_create_category(
  p_actor_id uuid, p_name text, p_display_order integer default 0, p_is_active boolean default true
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.categories%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if nullif(trim(p_name), '') is null or char_length(trim(p_name)) > 50 or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_CATEGORY'; end if;
  insert into public.categories(name, display_order, is_active)
  values (trim(p_name), coalesce(p_display_order, 0), coalesce(p_is_active, true))
  returning * into v_row;
  perform public.append_audit_log(p_actor_id, 'create', 'category', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
exception when unique_violation then raise exception 'CATEGORY_NAME_EXISTS';
end;
$function$;

create or replace function public.admin_update_category(
  p_actor_id uuid, p_category_id uuid, p_name text, p_display_order integer default 0, p_is_active boolean default true
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.categories%rowtype; v_after public.categories%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.categories where id = p_category_id for update;
  if not found then raise exception 'CATEGORY_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or char_length(trim(p_name)) > 50 or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_CATEGORY'; end if;
  update public.categories set name = trim(p_name), display_order = coalesce(p_display_order, 0), is_active = coalesce(p_is_active, true)
   where id = p_category_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'category', p_category_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
exception when unique_violation then raise exception 'CATEGORY_NAME_EXISTS';
end;
$function$;

create or replace function public.admin_create_variant(
  p_actor_id uuid, p_product_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_safety_stock integer, p_preorder_arrival text,
  p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_variants%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_sku), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or coalesce(p_display_order, 0) < 0 or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5)
     or (p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price)) then raise exception 'INVALID_VARIANT'; end if;
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, safety_stock, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (p_product_id, trim(p_name), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, 0, coalesce(p_safety_stock, 3), nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), coalesce(p_is_published, false), coalesce(p_display_order, 0))
  returning * into v_row;
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;

create or replace function public.admin_update_variant(
  p_actor_id uuid, p_variant_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_update_compare_at_price boolean, p_safety_stock integer,
  p_preorder_arrival text, p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.product_variants%rowtype; v_after public.product_variants%rowtype; v_compare integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.product_variants where id = p_variant_id for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_sku), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or coalesce(p_display_order, 0) < 0 or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5) then raise exception 'INVALID_VARIANT'; end if;
  v_compare := case when coalesce(p_update_compare_at_price, true) then p_compare_at_price else v_before.compare_at_price end;
  if v_compare is not null and (v_compare < 0 or v_compare < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  update public.product_variants
     set name = trim(p_name), sku = upper(trim(p_sku)), kind = p_kind, price = p_price, compare_at_price = v_compare,
         safety_stock = coalesce(p_safety_stock, 3), preorder_arrival = nullif(trim(p_preorder_arrival), ''), deposit_rate = p_deposit_rate,
         seller_link = nullif(trim(p_seller_link), ''), is_published = coalesce(p_is_published, false), display_order = coalesce(p_display_order, 0), updated_at = now()
   where id = p_variant_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product_variant', p_variant_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;

create or replace function public.admin_update_product(
  p_actor_id uuid, p_product_id uuid, p_name text, p_description text, p_category_id uuid,
  p_purchase_limit integer, p_points_eligible boolean, p_is_published boolean, p_display_order integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype; v_after public.products%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or (p_purchase_limit is not null and p_purchase_limit < 1) or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_PRODUCT'; end if;
  if p_category_id is not null and not exists (select 1 from public.categories where id = p_category_id and is_active) then raise exception 'INVALID_CATEGORY'; end if;
  update public.products
     set name = trim(p_name), description = coalesce(p_description, ''), category_id = p_category_id,
         purchase_limit = p_purchase_limit, points_eligible = coalesce(p_points_eligible, v_before.points_eligible), is_published = coalesce(p_is_published, false),
         display_order = coalesce(p_display_order, 0), updated_at = now()
   where id = p_product_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product', p_product_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$function$;

create or replace function public.admin_record_product_image_audit(
  p_actor_id uuid, p_product_id uuid, p_before_path text, p_after_path text
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare v_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  v_id := public.append_audit_log(p_actor_id, 'upload', 'product_image', p_product_id::text,
    jsonb_build_object('image_path', p_before_path), jsonb_build_object('image_path', p_after_path));
  return v_id;
end;
$function$;

create or replace function public.admin_update_product_image(
  p_actor_id uuid, p_product_id uuid, p_image_path text, p_image_updated_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype; v_after public.products%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_image_path), '') is null then raise exception 'INVALID_IMAGE_PATH'; end if;
  update public.products set image_path = trim(p_image_path), image_updated_at = coalesce(p_image_updated_at, now()), updated_at = now()
   where id = p_product_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'upload', 'product_image', p_product_id::text,
    jsonb_build_object('image_path', v_before.image_path, 'image_updated_at', v_before.image_updated_at),
    jsonb_build_object('image_path', v_after.image_path, 'image_updated_at', v_after.image_updated_at));
  return to_jsonb(v_after);
end;
$function$;

create or replace function public.admin_search_order_ids(
  p_actor_id uuid, p_query text default '', p_status text default 'all', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_status text := lower(trim(coalesce(p_status, 'all'))); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_status not in ('all','seller_pending','pending_payment','pending_review','confirmed','partially_ready','ready_for_pickup','completed','cancelled','refund_pending','refunded') then raise exception 'INVALID_ADMIN_ORDER_FILTER'; end if;
  -- E'\\' evaluates to one backslash: the ESCAPE character must be exactly one byte.
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select o.id
        from public.orders o
        left join public.profiles p on p.id = o.member_id
       where (v_status = 'all' or (v_status = 'seller_pending' and o.delivery_method = 'seller_delivery' and o.status = 'pending_payment' and o.bank_account_id is null) or (v_status not in ('all','seller_pending') and o.status::text = v_status))
         and (v_query = '' or o.order_number ilike '%' || v_query || '%' escape E'\\' or coalesce(o.payment_last_five, '') ilike '%' || v_query || '%' escape E'\\' or coalesce(p.full_name, '') ilike '%' || v_query || '%' escape E'\\' or coalesce(p.phone, '') ilike '%' || v_query || '%' escape E'\\')
       order by o.created_at desc, o.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

create or replace function public.admin_search_member_ids(
  p_actor_id uuid, p_query text default '', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  -- Keep the escape character one byte while making user wildcards literal.
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select p.id from public.profiles p
       where v_query = '' or coalesce(p.full_name, '') ilike '%' || v_query || '%' escape E'\\' or coalesce(p.phone, '') ilike '%' || v_query || '%' escape E'\\'
       order by p.created_at desc, p.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

revoke all on function public.admin_create_bank_account(uuid,text,text,text,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_update_bank_account(uuid,uuid,text,text,text,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_create_category(uuid,text,integer,boolean) from public, anon, authenticated;
revoke all on function public.admin_update_category(uuid,uuid,text,integer,boolean) from public, anon, authenticated;
revoke all on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_record_product_image_audit(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.admin_update_product_image(uuid,uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.admin_search_order_ids(uuid,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_search_member_ids(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_create_bank_account(uuid,text,text,text,text,boolean,integer) to service_role;
grant execute on function public.admin_update_bank_account(uuid,uuid,text,text,text,text,boolean,integer) to service_role;
grant execute on function public.admin_create_category(uuid,text,integer,boolean) to service_role;
grant execute on function public.admin_update_category(uuid,uuid,text,integer,boolean) to service_role;
grant execute on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) to service_role;
grant execute on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer) to service_role;
grant execute on function public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer) to service_role;
grant execute on function public.admin_record_product_image_audit(uuid,uuid,text,text) to service_role;
grant execute on function public.admin_update_product_image(uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.admin_search_order_ids(uuid,text,text,integer,integer) to service_role;
grant execute on function public.admin_search_member_ids(uuid,text,integer,integer) to service_role;

comment on table public.audit_logs is '管理操作不可變稽核紀錄；資料庫 trigger 拒絕 UPDATE、DELETE';
comment on function public.admin_search_order_ids(uuid,text,text,integer,integer) is '管理員訂單搜尋／狀態篩選／分頁，回傳完整 order id 分頁結果';
comment on function public.admin_search_member_ids(uuid,text,integer,integer) is '管理員會員姓名／手機搜尋／分頁，回傳完整 member id 分頁結果';

commit;
