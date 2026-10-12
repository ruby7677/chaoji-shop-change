-- 新增規格時可直接填初始庫存（與新增商品的 p_stock 相同）：
-- admin_create_variant 加上最後一個參數 p_stock（預設 0），大於 0 時寫入 stock_in 庫存異動「新增規格初始庫存」。
-- 先刪舊簽名再建立，避免同名 overload 讓 PostgREST 具名呼叫產生歧義；舊呼叫（不帶 p_stock）仍可用。
-- 其餘規則與 202610010002_sku_optional_variant_name_unique.sql 的定義相同。

begin;

drop function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer);

create function public.admin_create_variant(
  p_actor_id uuid, p_product_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_safety_stock integer, p_preorder_arrival text,
  p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer,
  p_stock integer default 0
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_variants%rowtype; v_order integer; v_constraint text; v_stock integer := coalesce(p_stock, 0);
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0 or v_stock < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5)
     or (p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price)) then raise exception 'INVALID_VARIANT'; end if;
  -- 未指定排序：取全站規格最大值 + 1（排在前台最前面、數字不重複）；有指定則照用。
  perform pg_advisory_xact_lock(hashtext('public.product_variants.display_order'));
  v_order := coalesce(p_display_order, (select max(display_order) + 1 from public.product_variants), 1);
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, safety_stock, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (p_product_id, trim(p_name), coalesce(nullif(upper(trim(p_sku)), ''), 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), p_kind, p_price, p_compare_at_price, v_stock, coalesce(p_safety_stock, 3), nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), coalesce(p_is_published, false), v_order)
  returning * into v_row;
  if v_stock > 0 then
    insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
    values (v_row.id, 'stock_in', v_stock, '新增規格初始庫存', p_actor_id);
  end if;
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'product_variants_product_name_key' then raise exception 'VARIANT_NAME_EXISTS'; end if;
  raise exception 'SKU_EXISTS';
end;
$function$;

revoke all on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer,integer) to service_role;

commit;
