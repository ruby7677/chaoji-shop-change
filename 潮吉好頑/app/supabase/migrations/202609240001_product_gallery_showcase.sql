-- 潮吉好頑：商品多圖、商品頁詳細介紹與 Hero 預購輪播設定。
-- 前置需求：202609200005_variant_compare_at_price.sql、202609230001_notification_operations.sql（audit action 已含 retry）。
-- product_images 只允許 service_role 存取；Worker 先驗證上架狀態或管理員身分再代理。
-- products.image_path 保留為「主圖」（排序第一張），由 private.sync_product_primary_image 維護，
-- 讓既有 /api/product-images/:productId、型錄 has_image 與後台縮圖不需改動。
-- 可重複執行。

begin;

-- 1. 商品頁長介紹與 Hero 設定 ------------------------------------------------
alter table public.products
  add column if not exists details text,
  add column if not exists hero_rank integer,
  add column if not exists hero_tagline text;

comment on column public.products.details is '商品頁詳細介紹（純文字，前台以安全格式化器轉成規格表／清單／段落）';
comment on column public.products.hero_rank is '首頁 Hero 預購輪播排序，1 最前；null 代表不上輪播';
comment on column public.products.hero_tagline is '首頁 Hero 輪播一句話導購文';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_details_length_check') then
    alter table public.products add constraint products_details_length_check check (details is null or char_length(details) <= 8000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_hero_rank_check') then
    alter table public.products add constraint products_hero_rank_check check (hero_rank is null or hero_rank between 1 and 12);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.products'::regclass and conname = 'products_hero_tagline_length_check') then
    alter table public.products add constraint products_hero_tagline_length_check check (hero_tagline is null or char_length(hero_tagline) <= 80);
  end if;
end;
$$;

-- 2. 商品多圖 ---------------------------------------------------------------
create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  sort_order integer not null check (sort_order >= 0),
  alt_text text check (alt_text is null or char_length(alt_text) <= 120),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 重新排序時同一交易內會暫時重複，因此延後到 commit 才檢查。
  constraint product_images_product_sort_key unique (product_id, sort_order) deferrable initially deferred
);

comment on table public.product_images is '商品圖片；私有 product-images bucket 物件路徑，由 Worker 代理讀取';

alter table public.product_images enable row level security;
drop policy if exists "deny api roles" on public.product_images;
create policy "deny api roles"
  on public.product_images
  for all to anon, authenticated
  using (false)
  with check (false);
revoke all on public.product_images from public, anon, authenticated;
grant select, insert, update, delete on public.product_images to service_role;

-- 既有主圖回填為第一張。
insert into public.product_images (product_id, storage_path, sort_order, created_at, updated_at)
select p.id, p.image_path, 0, coalesce(p.image_updated_at, now()), coalesce(p.image_updated_at, now())
  from public.products p
 where p.image_path is not null
   and not exists (select 1 from public.product_images i where i.product_id = p.id)
on conflict (storage_path) do nothing;

-- 3. 稽核允許刪除動作（保留 202609230001 加入的 retry） ------------------------
alter table public.audit_logs drop constraint if exists audit_logs_action_check;
alter table public.audit_logs add constraint audit_logs_action_check
  check (action in ('create', 'update', 'adjust', 'upload', 'retry', 'delete'));

-- 4. 主圖同步 ---------------------------------------------------------------
create or replace function private.sync_product_primary_image(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_path text;
begin
  select i.storage_path into v_path
    from public.product_images i
   where i.product_id = p_product_id
   order by i.sort_order, i.created_at
   limit 1;
  update public.products
     set image_path = v_path,
         image_updated_at = case when v_path is null then null else now() end,
         updated_at = now()
   where id = p_product_id
     and image_path is distinct from v_path;
end;
$function$;

revoke all on function private.sync_product_primary_image(uuid) from public, anon, authenticated;

-- 舊版單張上傳（覆寫主圖）也要同步到 product_images 第一張。
create or replace function public.admin_update_product_image(
  p_actor_id uuid, p_product_id uuid, p_image_path text, p_image_updated_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype; v_after public.products%rowtype; v_path text := trim(coalesce(p_image_path, ''));
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if v_path = '' then raise exception 'INVALID_IMAGE_PATH'; end if;
  update public.product_images
     set storage_path = v_path, updated_at = now()
   where id = (select i.id from public.product_images i where i.product_id = p_product_id order by i.sort_order, i.created_at limit 1);
  if not found then
    insert into public.product_images (product_id, storage_path, sort_order) values (p_product_id, v_path, 0);
  end if;
  update public.products set image_path = v_path, image_updated_at = coalesce(p_image_updated_at, now()), updated_at = now()
   where id = p_product_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'upload', 'product_image', p_product_id::text,
    jsonb_build_object('image_path', v_before.image_path, 'image_updated_at', v_before.image_updated_at),
    jsonb_build_object('image_path', v_after.image_path, 'image_updated_at', v_after.image_updated_at));
  return to_jsonb(v_after);
end;
$function$;

-- 5. 多圖管理 RPC -------------------------------------------------------------
create or replace function public.admin_add_product_image(
  p_actor_id uuid, p_product_id uuid, p_image_id uuid, p_storage_path text,
  p_width integer default null, p_height integer default null, p_alt_text text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_images%rowtype; v_count integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  perform 1 from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if p_image_id is null
     or p_storage_path is distinct from p_product_id::text || '/' || p_image_id::text || '.' || split_part(p_storage_path, '.', 2)
     or split_part(p_storage_path, '.', 2) not in ('jpg', 'png', 'webp') then
    raise exception 'INVALID_IMAGE_PATH';
  end if;
  select count(*) into v_count from public.product_images where product_id = p_product_id;
  if v_count >= 10 then raise exception 'PRODUCT_IMAGE_LIMIT'; end if;
  insert into public.product_images (id, product_id, storage_path, sort_order, width, height, alt_text)
  values (p_image_id, p_product_id, p_storage_path, v_count,
          case when p_width > 0 then p_width end, case when p_height > 0 then p_height end,
          nullif(left(trim(coalesce(p_alt_text, '')), 120), ''))
  returning * into v_row;
  perform private.sync_product_primary_image(p_product_id);
  perform public.append_audit_log(p_actor_id, 'upload', 'product_image', p_product_id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
end;
$function$;

create or replace function public.admin_reorder_product_images(
  p_actor_id uuid, p_product_id uuid, p_image_ids uuid[]
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before jsonb; v_count integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  perform 1 from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  select count(*), coalesce(jsonb_agg(id order by sort_order), '[]'::jsonb) into v_count, v_before
    from public.product_images where product_id = p_product_id;
  -- 傳入集合必須與現有圖片完全相同：數量一致、無重複、無他人商品的圖片。
  if coalesce(cardinality(p_image_ids), 0) <> v_count
     or (select count(distinct x) from unnest(p_image_ids) x) <> v_count
     or exists (select 1 from unnest(p_image_ids) x where not exists (
          select 1 from public.product_images i where i.id = x and i.product_id = p_product_id)) then
    raise exception 'INVALID_IMAGE_ORDER';
  end if;
  update public.product_images i
     set sort_order = o.ordinality - 1, updated_at = now()
    from unnest(p_image_ids) with ordinality as o(id, ordinality)
   where i.id = o.id and i.product_id = p_product_id;
  perform private.sync_product_primary_image(p_product_id);
  perform public.append_audit_log(p_actor_id, 'update', 'product_image', p_product_id::text,
    jsonb_build_object('order', v_before), jsonb_build_object('order', to_jsonb(p_image_ids)));
  return jsonb_build_object('order', to_jsonb(p_image_ids));
end;
$function$;

create or replace function public.admin_delete_product_image(
  p_actor_id uuid, p_product_id uuid, p_image_id uuid
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_images%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  perform 1 from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  delete from public.product_images where id = p_image_id and product_id = p_product_id returning * into v_row;
  if not found then raise exception 'PRODUCT_IMAGE_NOT_FOUND'; end if;
  update public.product_images i
     set sort_order = r.position - 1, updated_at = now()
    from (select id, row_number() over (order by sort_order, created_at) as position
            from public.product_images where product_id = p_product_id) r
   where i.id = r.id and i.sort_order <> r.position - 1;
  perform private.sync_product_primary_image(p_product_id);
  perform public.append_audit_log(p_actor_id, 'delete', 'product_image', p_product_id::text, to_jsonb(v_row), null);
  return jsonb_build_object('storage_path', v_row.storage_path);
end;
$function$;

create or replace function public.admin_update_product_showcase(
  p_actor_id uuid, p_product_id uuid, p_details text, p_hero_rank integer, p_hero_tagline text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype; v_after public.products%rowtype;
  v_details text := nullif(trim(coalesce(p_details, '')), '');
  v_tagline text := nullif(trim(coalesce(p_hero_tagline, '')), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if char_length(coalesce(v_details, '')) > 8000 or char_length(coalesce(v_tagline, '')) > 80
     or (p_hero_rank is not null and p_hero_rank not between 1 and 12) then
    raise exception 'INVALID_PRODUCT_SHOWCASE';
  end if;
  update public.products set details = v_details, hero_rank = p_hero_rank, hero_tagline = v_tagline, updated_at = now()
   where id = p_product_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product', p_product_id::text,
    jsonb_build_object('details', v_before.details, 'hero_rank', v_before.hero_rank, 'hero_tagline', v_before.hero_tagline),
    jsonb_build_object('details', v_after.details, 'hero_rank', v_after.hero_rank, 'hero_tagline', v_after.hero_tagline));
  return jsonb_build_object('details', v_after.details, 'hero_rank', v_after.hero_rank, 'hero_tagline', v_after.hero_tagline);
end;
$function$;

revoke all on function public.admin_update_product_image(uuid,uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.admin_add_product_image(uuid,uuid,uuid,text,integer,integer,text) from public, anon, authenticated;
revoke all on function public.admin_reorder_product_images(uuid,uuid,uuid[]) from public, anon, authenticated;
revoke all on function public.admin_delete_product_image(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.admin_update_product_showcase(uuid,uuid,text,integer,text) from public, anon, authenticated;
grant execute on function public.admin_update_product_image(uuid,uuid,text,timestamptz) to service_role;
grant execute on function public.admin_add_product_image(uuid,uuid,uuid,text,integer,integer,text) to service_role;
grant execute on function public.admin_reorder_product_images(uuid,uuid,uuid[]) to service_role;
grant execute on function public.admin_delete_product_image(uuid,uuid,uuid) to service_role;
grant execute on function public.admin_update_product_showcase(uuid,uuid,text,integer,text) to service_role;

-- 6. 首頁輪播欄位加入前台 view（只能在最後追加欄位） -----------------------------
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
  p.hero_tagline
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

commit;
