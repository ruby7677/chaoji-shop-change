-- 會員點數餘額必須由完整帳本計算；近期 100 筆僅供 UI 顯示。

begin;

create or replace function public.member_point_balance()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_member_id uuid := auth.uid();
  v_balance integer;
begin
  if v_member_id is null then
    raise exception 'LOGIN_REQUIRED';
  end if;

  select coalesce(sum(pl.points), 0)::integer
    into v_balance
    from public.point_ledger pl
   where pl.member_id = v_member_id;

  return v_balance;
end;
$function$;

revoke all on function public.member_point_balance() from public, anon;
grant execute on function public.member_point_balance() to authenticated;

comment on function public.member_point_balance() is
  '以 auth.uid() 限定目前會員，從完整 point_ledger 計算可用點數；不受前端近期紀錄筆數限制';

commit;
