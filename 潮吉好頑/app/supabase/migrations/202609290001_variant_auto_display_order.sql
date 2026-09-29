-- 前台排序自動填數：前台依 product_variants.display_order 由小到大排列。
-- 新商品的規格排在最前面（全站最小值 - 10，可為負數）；既有商品新增規格時，未指定排序就接在該商品最後一個規格之後（+1）。
-- 因此放寬規格排序不可為負數的限制，管理員仍可手動改成任意整數。

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

  -- 新商品排在前台最前面：比目前所有規格的最小排序再小 10
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (v_product.id, coalesce(nullif(trim(p_variant_name), ''), '單一規格'), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, p_stock,
          nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), p_is_published,
          coalesce((select min(display_order) - 10 from public.product_variants), 10))
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

create or replace function public.admin_create_variant(
  p_actor_id uuid, p_product_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_safety_stock integer, p_preorder_arrival text,
  p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_variants%rowtype; v_order integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_sku), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5)
     or (p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price)) then raise exception 'INVALID_VARIANT'; end if;
  -- 未指定排序：接在同商品最後一個規格之後；商品還沒有規格時比全站最小值再小 10（排最前面）
  v_order := coalesce(
    p_display_order,
    (select max(display_order) + 1 from public.product_variants where product_id = p_product_id),
    (select min(display_order) - 10 from public.product_variants),
    10
  );
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, safety_stock, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (p_product_id, trim(p_name), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, 0, coalesce(p_safety_stock, 3), nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), coalesce(p_is_published, false), v_order)
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
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5) then raise exception 'INVALID_VARIANT'; end if;
  v_compare := case when coalesce(p_update_compare_at_price, true) then p_compare_at_price else v_before.compare_at_price end;
  if v_compare is not null and (v_compare < 0 or v_compare < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  -- 排序可為負數（新商品自動排最前面時會出現）；未提供時保留原值
  update public.product_variants
     set name = trim(p_name), sku = upper(trim(p_sku)), kind = p_kind, price = p_price, compare_at_price = v_compare,
         safety_stock = coalesce(p_safety_stock, 3), preorder_arrival = nullif(trim(p_preorder_arrival), ''), deposit_rate = p_deposit_rate,
         seller_link = nullif(trim(p_seller_link), ''), is_published = coalesce(p_is_published, false), display_order = coalesce(p_display_order, v_before.display_order), updated_at = now()
   where id = p_variant_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product_variant', p_variant_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;

revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) to service_role;
grant execute on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) to service_role;
grant execute on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer) to service_role;

commit;
