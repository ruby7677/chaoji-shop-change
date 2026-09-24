-- 將既有管理 RPC 的資料變更與 audit_logs 綁在同一個資料庫 transaction。

begin;

create or replace function public.admin_create_product(
  p_actor_id uuid,
  p_category_name text,
  p_product_name text,
  p_description text,
  p_variant_name text,
  p_sku text,
  p_kind public.product_kind,
  p_price integer,
  p_stock integer,
  p_preorder_arrival text,
  p_deposit_rate numeric,
  p_seller_link text,
  p_is_published boolean,
  p_purchase_limit integer default null,
  p_points_eligible boolean default true,
  p_compare_at_price integer default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_category_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_category_created boolean := false;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if nullif(trim(p_category_name), '') is null or nullif(trim(p_product_name), '') is null or nullif(trim(p_sku), '') is null then raise exception 'REQUIRED_FIELDS_MISSING'; end if;
  if p_price < 0 or p_stock < 0 then raise exception 'INVALID_NUMBER'; end if;
  if p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  if p_purchase_limit is not null and p_purchase_limit < 1 then raise exception 'INVALID_PURCHASE_LIMIT'; end if;
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id, (xmax = 0) into v_category_id, v_category_created;

  insert into public.products(category_id, name, description, is_published, display_order, purchase_limit, points_eligible)
  values (v_category_id, trim(p_product_name), coalesce(p_description, ''), p_is_published,
          coalesce((select max(display_order) + 10 from public.products), 10), p_purchase_limit, coalesce(p_points_eligible, true))
  returning * into v_product;

  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (v_product.id, coalesce(nullif(trim(p_variant_name), ''), '單一規格'), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, p_stock,
          nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), p_is_published, 10)
  returning * into v_variant;

  if p_stock > 0 then
    insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
    values (v_variant.id, 'stock_in', p_stock, '建立商品初始庫存', p_actor_id);
  end if;
  if v_category_created then perform public.append_audit_log(p_actor_id, 'create', 'category', v_category_id::text, null, (select to_jsonb(c) from public.categories c where c.id = v_category_id)); end if;
  perform public.append_audit_log(p_actor_id, 'create', 'product', v_product.id::text, null, to_jsonb(v_product));
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_variant.id::text, null, to_jsonb(v_variant));
  return jsonb_build_object('product_id', v_product.id, 'variant_id', v_variant.id);
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;

create or replace function public.admin_adjust_inventory(
  p_actor_id uuid, p_variant_id uuid, p_quantity_delta integer, p_reason text
)
returns integer
language plpgsql security definer set search_path = ''
as $function$
declare
  v_before public.product_variants%rowtype;
  v_after public.product_variants%rowtype;
  v_reserved integer;
  v_new_stock integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_quantity_delta = 0 then raise exception 'ZERO_ADJUSTMENT'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'REASON_REQUIRED'; end if;
  select * into v_before from public.product_variants where id = p_variant_id for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
  select coalesce(sum(quantity), 0)::integer into v_reserved from public.inventory_reservations where variant_id = p_variant_id and released_at is null and expires_at > now();
  v_new_stock := v_before.stock_on_hand + p_quantity_delta;
  if v_new_stock < 0 then raise exception 'NEGATIVE_STOCK'; end if;
  if v_new_stock < v_reserved then raise exception 'BELOW_RESERVED_STOCK'; end if;
  update public.product_variants set stock_on_hand = v_new_stock, updated_at = now() where id = p_variant_id returning * into v_after;
  insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
  values (p_variant_id, 'adjustment', p_quantity_delta, trim(p_reason), p_actor_id);
  perform public.append_audit_log(p_actor_id, 'adjust', 'product_variant', p_variant_id::text, to_jsonb(v_before), to_jsonb(v_after) || jsonb_build_object('quantity_delta', p_quantity_delta, 'reason', trim(p_reason)));
  return v_after.stock_on_hand;
end;
$function$;

create or replace function public.admin_update_point_settings(
  p_actor_id uuid, p_earn_amount_per_point integer, p_point_value integer, p_min_redeem_points integer,
  p_max_redeem_mode text, p_max_redeem_value integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.point_settings%rowtype; v_after public.point_settings%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_earn_amount_per_point <= 0 or p_point_value <= 0 or p_min_redeem_points <= 0 or p_max_redeem_value < 0
     or p_max_redeem_mode not in ('percent','fixed') or (p_max_redeem_mode = 'percent' and p_max_redeem_value > 100) then raise exception 'INVALID_POINT_SETTINGS'; end if;
  select * into v_before from public.point_settings where id = true for update;
  insert into public.point_settings(id, earn_amount_per_point, point_value, min_redeem_points, max_redeem_mode, max_redeem_value, updated_by, updated_at)
  values (true, p_earn_amount_per_point, p_point_value, p_min_redeem_points, p_max_redeem_mode, p_max_redeem_value, p_actor_id, now())
  on conflict (id) do update set earn_amount_per_point = excluded.earn_amount_per_point, point_value = excluded.point_value,
    min_redeem_points = excluded.min_redeem_points, max_redeem_mode = excluded.max_redeem_mode, max_redeem_value = excluded.max_redeem_value,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'point_settings', 'true', to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$function$;

create or replace function public.admin_adjust_member_points(
  p_actor_id uuid, p_member_id uuid, p_points integer, p_reason text
)
returns integer
language plpgsql security definer set search_path = ''
as $function$
declare v_balance integer; v_after integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = p_member_id) then raise exception 'MEMBER_NOT_FOUND'; end if;
  if p_points = 0 then raise exception 'ZERO_POINT_ADJUSTMENT'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select coalesce(sum(points), 0)::integer into v_balance from public.point_ledger where member_id = p_member_id;
  if v_balance + p_points < 0 then raise exception 'INSUFFICIENT_POINTS'; end if;
  insert into public.point_ledger(member_id, kind, points, reason, actor_id) values (p_member_id, 'manual', p_points, trim(p_reason), p_actor_id);
  v_after := v_balance + p_points;
  perform public.append_audit_log(p_actor_id, 'adjust', 'member_points', p_member_id::text,
    jsonb_build_object('balance', v_balance), jsonb_build_object('balance', v_after, 'points', p_points, 'reason', trim(p_reason)));
  return v_after;
end;
$function$;

create or replace function public.admin_save_coupon(
  p_actor_id uuid, p_coupon_id uuid, p_code text, p_name text, p_discount_amount integer,
  p_combinable boolean, p_valid_from timestamptz, p_valid_until timestamptz, p_total_usage_limit integer,
  p_per_member_limit integer, p_is_active boolean, p_product_ids uuid[], p_member_ids uuid[]
)
returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare v_id uuid := p_coupon_id; v_code text := upper(trim(p_code)); v_before jsonb; v_after jsonb; v_row public.coupons%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,32}$' or nullif(trim(p_name), '') is null or p_discount_amount <= 0 or p_valid_until <= p_valid_from or p_per_member_limit <= 0
     or (p_total_usage_limit is not null and p_total_usage_limit <= 0) then raise exception 'INVALID_COUPON'; end if;
  if v_id is not null then
    select to_jsonb(c) || jsonb_build_object('product_ids', coalesce((select jsonb_agg(product_id) from public.coupon_products where coupon_id = c.id), '[]'::jsonb), 'member_ids', coalesce((select jsonb_agg(member_id) from public.coupon_members where coupon_id = c.id), '[]'::jsonb)) into v_before from public.coupons c where c.id = v_id and not c.is_birthday for update;
    if v_before is null then raise exception 'COUPON_NOT_FOUND'; end if;
    update public.coupons set code=v_code,name=trim(p_name),discount_amount=p_discount_amount,combinable_with_points=p_combinable,valid_from=p_valid_from,valid_until=p_valid_until,total_usage_limit=p_total_usage_limit,per_member_limit=p_per_member_limit,is_active=p_is_active,updated_at=now() where id=v_id;
    delete from public.coupon_products where coupon_id=v_id;
    delete from public.coupon_members where coupon_id=v_id;
  else
    insert into public.coupons(code,name,discount_amount,combinable_with_points,valid_from,valid_until,total_usage_limit,per_member_limit,is_active,created_by)
    values(v_code,trim(p_name),p_discount_amount,p_combinable,p_valid_from,p_valid_until,p_total_usage_limit,p_per_member_limit,p_is_active,p_actor_id) returning id into v_id;
  end if;
  insert into public.coupon_products(coupon_id,product_id) select v_id,unnest(coalesce(p_product_ids,'{}'::uuid[])) on conflict do nothing;
  insert into public.coupon_members(coupon_id,member_id) select v_id,unnest(coalesce(p_member_ids,'{}'::uuid[])) on conflict do nothing;
  select * into v_row from public.coupons where id=v_id;
  v_after := to_jsonb(v_row) || jsonb_build_object('product_ids', coalesce((select jsonb_agg(product_id) from public.coupon_products where coupon_id = v_id), '[]'::jsonb), 'member_ids', coalesce((select jsonb_agg(member_id) from public.coupon_members where coupon_id = v_id), '[]'::jsonb));
  perform public.append_audit_log(p_actor_id, case when p_coupon_id is null then 'create' else 'update' end, 'coupon', v_id::text, v_before, v_after);
  return v_id;
exception when unique_violation then raise exception 'COUPON_CODE_EXISTS';
end;
$function$;

create or replace function public.admin_update_birthday_coupon_settings(
  p_actor_id uuid, p_enabled boolean, p_discount_amount integer, p_issue_days_before integer, p_valid_days integer, p_combinable boolean
)
returns public.birthday_coupon_settings
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.birthday_coupon_settings%rowtype; v_after public.birthday_coupon_settings%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_discount_amount <= 0 or p_issue_days_before not between 0 and 60 or p_valid_days not between 1 and 365 then raise exception 'INVALID_BIRTHDAY_SETTINGS'; end if;
  select * into v_before from public.birthday_coupon_settings where id = true for update;
  update public.birthday_coupon_settings set enabled=p_enabled, discount_amount=p_discount_amount, issue_days_before=p_issue_days_before, valid_days=p_valid_days, combinable_with_points=p_combinable, updated_by=p_actor_id, updated_at=now() where id=true returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'birthday_coupon_settings', 'true', to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$function$;

revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) from public, anon, authenticated, service_role;
-- 舊 overload 仍可能存在於既有專案；全部撤銷 service_role execute，避免繞過 audit RPC。
revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_adjust_inventory(uuid,uuid,integer,text) from public, anon, authenticated, service_role;
revoke all on function public.admin_update_point_settings(uuid,integer,integer,integer,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_adjust_member_points(uuid,uuid,integer,text) from public, anon, authenticated, service_role;
revoke all on function public.admin_save_coupon(uuid,uuid,text,text,integer,boolean,timestamptz,timestamptz,integer,integer,boolean,uuid[],uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.admin_update_birthday_coupon_settings(uuid,boolean,integer,integer,integer,boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) to service_role;
grant execute on function public.admin_adjust_inventory(uuid,uuid,integer,text) to service_role;
grant execute on function public.admin_update_point_settings(uuid,integer,integer,integer,text,integer) to service_role;
grant execute on function public.admin_adjust_member_points(uuid,uuid,integer,text) to service_role;
grant execute on function public.admin_save_coupon(uuid,uuid,text,text,integer,boolean,timestamptz,timestamptz,integer,integer,boolean,uuid[],uuid[]) to service_role;
grant execute on function public.admin_update_birthday_coupon_settings(uuid,boolean,integer,integer,integer,boolean) to service_role;

commit;
