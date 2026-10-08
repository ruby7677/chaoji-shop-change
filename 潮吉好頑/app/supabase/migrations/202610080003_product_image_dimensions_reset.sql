-- 潮吉好頑：主圖換掉時清除舊寬高。
-- 主圖可能由多個路徑更換：後台上傳（admin_update_product_image）、多圖排序或刪除第一張
-- （private.sync_product_primary_image）。只要 image_path 或 image_updated_at 改變、而同一次更新沒有一併寫入寬高，
-- 就把寬高清成 null，避免前台沿用舊照片的比例；Worker 上傳時隨後寫入新寬高，其他情況由每小時排程重新讀取。

begin;

create or replace function private.reset_product_image_dimensions()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (new.image_path is distinct from old.image_path or new.image_updated_at is distinct from old.image_updated_at)
     and new.image_width is not distinct from old.image_width
     and new.image_height is not distinct from old.image_height then
    new.image_width := null;
    new.image_height := null;
  end if;
  return new;
end;
$function$;

revoke all on function private.reset_product_image_dimensions() from public, anon, authenticated;

drop trigger if exists products_reset_image_dimensions on public.products;
create trigger products_reset_image_dimensions
  before update of image_path, image_updated_at on public.products
  for each row execute function private.reset_product_image_dimensions();

commit;
