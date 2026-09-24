-- 交易測試共用工具：固定測試資料、切換呼叫身分與斷言。
-- 每個測試案例在自己的 begin … rollback 內呼叫 tests.seed()，案例之間互不影響，也不留下資料。

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- 固定 ID，測試檔以 tests.id('…') 取用，避免在 SQL 內硬寫 UUID。
create or replace function tests.id(p_name text) returns uuid
language sql immutable
as $$
  select case p_name
    when 'admin'          then '00000000-0000-4000-8000-000000000001'
    when 'member_a'       then '00000000-0000-4000-8000-000000000002'
    when 'member_b'       then '00000000-0000-4000-8000-000000000003'
    when 'member_no_line' then '00000000-0000-4000-8000-000000000004'
    when 'category'       then '00000000-0000-4000-8000-0000000000c1'
    when 'product_stock'  then '00000000-0000-4000-8000-0000000000a1'
    when 'product_pre'    then '00000000-0000-4000-8000-0000000000a2'
    when 'variant_stock'  then '00000000-0000-4000-8000-0000000000b1'
    when 'variant_pre'    then '00000000-0000-4000-8000-0000000000b2'
    when 'bank'           then '00000000-0000-4000-8000-0000000000d1'
  end::uuid
$$;

-- 測試資料：管理員、兩位已完成資料且已驗證 LINE 好友的會員、一位未驗證好友的會員，
-- 現貨商品（1,000 元、庫存 5）、預購商品（2,000 元、訂金 50%、庫存 10）與一個收款帳戶。
create or replace function tests.seed() returns void
language plpgsql
as $$
declare
  v_line_suffix text;
  v_name text;
begin
  foreach v_name in array array['admin', 'member_a', 'member_b', 'member_no_line'] loop
    insert into auth.users(id, email) values (tests.id(v_name), v_name || '@test.local');
    v_line_suffix := lpad(right(replace(tests.id(v_name)::text, '-', ''), 2), 32, '0');
    update public.profiles
       set full_name = '測試 ' || v_name,
           phone = '0912345678',
           line_user_id = 'U' || v_line_suffix,
           line_friend_verified_at = case when v_name = 'member_no_line' then null else now() end,
           is_admin = (v_name = 'admin')
     where id = tests.id(v_name);
  end loop;

  insert into public.categories(id, name) values (tests.id('category'), '測試分類');
  insert into public.products(id, name, category_id, is_published)
  values (tests.id('product_stock'), '現貨測試商品', tests.id('category'), true),
         (tests.id('product_pre'), '預購測試商品', tests.id('category'), true);
  insert into public.product_variants(id, product_id, name, sku, kind, price, stock_on_hand, deposit_rate, is_published)
  values (tests.id('variant_stock'), tests.id('product_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, 5, 0, true),
         (tests.id('variant_pre'), tests.id('product_pre'), '單一規格', 'TEST-PRE', 'preorder', 2000, 10, 0.5, true);
  insert into public.bank_accounts(id, label, bank_name, account_name, account_number, is_active)
  values (tests.id('bank'), '測試帳戶', '測試銀行', '潮吉好頑', '12345678901', true);
end;
$$;

-- 以會員身分呼叫（等同 PostgREST 帶該會員 JWT）；p_user 為 null 代表未登入的 anon。
create or replace function tests.login(p_user uuid) returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then '{"role":"anon"}' else json_build_object('sub', p_user, 'role', 'authenticated')::text end,
    true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
end;
$$;

-- 以 Worker 的 service_role 身分呼叫（管理 RPC 只授權給它）。
create or replace function tests.as_service() returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end;
$$;

-- 管理員透過 Worker 變更訂單狀態。
create or replace function tests.transition(p_order uuid, p_status text, p_note text default null) returns jsonb
language sql
as $$ select public.admin_transition_order(tests.id('admin'), p_order, p_status::public.order_status, p_note) $$;

create or replace function tests.point_balance(p_member uuid) returns integer
language sql stable security definer set search_path = ''
as $$ select coalesce(sum(points), 0)::integer from public.point_ledger where member_id = p_member $$;

-- 回到測試管理者（postgres）身分，用來準備資料或檢查結果。
create or replace function tests.logout() returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end;
$$;

create or replace function tests.assert(p_condition boolean, p_label text) returns void
language plpgsql
as $$
begin
  if p_condition is distinct from true then
    raise exception 'ASSERTION FAILED: %', p_label;
  end if;
end;
$$;

-- 執行 p_sql，必須失敗且錯誤訊息包含 p_expected。失敗的語句在子交易中回滾，
-- 呼叫端接著檢查資料沒有殘留，就能驗證交易整體回滾。
create or replace function tests.expect_error(p_sql text, p_expected text, p_label text) returns void
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    execute p_sql;
  exception when others then
    v_message := sqlerrm;
  end;
  if v_message is null then
    raise exception 'ASSERTION FAILED: % — expected error "%" but statement succeeded', p_label, p_expected;
  end if;
  if position(p_expected in v_message) = 0 then
    raise exception 'ASSERTION FAILED: % — expected error "%" but got "%"', p_label, p_expected, v_message;
  end if;
end;
$$;

-- 以會員身分建立到店取貨、匯款的訂單（呼叫者需先 tests.login）。
create or replace function tests.order_items(p_variant uuid, p_quantity integer) returns jsonb
language sql immutable
as $$ select jsonb_build_array(jsonb_build_object('variant_id', p_variant, 'quantity', p_quantity)) $$;

create or replace function tests.place_order(p_variant uuid, p_quantity integer) returns uuid
language sql
as $$
  select public.create_delivery_order(
    tests.order_items(p_variant, p_quantity), 'together', 'store_pickup', null, 0,
    tests.id('bank'), null, null, null, null)
$$;

create or replace function tests.available(p_variant uuid) returns integer
language sql stable security definer set search_path = ''
as $$ select private.storefront_available_stock(p_variant) $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
