-- 潮吉好頑：移除已無呼叫者的舊版 RPC。
-- create_pending_order（最早的下單 RPC）與 create_discounted_order（優惠券／點數版）已由
-- create_delivery_order 取代；先前只撤銷 API 角色權限，函式本體仍在，且沒有任何 Worker、
-- 前端、資料庫函式、排程或 view 引用。
-- admin_create_product 的 13／14／15 參數舊 overload 已撤銷全部 API 角色 execute；
-- Worker 以 16 個具名參數呼叫，只對應最新版（後 3 個參數有預設值）。
-- 注意：8 參數 create_delivery_order 不是舊版，而是 10 參數版呼叫的核心實作，必須保留。
-- 使用預設 RESTRICT：若仍有物件依賴這些函式，migration 會失敗而不是連帶刪除。

begin;

drop function if exists public.create_pending_order(jsonb, text, integer, integer, uuid, text);
drop function if exists public.create_discounted_order(jsonb, text, text, integer, uuid, text);
drop function if exists public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean
);
drop function if exists public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer
);
drop function if exists public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer, boolean
);

commit;
