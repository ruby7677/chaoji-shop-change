-- 潮吉好頑：清理兩項已無作用的資料庫物件（2026-09-28 唯讀盤點後確認）。
--
-- 1. shipping_settings_legacy：202609110003 移除運費計算時由 shipping_settings 改名保留。
--    之後沒有任何函式、view、排程、Worker 或前端引用，也沒有外鍵指向它。
--    刪除前唯一一筆設定留底：宅配大件 250、宅配小件 150、賣貨便 38、
--    宅配大件上限 8 件、宅配小件上限 3 件（updated_at 2026-09-10 17:57:20 UTC）。
--
-- 2. point_ledger 的 "deny api roles"（ALL、using false）：202609250005 新增
--    "members view own point ledger" 後，兩條 permissive policy 以 OR 合併，這條不再擋任何查詢，
--    只讓 Supabase Advisor 回報 multiple_permissive_policies。實際限制仍由欄位級 grants 保證：
--    authenticated 只能 SELECT 前台 7 個欄位（不含 actor_id），anon 無任何權限，
--    寫入只能經由 SECURITY DEFINER 函式；刪除後 INSERT／UPDATE／DELETE 仍無 grant 也無 policy。

begin;

drop table if exists public.shipping_settings_legacy;

drop policy if exists "deny api roles" on public.point_ledger;

commit;
