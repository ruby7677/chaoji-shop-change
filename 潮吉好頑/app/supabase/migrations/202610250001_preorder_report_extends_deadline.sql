-- 預購訂單回報匯款後，付款期限與庫存保留延長為「回報起 12 小時」，讓管理員有時間核對款項。
-- 之前預購單建單只給 2 小時，客人在期限尾端回報時管理員常來不及確認，已匯款的訂單被排程自動取消。
-- 1. submit_order_payment：訂單含預購品項時，回報成功把 payment_deadline 設為 greatest(原期限, now() + 12 小時)；
--    現貨訂單的期限不變（建單就是 24 小時）。回報時期限已過仍不可回報（ORDER_NOT_PAYABLE），其餘條件與 202609100001 相同。
-- 2. sync_order_reservation_lifecycle：轉為待核對時，保留量到期時間改為訂單的付款期限（原本取 least，延長期限後不會跟著延長）。
--    正常情況保留量到期時間本來就等於付款期限，現貨訂單行為不變；其餘規則與 202609140001 相同。
-- cancel_expired_orders 照舊依 payment_deadline 取消待付款與待核對的訂單，不需修改。

create or replace function public.submit_order_payment(
  p_order_id uuid,
  p_bank_account_id uuid,
  p_payment_last_five text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if p_payment_last_five !~ '^[0-9]{5}$' then raise exception 'INVALID_PAYMENT_LAST_FIVE'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then
    raise exception 'INVALID_BANK_ACCOUNT';
  end if;

  update public.orders o
     set bank_account_id = p_bank_account_id,
         payment_last_five = p_payment_last_five,
         status = 'pending_review',
         payment_deadline = case
           when exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.kind = 'preorder')
             then greatest(o.payment_deadline, now() + interval '12 hours')
           else o.payment_deadline
         end,
         updated_at = now()
   where o.id = p_order_id
     and o.member_id = auth.uid()
     and o.status = 'pending_payment'
     and o.payment_deadline > now();

  if not found then raise exception 'ORDER_NOT_PAYABLE'; end if;
  return true;
end;
$$;

create or replace function public.sync_order_reservation_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deadline timestamptz;
begin
  if tg_op = 'INSERT' then
    select o.payment_deadline
      into v_deadline
    from public.orders o
    where o.id = new.order_id
      and o.status in ('pending_payment', 'pending_review');
    if v_deadline is not null then
      new.expires_at := v_deadline;
    end if;
    return new;
  end if;

  if new.status = 'pending_review' and old.status is distinct from new.status then
    update public.inventory_reservations
       set expires_at = new.payment_deadline
     where order_id = new.id and released_at is null;
  elsif new.status in ('confirmed', 'cancelled') and old.status is distinct from new.status then
    update public.inventory_reservations
       set released_at = coalesce(released_at, current_timestamp)
     where order_id = new.id and released_at is null;
  end if;
  return new;
end;
$$;
