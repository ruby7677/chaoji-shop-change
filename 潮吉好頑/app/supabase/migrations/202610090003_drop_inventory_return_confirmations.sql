-- 潮吉好頑：移除不再使用的退貨驗收資料表。
-- 退貨驗收在 202610030001_remove_refund_flow 已移除（admin_confirm_order_return 已刪），資料表當時保留歷史紀錄；
-- 正式資料庫確認 0 筆、沒有函式或 view 引用，唯一的關聯是 inventory_movements.return_confirmation_id（全為空值）。
-- 若仍有資料或有異動指向它就中止，不靜默刪除紀錄。

begin;

do $migration$
begin
  if exists (select 1 from public.inventory_return_confirmations)
     or exists (select 1 from public.inventory_movements where return_confirmation_id is not null) then
    raise exception 'inventory_return_confirmations still has data; export it before dropping';
  end if;
end;
$migration$;

drop index if exists public.inventory_movements_return_confirmation_idx;
alter table public.inventory_movements drop column if exists return_confirmation_id;
drop table if exists public.inventory_return_confirmations;

commit;
