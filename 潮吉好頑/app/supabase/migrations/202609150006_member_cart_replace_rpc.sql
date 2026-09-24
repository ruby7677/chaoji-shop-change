-- 潮吉好頑：以會員自己的 JWT 原子替換購物車，避免多裝置同步互相覆蓋半套資料。

begin;

grant select, insert, update, delete on table public.member_cart_items to authenticated;

create or replace function public.replace_member_cart(p_items jsonb default '[]'::jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_member_id uuid := auth.uid();
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 50 then raise exception 'CART_TOO_LARGE'; end if;
  if exists (
    select 1
      from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer)
     where x.variant_id is null or x.quantity is null or x.quantity < 1 or x.quantity > 100
  ) then raise exception 'CART_ITEM_INVALID'; end if;
  if exists (
    select x.variant_id
      from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer)
     group by x.variant_id
    having count(*) > 1
  ) then raise exception 'CART_DUPLICATE_ITEM'; end if;
  if exists (
    select 1
      from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer)
      left join public.product_variants v on v.id = x.variant_id
      left join public.products p on p.id = v.product_id
     where v.id is null or not v.is_published or p.id is null or not p.is_published
  ) then raise exception 'CART_PRODUCT_NOT_FOUND'; end if;

  delete from public.member_cart_items where member_id = v_member_id;
  insert into public.member_cart_items(member_id, variant_id, quantity, created_at, updated_at)
  select v_member_id, x.variant_id, x.quantity, now(), now()
    from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer);
end;
$$;

revoke all on function public.replace_member_cart(jsonb) from public, anon;
grant execute on function public.replace_member_cart(jsonb) to authenticated;

comment on function public.replace_member_cart(jsonb) is
  '會員以自己的登入身分原子替換跨裝置購物車';

commit;
