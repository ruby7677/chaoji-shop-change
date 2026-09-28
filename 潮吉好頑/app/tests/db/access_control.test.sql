-- 存取權限：會員只看得到自己的訂單與資料、不能自行升級管理員或改 LINE 綁定、不能碰內部表；稽核紀錄不可修改。

-- 會員資料隔離：A 看不到 B 的訂單、明細與個人資料。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 1);
select tests.login(tests.id('member_b'));
select tests.place_order(tests.id('variant_stock'), 1);
select tests.assert((select count(*) = 1 and bool_and(member_id = tests.id('member_b')) from public.orders), 'B sees only B''s order');
select tests.assert((select count(*) = 1 from public.order_items), 'B sees only B''s order items');
select tests.assert((select count(*) = 1 and bool_and(id = tests.id('member_b')) from public.profiles), 'B sees only B''s profile');
select tests.login(tests.id('member_a'));
select tests.assert((select count(*) = 1 and bool_and(member_id = tests.id('member_a')) from public.orders), 'A sees only A''s order');
rollback;

-- 未登入訪客：看不到會員資料與訂單，只能讀公開型錄。
begin;
select tests.seed();
select tests.login(null);
select tests.expect_error($$select count(*) from public.orders$$, 'permission denied', 'anon cannot read orders');
select tests.expect_error($$select count(*) from public.profiles$$, 'permission denied', 'anon cannot read profiles');
select tests.assert((select count(*) = 2 from public.storefront_variants where is_published), 'anon can read the published catalog');
rollback;

-- 公開型錄底層表只開放前台用到的欄位：成本、SKU、安全庫存與實際庫存不能用 anon key 直接查。
-- 以整列讀取 storefront_variants：view 新增欄位卻漏了底層欄位授權時，這裡會失敗。
begin;
select tests.seed();
update public.product_variants set cost = 600 where id = tests.id('variant_stock');
select tests.login(null);
select tests.assert((select count(*) = 2 and bool_and(to_jsonb(v) ? 'hero_tagline' and v.stock is not null) from public.storefront_variants v),
                    'anon can read every storefront column');
select tests.assert((select count(*) = 2 from public.product_variants where is_published and price > 0), 'anon can still read public variant columns');
select tests.expect_error($$select cost from public.product_variants$$, 'permission denied', 'anon cannot read variant cost');
select tests.expect_error($$select sku from public.product_variants$$, 'permission denied', 'anon cannot read SKUs');
select tests.expect_error($$select stock_on_hand from public.product_variants$$, 'permission denied', 'anon cannot read raw stock');
select tests.expect_error($$select safety_stock from public.product_variants$$, 'permission denied', 'anon cannot read safety stock');
select tests.expect_error($$select * from public.product_variants$$, 'permission denied', 'anon cannot select every variant column');
select tests.expect_error($$select * from public.products$$, 'permission denied', 'new product columns are private by default');
select tests.login(tests.id('member_a'));
select tests.expect_error($$select cost from public.product_variants$$, 'permission denied', 'members cannot read variant cost');
select tests.assert((select count(*) = 2 from public.storefront_variants), 'members can read the catalog');
select public.replace_member_cart(tests.order_items(tests.id('variant_stock'), 2));
select tests.assert((select count(*) = 1 and bool_and(quantity = 2) from public.member_cart_items), 'cart sync still validates published variants');
select tests.as_service();
select tests.assert((select cost = 600 and sku = 'TEST-STOCK' from public.product_variants where id = tests.id('variant_stock')),
                    'the Worker service role still reads every column');
rollback;

-- 點數紀錄：會員以自己的 JWT 只讀得到本人的紀錄與前台欄位；操作管理員 actor_id 不公開，也不能自行寫入。
begin;
select tests.seed();
insert into public.point_ledger(member_id, kind, points, reason, actor_id) values
  (tests.id('member_a'), 'manual', 30, 'A 的點數', tests.id('admin')),
  (tests.id('member_b'), 'manual', 50, 'B 的點數', tests.id('admin'));
select tests.login(tests.id('member_a'));
select tests.assert((select count(*) = 1 and bool_and(member_id = tests.id('member_a') and points = 30)
                       from (select id, member_id, order_id, kind, points, reason, created_at from public.point_ledger) l),
                    'a member reads only their own point entries');
select tests.expect_error($$select actor_id from public.point_ledger$$, 'permission denied', 'the acting admin is not exposed');
select tests.expect_error($$insert into public.point_ledger(member_id, kind, points, reason) values (tests.id('member_a'), 'manual', 999, 'x')$$,
                          'permission denied', 'a member still cannot grant points');
select tests.expect_error($$update public.point_ledger set points = 999$$, 'permission denied', 'a member cannot edit point entries');
select tests.expect_error($$delete from public.point_ledger$$, 'permission denied', 'a member cannot delete point entries');
select tests.login(null);
select tests.expect_error($$select id from public.point_ledger$$, 'permission denied', 'anon cannot read point entries');
rollback;

-- 個人資料：只能改自己的姓名／電話／生日／地址；不能改管理員標記或 LINE 綁定，也改不到別人。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
update public.profiles set full_name = '新名字' where id = tests.id('member_a');
select tests.expect_error($$update public.profiles set is_admin = true where id = tests.id('member_a')$$, 'permission denied', 'member cannot promote self');
select tests.expect_error($$update public.profiles set line_user_id = 'U00000000000000000000000000000099' where id = tests.id('member_a')$$,
                          'permission denied', 'member cannot rebind LINE id');
select tests.expect_error($$update public.profiles set line_friend_verified_at = now() where id = tests.id('member_a')$$,
                          'permission denied', 'member cannot fake LINE friendship');
update public.profiles set full_name = '改別人' where id = tests.id('member_b');
select tests.logout();
select tests.assert((select full_name = '新名字' and not is_admin from public.profiles where id = tests.id('member_a')), 'own name changed, still not admin');
select tests.assert((select full_name = '測試 member_b' from public.profiles where id = tests.id('member_b')), 'another member''s profile is untouched');
rollback;

-- 會員不能繞過 RPC 直接寫訂單、庫存或點數，也不能讀內部表。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
select tests.expect_error(format($$update public.orders set status = 'confirmed' where id = %L$$, (select id from t_order)),
                          'permission denied', 'member cannot change order status');
select tests.expect_error(format($$update public.orders set amount_due = 1 where id = %L$$, (select id from t_order)),
                          'permission denied', 'member cannot change the amount due');
select tests.expect_error($$insert into public.orders(order_number, member_id, subtotal, amount_due, deposit_due, payment_deadline)
                            values ('X', tests.id('member_a'), 0, 0, 0, now())$$, 'permission denied', 'member cannot insert orders directly');
select tests.expect_error($$update public.product_variants set stock_on_hand = 999$$, 'permission denied', 'member cannot edit stock');
select tests.expect_error($$insert into public.point_ledger(member_id, kind, points, reason) values (tests.id('member_a'), 'manual', 999, 'x')$$,
                          'permission denied', 'member cannot grant points');
select tests.expect_error($$select count(*) from public.liff_session_vault$$, 'permission denied', 'member cannot read the LIFF session vault');
select tests.expect_error($$select count(*) from public.notification_deliveries$$, 'permission denied', 'member cannot read notification deliveries');
select tests.expect_error($$select count(*) from public.audit_logs$$, 'permission denied', 'member cannot read audit logs');
select tests.expect_error($$select count(*) from public.bank_accounts$$, 'permission denied', 'member cannot read bank accounts directly');
select tests.logout();
select tests.assert((select status = 'pending_payment' and amount_due = 1000 from public.orders where id = (select id from t_order)), 'order is unchanged');
rollback;

-- 折扣只能由建單 RPC 驗證後寫入：即使以資料庫擁有者身分直接改折扣也會被 trigger 擋下。
-- 建單 RPC 以交易範圍的 app.verified_discount 放行；PostgREST 每個請求是獨立交易，這裡重置它模擬下一個請求。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
select tests.logout();
select set_config('app.verified_discount', '', true);
select tests.expect_error(format($$update public.orders set point_discount = 100 where id = %L$$, (select id from t_order)),
                          'DISCOUNTS_NOT_VERIFIED', 'unverified discount is rejected');
rollback;

-- 稽核紀錄不可修改或刪除：擁有者被 trigger 擋下，service_role 連 DELETE 權限都沒有。
begin;
select tests.seed();
select public.append_audit_log(tests.id('admin'), 'update', 'product', tests.id('product_stock')::text, '{}'::jsonb, '{"name":"x"}'::jsonb);
select tests.expect_error($$update public.audit_logs set action = 'delete'$$, 'AUDIT_LOG_IMMUTABLE', 'audit rows cannot be updated');
select tests.expect_error($$delete from public.audit_logs$$, 'AUDIT_LOG_IMMUTABLE', 'audit rows cannot be deleted');
select tests.as_service();
select tests.expect_error($$delete from public.audit_logs$$, 'permission denied', 'service_role has no delete privilege on audit rows');
select tests.logout();
select tests.assert((select count(*) = 1 from public.audit_logs), 'audit row is still there');
rollback;
