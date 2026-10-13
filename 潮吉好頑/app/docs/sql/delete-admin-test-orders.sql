-- 潮吉好頑：刪除「目前管理員（profiles.is_admin = true）名下」的測試訂單與相關紀錄。
-- 在 Supabase Dashboard → SQL Editor 執行。庫存不回補：product_variants.stock_on_hand 維持現值。
--
-- 會刪除（只限這些訂單）：
--   orders，以及 ON DELETE CASCADE 一併刪除的 order_items、order_status_history、inventory_reservations
--   inventory_movements（庫存異動紀錄；刪除不會改動目前庫存）
--   point_ledger（這些訂單產生的點數入帳／折抵；管理員的點數餘額會跟著扣回）
--   coupon_redemptions（優惠券使用紀錄）
--   notification_deliveries（event_key 第二段是訂單 id 的 LINE／Telegram 通知紀錄）
-- 不會刪除：audit_logs（設計上不可修改／刪除）、商品、會員資料、庫存數量。
--
-- 使用方式：
--   1. 先只執行「步驟 1」確認要刪的訂單清單與筆數。
--   2. 確認無誤後執行「步驟 2」的 DO 區塊（單一語句，任何一步失敗會整筆還原）。
--      開頭會檢查訂單數不超過 v_max_orders，避免管理員名下有正式訂單時誤刪。
--   3. 執行「步驟 3」確認已清空。

-- ───────────────────────── 步驟 1：預覽（唯讀） ─────────────────────────
select o.order_number, o.status, o.created_at at time zone 'Asia/Taipei' as created_taipei, p.full_name as admin_name,
       (select count(*) from public.order_items i where i.order_id = o.id) as items,
       (select count(*) from public.point_ledger l where l.order_id = o.id) as point_rows,
       (select count(*) from public.notification_deliveries d where split_part(d.event_key, ':', 2) = o.id::text) as notification_rows
  from public.orders o
  join public.profiles p on p.id = o.member_id
 where p.is_admin
 order by o.created_at;

-- ───────────────────────── 步驟 2：刪除（單一 DO 區塊；任何一步失敗整筆還原） ─────────────────────────
do $$
declare
  v_max_orders constant integer := 10;  -- 預覽確認後的上限；管理員名下訂單比這個多就中止
  v_ids uuid[];
  v_count integer;
begin
  select coalesce(array_agg(o.id), '{}') into v_ids
    from public.orders o
    join public.profiles p on p.id = o.member_id
   where p.is_admin;
  v_count := cardinality(v_ids);
  if v_count = 0 then raise exception '管理員名下沒有訂單，未刪除任何資料'; end if;
  if v_count > v_max_orders then
    raise exception '管理員名下有 % 筆訂單，超過上限 %；請先用步驟 1 確認後再調整 v_max_orders', v_count, v_max_orders;
  end if;

  delete from public.notification_deliveries d where split_part(d.event_key, ':', 2) = any (select x::text from unnest(v_ids) x);
  delete from public.coupon_redemptions r where r.order_id = any (v_ids);
  delete from public.point_ledger l where l.order_id = any (v_ids);
  delete from public.inventory_movements m where m.order_id = any (v_ids);
  -- order_items、order_status_history、inventory_reservations 由 ON DELETE CASCADE 一併刪除
  delete from public.orders o where o.id = any (v_ids);
  raise notice '已刪除 % 筆管理員測試訂單', v_count;
end $$;

-- ───────────────────────── 步驟 3：確認（唯讀，應為 0） ─────────────────────────
select count(*) as admin_orders_left
  from public.orders o
  join public.profiles p on p.id = o.member_id
 where p.is_admin;
