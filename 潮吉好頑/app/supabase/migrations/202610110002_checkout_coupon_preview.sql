-- 潮吉好頑：結帳第三步「套用」優惠碼時先試算折抵（唯讀，不核銷、不保留）。
-- 規則與 create_delivery_order（202610110001_cvs_delivery.sql）的優惠券段落一致，建單時仍會重新驗證並鎖定優惠券。
begin;

create or replace function public.preview_checkout_coupon(
  p_items jsonb,
  p_coupon_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_member_id uuid := auth.uid();
  v_code text := nullif(upper(trim(coalesce(p_coupon_code, ''))), '');
  v_coupon public.coupons;
  v_item record;
  v_variant record;
  v_has_preorder boolean := false;
  v_has_in_stock boolean := false;
  v_eligible integer := 0;
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if v_code is null then raise exception 'COUPON_NOT_FOUND'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;

  select * into v_coupon from public.coupons where code = v_code;
  if not found then raise exception 'COUPON_NOT_FOUND'; end if;
  if not v_coupon.is_active or now() < v_coupon.valid_from or now() > v_coupon.valid_until then raise exception 'COUPON_EXPIRED'; end if;
  if exists (select 1 from public.coupon_members where coupon_id = v_coupon.id)
     and not exists (select 1 from public.coupon_members where coupon_id = v_coupon.id and member_id = v_member_id) then raise exception 'COUPON_NOT_ELIGIBLE'; end if;
  if v_coupon.total_usage_limit is not null and (select count(*) from public.coupon_redemptions where coupon_id = v_coupon.id) >= v_coupon.total_usage_limit then raise exception 'COUPON_USAGE_LIMIT'; end if;
  if (select count(*) from public.coupon_redemptions where coupon_id = v_coupon.id and member_id = v_member_id) >= v_coupon.per_member_limit then raise exception 'COUPON_MEMBER_LIMIT'; end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    if v_item.quantity is null or v_item.quantity < 1 then raise exception 'INVALID_QUANTITY'; end if;
    select v.price, v.kind, p.id as parent_product_id
      into v_variant
      from public.product_variants v
      join public.products p on p.id = v.product_id
     where v.id = v_item.variant_id and v.is_published and p.is_published;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if v_variant.kind = 'preorder' then v_has_preorder := true; else v_has_in_stock := true; end if;
    if not exists (select 1 from public.coupon_products where coupon_id = v_coupon.id)
       or exists (select 1 from public.coupon_products where coupon_id = v_coupon.id and product_id = v_variant.parent_product_id) then
      v_eligible := v_eligible + v_variant.price * v_item.quantity;
    end if;
  end loop;

  if v_has_preorder and v_has_in_stock then raise exception 'MIXED_ORDER_NOT_ALLOWED'; end if;
  if v_eligible = 0 then raise exception 'COUPON_PRODUCT_NOT_ELIGIBLE'; end if;

  return jsonb_build_object(
    'code', v_coupon.code,
    'name', v_coupon.name,
    'discount_amount', least(v_coupon.discount_amount, v_eligible),
    'combinable_with_points', v_coupon.combinable_with_points
  );
end;
$function$;

revoke all on function public.preview_checkout_coupon(jsonb, text) from public, anon;
grant execute on function public.preview_checkout_coupon(jsonb, text) to authenticated;

commit;
