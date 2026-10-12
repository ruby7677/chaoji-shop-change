-- 儲值金：管理員加值／退款／調整／沖正、防重送、餘額不得為負、帳本不可修改，以及會員與 API 角色的權限邊界。

-- 加值：餘額、帳本、稽核紀錄在同一交易寫入，帳戶餘額等於帳本加總。
begin;
select tests.seed();
select tests.as_service();
select tests.assert(
  (public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 3000, '匯款儲值', '00000000-0000-4000-8000-00000000f001', '10/12 末五碼 12345')->>'balance')::integer = 3000,
  'top-up returns the new balance');
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'adjust', -500, '人工調整', '00000000-0000-4000-8000-00000000f002');
select tests.logout();
select tests.assert((select balance = 2500 from public.wallet_accounts where member_id = tests.id('member_a')), 'balance reflects both entries');
select tests.assert((select sum(amount) = 2500 and count(*) = 2 from public.wallet_ledger where member_id = tests.id('member_a')), 'ledger sum equals the balance');
select tests.assert((select balance_after = 2500 and actor_id = tests.id('admin') from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f002'), 'ledger keeps balance_after and the actor');
select tests.assert((select count(*) = 2 from public.audit_logs where resource = 'member_wallet' and target = tests.id('member_a')::text), 'each change writes an audit log');
select tests.as_service();
select tests.assert(
  jsonb_array_length(public.backup_snapshot()->'tables'->'wallet_ledger') = 2
  and jsonb_array_length(public.backup_snapshot()->'tables'->'wallet_accounts') = 1,
  'the weekly backup includes wallet accounts and ledger');
rollback;

-- 餘額不得為負：退款或調整超過餘額時整筆失敗，帳戶與帳本都不變。
begin;
select tests.seed();
select tests.as_service();
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 1000, '匯款儲值', '00000000-0000-4000-8000-00000000f011');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'refund', -1001, '退款', '00000000-0000-4000-8000-00000000f012')$$,
  'WALLET_BALANCE_SHORT', 'refund cannot exceed the balance');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_b'), 'adjust', -1, '扣款', '00000000-0000-4000-8000-00000000f013')$$,
  'WALLET_BALANCE_SHORT', 'a member without a wallet cannot go negative');
select tests.logout();
select tests.assert((select balance = 1000 from public.wallet_accounts where member_id = tests.id('member_a')), 'failed refund leaves the balance unchanged');
select tests.assert((select count(*) = 1 from public.wallet_ledger), 'failed changes leave no ledger rows');
select tests.expect_error($$update public.wallet_accounts set balance = -1 where member_id = tests.id('member_a')$$, 'wallet_accounts_balance_check', 'the table itself rejects a negative balance');
rollback;

-- 輸入檢查：種類、正負號、金額上限、原因與 request_id。
begin;
select tests.seed();
select tests.as_service();
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', -100, '錯誤', '00000000-0000-4000-8000-00000000f021')$$, 'WALLET_AMOUNT_INVALID', 'top-up must be positive');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'refund', 100, '錯誤', '00000000-0000-4000-8000-00000000f022')$$, 'WALLET_AMOUNT_INVALID', 'refund must be negative');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'adjust', 0, '錯誤', '00000000-0000-4000-8000-00000000f023')$$, 'WALLET_AMOUNT_INVALID', 'zero is rejected');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 1000001, '錯誤', '00000000-0000-4000-8000-00000000f024')$$, 'WALLET_AMOUNT_INVALID', 'amount has an upper bound');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'draw', -100, '錯誤', '00000000-0000-4000-8000-00000000f025')$$, 'WALLET_KIND_INVALID', 'admins cannot write draw entries');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 100, '   ', '00000000-0000-4000-8000-00000000f026')$$, 'WALLET_NOTE_MISSING', 'reason is required');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 100, '儲值', null)$$, 'WALLET_REQUEST_ID_MISSING', 'request id is required');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('member_a'), tests.id('member_a'), 'topup', 100, '自己加值', '00000000-0000-4000-8000-00000000f027')$$, 'ADMIN_REQUIRED', 'a member id cannot act as admin');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), '00000000-0000-4000-8000-0000000000ff', 'topup', 100, '儲值', '00000000-0000-4000-8000-00000000f028')$$, 'MEMBER_NOT_FOUND', 'unknown member is rejected');
rollback;

-- 防重送：同一 request_id 重送回傳原結果不重複入帳；參數不同則拒絕。
begin;
select tests.seed();
select tests.as_service();
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 2000, '匯款儲值', '00000000-0000-4000-8000-00000000f031');
select tests.assert(
  (public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 2000, '匯款儲值', '00000000-0000-4000-8000-00000000f031')->>'replayed')::boolean,
  'a replay is reported as replayed');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 3000, '匯款儲值', '00000000-0000-4000-8000-00000000f031')$$,
  'WALLET_REQUEST_REUSED', 'the same request id with a different amount is rejected');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_b'), 'topup', 2000, '匯款儲值', '00000000-0000-4000-8000-00000000f031')$$,
  'WALLET_REQUEST_REUSED', 'the same request id for another member is rejected');
select tests.logout();
select tests.assert((select balance = 2000 from public.wallet_accounts where member_id = tests.id('member_a')), 'the replay did not credit twice');
select tests.assert((select count(*) = 1 from public.wallet_ledger), 'only one ledger row exists');
rollback;

-- 沖正：以反向紀錄抵銷原紀錄；同一筆只能沖正一次，不能沖正沖正紀錄，也不能讓餘額變負。
begin;
select tests.seed();
select tests.as_service();
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 1500, '誤加值', '00000000-0000-4000-8000-00000000f041');
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 500, '匯款儲值', '00000000-0000-4000-8000-00000000f042');
select tests.assert(
  (public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f041'), '重複加值', '00000000-0000-4000-8000-00000000f043')->>'balance')::integer = 500,
  'reversal subtracts the original amount');
select tests.assert(
  (public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f041'), '重複加值', '00000000-0000-4000-8000-00000000f043')->>'replayed')::boolean,
  'a reversal replay returns the original result');
select tests.expect_error($$select public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f041'), '再沖一次', '00000000-0000-4000-8000-00000000f044')$$,
  'WALLET_ALREADY_REVERSED', 'an entry can be reversed only once');
select tests.expect_error($$select public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f043'), '沖正沖正', '00000000-0000-4000-8000-00000000f045')$$,
  'WALLET_REVERSAL_INVALID', 'a reversal cannot be reversed');
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'refund', -400, '退款', '00000000-0000-4000-8000-00000000f046');
select tests.expect_error($$select public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger where request_id = '00000000-0000-4000-8000-00000000f042'), '撤銷儲值', '00000000-0000-4000-8000-00000000f047')$$,
  'WALLET_BALANCE_SHORT', 'reversing a spent top-up cannot make the balance negative');
select tests.expect_error($$select public.admin_reverse_wallet_entry(tests.id('admin'), '00000000-0000-4000-8000-0000000000ff', '不存在', '00000000-0000-4000-8000-00000000f048')$$,
  'WALLET_ENTRY_NOT_FOUND', 'unknown entries are rejected');
select tests.logout();
select tests.assert((select balance = 100 from public.wallet_accounts where member_id = tests.id('member_a')), 'balance after top-ups, reversal and refund');
select tests.assert((select sum(amount) = 100 from public.wallet_ledger where member_id = tests.id('member_a')), 'ledger sum still equals the balance');
rollback;

-- 帳本不可修改：連擁有者也被觸發器擋下；service_role 沒有寫入權限。
begin;
select tests.seed();
select tests.as_service();
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 1000, '匯款儲值', '00000000-0000-4000-8000-00000000f051');
select tests.expect_error($$update public.wallet_ledger set amount = 9999$$, 'permission denied', 'service role cannot update the ledger');
select tests.expect_error($$delete from public.wallet_ledger$$, 'permission denied', 'service role cannot delete the ledger');
select tests.expect_error($$update public.wallet_accounts set balance = 9999$$, 'permission denied', 'service role cannot change balances directly');
select tests.expect_error($$insert into public.wallet_ledger(member_id, kind, amount, balance_after, reason) values (tests.id('member_a'), 'topup', 1, 1, 'x')$$, 'permission denied', 'service role cannot insert ledger rows');
select tests.logout();
select tests.expect_error($$update public.wallet_ledger set amount = 9999$$, 'WALLET_LEDGER_IMMUTABLE', 'the owner cannot update the ledger');
select tests.expect_error($$delete from public.wallet_ledger$$, 'WALLET_LEDGER_IMMUTABLE', 'the owner cannot delete the ledger');
rollback;

-- 會員：只能讀自己的餘額與紀錄，看不到操作者與 request_id；不能寫入，也不能呼叫管理函式。
begin;
select tests.seed();
select tests.as_service();
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 800, '匯款儲值', '00000000-0000-4000-8000-00000000f061');
select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_b'), 'topup', 300, '匯款儲值', '00000000-0000-4000-8000-00000000f062');
select tests.login(tests.id('member_a'));
select tests.assert(public.member_wallet_balance() = 800, 'member reads own balance');
select tests.assert((select count(*) = 1 and bool_and(member_id = tests.id('member_a')) from public.wallet_ledger), 'member sees only own ledger rows');
select tests.assert((select count(*) = 1 and bool_and(balance = 800) from public.wallet_accounts), 'member sees only own account');
select tests.expect_error($$select actor_id from public.wallet_ledger$$, 'permission denied', 'member cannot see the acting admin');
select tests.expect_error($$select request_id from public.wallet_ledger$$, 'permission denied', 'member cannot see request ids');
select tests.expect_error($$insert into public.wallet_ledger(member_id, kind, amount, balance_after, reason) values (tests.id('member_a'), 'topup', 1, 801, 'x')$$, 'permission denied', 'member cannot insert ledger rows');
select tests.expect_error($$update public.wallet_accounts set balance = 99999$$, 'permission denied', 'member cannot change the balance');
select tests.expect_error($$select public.admin_adjust_wallet(tests.id('admin'), tests.id('member_a'), 'topup', 5000, '冒用', '00000000-0000-4000-8000-00000000f063')$$, 'permission denied', 'member cannot call the admin top-up even with the admin id');
select tests.expect_error($$select public.admin_reverse_wallet_entry(tests.id('admin'), (select id from public.wallet_ledger limit 1), '冒用', '00000000-0000-4000-8000-00000000f064')$$, 'permission denied', 'member cannot call the reversal');
select tests.login(tests.id('member_b'));
select tests.assert(public.member_wallet_balance() = 300, 'another member reads only their own balance');
select tests.login(tests.id('member_no_line'));
select tests.assert(public.member_wallet_balance() = 0, 'a member without a wallet reads zero');
select tests.login(null);
select tests.expect_error($$select public.member_wallet_balance()$$, 'permission denied', 'anon cannot read a balance');
select tests.expect_error($$select count(*) from public.wallet_ledger$$, 'permission denied', 'anon cannot read the ledger');
rollback;
