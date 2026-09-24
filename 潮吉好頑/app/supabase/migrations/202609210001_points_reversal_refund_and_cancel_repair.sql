-- 取消／退款時退回訂單已使用的會員點數。
-- 只新增增量修正；不改訂單狀態轉移、付款、庫存或兌換資格。

begin;

create or replace function public.apply_points_from_order_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_earn_amount integer;
  v_eligible_item_subtotal integer;
  v_points integer;
  v_redeem_points integer := 0;
  v_earned_points integer := 0;
  v_reversal_target integer := 0;
  v_existing_reversal_id uuid;
  v_reversal_reason text;
begin
  select * into v_order
    from public.orders
   where id = new.order_id;
  if not found then return new; end if;

  if new.to_status = 'completed' and new.from_status <> 'completed' then
    select earn_amount_per_point
      into v_earn_amount
      from public.point_settings
     where id = true;
    if v_earn_amount is null or v_earn_amount <= 0 then return new; end if;

    select coalesce(sum(oi.unit_price * oi.quantity) filter (where oi.points_eligible_snapshot), 0)::integer
      into v_eligible_item_subtotal
      from public.order_items oi
     where oi.order_id = v_order.id;

    v_points := floor(greatest(
      v_eligible_item_subtotal
      - coalesce(v_order.coupon_discount, 0)
      - coalesce(v_order.point_discount, 0),
      0
    )::numeric / v_earn_amount)::integer;

    if v_points > 0 then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'earn', v_points, '完成訂單 ' || v_order.order_number || ' 自動入點', new.actor_id)
      on conflict (order_id) where kind = 'earn' and order_id is not null do nothing;
    end if;
  elsif new.to_status in ('cancelled', 'refunded') then
    -- The reversal row is the single consolidated correction for this order.
    -- Never include a previous reversal in the target calculation: re-running
    -- the transition must converge to the same ledger balance.
    select
      coalesce(sum(pl.points) filter (where pl.kind = 'redeem'), 0)::integer,
      coalesce(sum(pl.points) filter (where pl.kind = 'earn'), 0)::integer
      into v_redeem_points, v_earned_points
      from public.point_ledger pl
     where pl.order_id = v_order.id;

    if new.to_status = 'cancelled' then
      -- redeem entries are negative; return them as positive points.
      v_reversal_target := -v_redeem_points;
      v_reversal_reason := '取消訂單 ' || v_order.order_number || ' 退回使用點數';
    else
      -- A refund returns redeemed points and reverses points previously earned.
      v_reversal_target := -(v_redeem_points + v_earned_points);
      v_reversal_reason := '退款訂單 ' || v_order.order_number || ' 合併退回折抵與扣回已賺點數';
    end if;

    select pl.id
      into v_existing_reversal_id
      from public.point_ledger pl
     where pl.order_id = v_order.id
       and pl.kind = 'reversal'
     for update;

    if v_reversal_target = 0 then
      -- point_ledger forbids zero-point rows; remove only a stale consolidated
      -- reversal so the order's net ledger balance remains exact.
      if v_existing_reversal_id is not null then
        delete from public.point_ledger where id = v_existing_reversal_id;
      end if;
    elsif v_existing_reversal_id is null then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'reversal', v_reversal_target, v_reversal_reason, new.actor_id)
      on conflict (order_id) where kind = 'reversal' and order_id is not null do update
        set points = excluded.points,
            reason = excluded.reason,
            actor_id = coalesce(excluded.actor_id, point_ledger.actor_id);
    else
      update public.point_ledger
         set points = v_reversal_target,
             reason = v_reversal_reason,
             actor_id = coalesce(new.actor_id, actor_id)
       where id = v_existing_reversal_id;
    end if;
  end if;

  return new;
end;
$function$;

-- 既有取消訂單的一次性修復：只處理有 redeem、且尚無 reversal 的訂單。
-- unique partial index + NOT EXISTS 讓 migration 可安全重跑。
insert into public.point_ledger(member_id, order_id, kind, points, reason)
select
  o.member_id,
  o.id,
  'reversal',
  -sum(pl.points)::integer,
  '取消訂單歷史修復退回使用點數'
from public.orders o
join public.point_ledger pl on pl.order_id = o.id and pl.kind = 'redeem'
where o.status = 'cancelled'
  and not exists (
    select 1
      from public.point_ledger existing
     where existing.order_id = o.id
       and existing.kind = 'reversal'
  )
group by o.id, o.member_id
having sum(pl.points) < 0
on conflict (order_id) where kind = 'reversal' and order_id is not null do nothing;

revoke all on function public.apply_points_from_order_history() from public, anon, authenticated;

commit;
