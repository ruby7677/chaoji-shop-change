-- 潮吉好頑：規格可指定商品多圖中的一張，前台切換規格時主圖跟著換（業主決策 2026-10-31，VARIANT_IMAGE_PLAN.md）。
-- 1. product_variants.image_id：只能指向同一商品的 product_images（複合外鍵）；刪除圖片時只清空 image_id，規格保留。
-- 2. storefront_variants 在尾端追加 image_id（create or replace view 只能在尾端新增欄位），並補欄位 SELECT 授權。
-- 3. admin_update_variant 加 p_image_id／p_update_image（null 代表「清除」，需旗標區分「不變」）；舊簽名移除。
--    新參數都有預設值，先套用本 migration 再部署 Worker 時舊 Worker 仍可呼叫。
-- 其餘規則與 202610240001_variant_show_stock.sql 的定義相同。

begin;

alter table public.product_images
  add constraint product_images_id_product_key unique (id, product_id);

alter table public.product_variants
  add column if not exists image_id uuid;
alter table public.product_variants
  add constraint product_variants_image_fkey foreign key (image_id, product_id)
  references public.product_images (id, product_id) on delete set null (image_id);
create index if not exists product_variants_image_id_idx on public.product_variants (image_id) where image_id is not null;
comment on column public.product_variants.image_id is '規格指定的商品圖片（同商品的 product_images）；null＝使用商品主圖';

grant select (image_id) on table public.product_variants to anon, authenticated;

-- 與 202610240001 相同，只在最後追加 image_id
create or replace view public.storefront_variants with (security_invoker = true) as
select
  v.id::text,
  c.name as category,
  p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price,
  private.storefront_available_stock(v.id) as stock,
  case when v.kind = 'in_stock' then '現貨' else '預購' end as type,
  v.preorder_arrival,
  v.seller_link,
  v.display_order,
  v.is_published,
  p.id::text as product_id,
  (p.image_path is not null) as has_image,
  p.image_updated_at,
  v.shipping_units,
  p.name as product_name,
  p.description,
  v.name as variant_name,
  p.purchase_limit,
  p.points_eligible,
  v.compare_at_price,
  p.hero_rank,
  p.hero_tagline,
  p.image_width,
  p.image_height,
  p.image_path,
  p.allowed_delivery_methods,
  v.show_stock,
  v.image_id::text as image_id
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

drop function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer,boolean);
create function public.admin_update_variant(
  p_actor_id uuid, p_variant_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_update_compare_at_price boolean, p_safety_stock integer,
  p_preorder_arrival text, p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer,
  p_show_stock boolean default null,
  p_image_id uuid default null,
  p_update_image boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.product_variants%rowtype; v_after public.product_variants%rowtype; v_compare integer; v_image uuid; v_constraint text;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.product_variants where id = p_variant_id for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5) then raise exception 'INVALID_VARIANT'; end if;
  v_compare := case when coalesce(p_update_compare_at_price, true) then p_compare_at_price else v_before.compare_at_price end;
  if v_compare is not null and (v_compare < 0 or v_compare < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  v_image := case when coalesce(p_update_image, false) then p_image_id else v_before.image_id end;
  -- 外鍵也會擋，這裡先給明確錯誤碼：只能選同一商品的圖片
  if v_image is not null and not exists (select 1 from public.product_images where id = v_image and product_id = v_before.product_id) then
    raise exception 'INVALID_VARIANT_IMAGE';
  end if;
  -- 排序可為負數（新商品自動排最前面時會出現）；未提供時保留原值
  update public.product_variants
     set name = trim(p_name), sku = coalesce(nullif(upper(trim(p_sku)), ''), v_before.sku), kind = p_kind, price = p_price, compare_at_price = v_compare,
         safety_stock = coalesce(p_safety_stock, 3), preorder_arrival = nullif(trim(p_preorder_arrival), ''), deposit_rate = p_deposit_rate,
         seller_link = nullif(trim(p_seller_link), ''), is_published = coalesce(p_is_published, false), display_order = coalesce(p_display_order, v_before.display_order),
         show_stock = coalesce(p_show_stock, v_before.show_stock), image_id = v_image, updated_at = now()
   where id = p_variant_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product_variant', p_variant_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'product_variants_product_name_key' then raise exception 'VARIANT_NAME_EXISTS'; end if;
  raise exception 'SKU_EXISTS';
end;
$function$;

revoke all on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer,boolean,uuid,boolean) from public, anon, authenticated;
grant execute on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer,boolean,uuid,boolean) to service_role;

commit;
