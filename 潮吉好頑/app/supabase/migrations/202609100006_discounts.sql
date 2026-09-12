-- 潮吉好頑：固定金額優惠券、生日券、點數折抵與安全結帳。
-- 前置需求：202609100005_product_images.sql。
-- 可重複執行。

begin;

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  discount_amount integer not null check (discount_amount > 0),
  combinable_with_points boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  total_usage_limit integer check (total_usage_limit is null or total_usage_limit > 0),
  per_member_limit integer not null default 1 check (per_member_limit > 0),
  is_active boolean not null default true,
  is_birthday boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until > valid_from),
  check (code = upper(code) and code ~ '^[A-Z0-9_-]{3,32}$')
);

create table if not exists public.coupon_products (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  primary key (coupon_id, product_id)
);

create table if not exists public.coupon_members (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  primary key (coupon_id, member_id)
);

create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  member_id uuid not null references public.profiles(id) on delete restrict,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  discount_amount integer not null check (discount_amount > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.birthday_coupon_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  discount_amount integer not null default 100 check (discount_amount > 0),
  issue_days_before integer not null default 7 check (issue_days_before between 0 and 60),
  valid_days integer not null default 30 check (valid_days between 1 and 365),
  combinable_with_points boolean not null default false,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.birthday_coupon_settings(id) values (true) on conflict (id) do nothing;

create table if not exists public.birthday_coupon_issues (
  member_id uuid not null references public.profiles(id) on delete cascade,
  birthday_year integer not null,
  coupon_id uuid not null unique references public.coupons(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (member_id, birthday_year)
);

alter table public.orders add column if not exists coupon_id uuid references public.coupons(id) on delete set null;
alter table public.orders add column if not exists points_redeemed integer not null default 0 check (points_redeemed >= 0);

create unique index if not exists point_ledger_one_redeem_per_order
  on public.point_ledger(order_id) where kind = 'redeem' and order_id is not null;
create index if not exists coupon_redemptions_usage_idx on public.coupon_redemptions(coupon_id, member_id);

alter table public.coupons enable row level security;
alter table public.coupon_products enable row level security;
alter table public.coupon_members enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.birthday_coupon_settings enable row level security;
alter table public.birthday_coupon_issues enable row level security;

drop policy if exists "members view assigned coupons" on public.coupon_members;
create policy "members view assigned coupons" on public.coupon_members for select using (member_id = auth.uid());
drop policy if exists "members view own coupon redemptions" on public.coupon_redemptions;
create policy "members view own coupon redemptions" on public.coupon_redemptions for select using (member_id = auth.uid());

create or replace function public.reject_unverified_order_discounts()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.coupon_discount <> 0 or new.point_discount <> 0)
     and coalesce(current_setting('app.verified_discount', true), '') <> 'on'
  then raise exception 'DISCOUNTS_NOT_VERIFIED'; end if;
  return new;
end;
$$;

create or replace function public.admin_save_coupon(
  p_actor_id uuid, p_coupon_id uuid, p_code text, p_name text, p_discount_amount integer,
  p_combinable boolean, p_valid_from timestamptz, p_valid_until timestamptz,
  p_total_usage_limit integer, p_per_member_limit integer, p_is_active boolean,
  p_product_ids uuid[], p_member_ids uuid[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := p_coupon_id; v_code text := upper(trim(p_code));
begin
  if not exists(select 1 from public.profiles where id=p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_code !~ '^[A-Z0-9_-]{3,32}$' or nullif(trim(p_name),'') is null then raise exception 'INVALID_COUPON'; end if;
  if p_discount_amount <= 0 or p_valid_until <= p_valid_from or p_per_member_limit <= 0
     or (p_total_usage_limit is not null and p_total_usage_limit <= 0) then raise exception 'INVALID_COUPON'; end if;
  if v_id is null then
    insert into public.coupons(code,name,discount_amount,combinable_with_points,valid_from,valid_until,total_usage_limit,per_member_limit,is_active,created_by)
    values(v_code,trim(p_name),p_discount_amount,p_combinable,p_valid_from,p_valid_until,p_total_usage_limit,p_per_member_limit,p_is_active,p_actor_id)
    returning id into v_id;
  else
    update public.coupons set code=v_code,name=trim(p_name),discount_amount=p_discount_amount,
      combinable_with_points=p_combinable,valid_from=p_valid_from,valid_until=p_valid_until,
      total_usage_limit=p_total_usage_limit,per_member_limit=p_per_member_limit,is_active=p_is_active,updated_at=now()
    where id=v_id and not is_birthday;
    if not found then raise exception 'COUPON_NOT_FOUND'; end if;
    delete from public.coupon_products where coupon_id=v_id;
    delete from public.coupon_members where coupon_id=v_id;
  end if;
  insert into public.coupon_products(coupon_id,product_id) select v_id,unnest(coalesce(p_product_ids,'{}'::uuid[])) on conflict do nothing;
  insert into public.coupon_members(coupon_id,member_id) select v_id,unnest(coalesce(p_member_ids,'{}'::uuid[])) on conflict do nothing;
  return v_id;
exception when unique_violation then raise exception 'COUPON_CODE_EXISTS';
end;
$$;

create or replace function public.admin_update_birthday_coupon_settings(
  p_actor_id uuid,p_enabled boolean,p_discount_amount integer,p_issue_days_before integer,
  p_valid_days integer,p_combinable boolean
) returns public.birthday_coupon_settings language plpgsql security definer set search_path=public as $$
declare v_result public.birthday_coupon_settings;
begin
  if not exists(select 1 from public.profiles where id=p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_discount_amount<=0 or p_issue_days_before not between 0 and 60 or p_valid_days not between 1 and 365 then raise exception 'INVALID_BIRTHDAY_SETTINGS'; end if;
  update public.birthday_coupon_settings set enabled=p_enabled,discount_amount=p_discount_amount,
    issue_days_before=p_issue_days_before,valid_days=p_valid_days,combinable_with_points=p_combinable,
    updated_by=p_actor_id,updated_at=now() where id=true returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.issue_birthday_coupons()
returns integer language plpgsql security definer set search_path=public as $$
declare s public.birthday_coupon_settings; m record; v_coupon uuid; v_year integer; v_today date; v_count integer:=0;
begin
  select * into s from public.birthday_coupon_settings where id=true;
  if not s.enabled then return 0; end if;
  v_today := (now() at time zone 'Asia/Taipei')::date;
  v_year := extract(year from v_today)::integer;
  for m in select id,birthday from public.profiles where birthday is not null
    and to_char(birthday,'MM-DD')=to_char(v_today+s.issue_days_before,'MM-DD')
  loop
    if not exists(select 1 from public.birthday_coupon_issues where member_id=m.id and birthday_year=v_year) then
      insert into public.coupons(code,name,discount_amount,combinable_with_points,valid_from,valid_until,total_usage_limit,per_member_limit,is_active,is_birthday)
      values('BDAY'||v_year||upper(substr(replace(m.id::text,'-',''),1,8)),v_year||' 生日禮券',s.discount_amount,s.combinable_with_points,now(),now()+(s.valid_days||' days')::interval,1,1,true,true)
      returning id into v_coupon;
      insert into public.coupon_members(coupon_id,member_id) values(v_coupon,m.id);
      insert into public.birthday_coupon_issues(member_id,birthday_year,coupon_id) values(m.id,v_year,v_coupon);
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;

create or replace function public.member_available_coupons()
returns table(id uuid,code text,name text,discount_amount integer,combinable_with_points boolean,valid_until timestamptz)
language sql stable security definer set search_path=public as $$
  select c.id,c.code,c.name,c.discount_amount,c.combinable_with_points,c.valid_until
  from public.coupons c join public.coupon_members cm on cm.coupon_id=c.id
  where cm.member_id=auth.uid() and c.is_active and now() between c.valid_from and c.valid_until
    and (c.total_usage_limit is null or (select count(*) from public.coupon_redemptions r where r.coupon_id=c.id)<c.total_usage_limit)
    and (select count(*) from public.coupon_redemptions r where r.coupon_id=c.id and r.member_id=auth.uid())<c.per_member_limit
  order by c.valid_until;
$$;

create or replace function public.create_discounted_order(
  p_items jsonb,
  p_pickup_plan text default 'together',
  p_coupon_code text default null,
  p_points_to_redeem integer default 0,
  p_bank_account_id uuid default null,
  p_payment_last_five text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_member_id uuid:=auth.uid(); v_order_id uuid:=gen_random_uuid();
  v_order_number text:='CJ-'||to_char(now(),'YYMMDD-HH24MISS')||'-'||upper(substr(replace(v_order_id::text,'-',''),1,4));
  v_subtotal integer:=0; v_deposit integer:=0; v_coupon_eligible integer:=0;
  v_coupon_discount integer:=0; v_point_discount integer:=0; v_amount integer;
  v_item record; v_variant record; v_available integer; v_coupon public.coupons; v_settings public.point_settings;
  v_balance integer; v_point_cap integer;
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if not exists(select 1 from public.profiles where id=v_member_id and nullif(trim(full_name),'') is not null and nullif(trim(phone),'') is not null) then raise exception 'PROFILE_INCOMPLETE'; end if;
  if p_pickup_plan not in ('together','split') then raise exception 'INVALID_PICKUP_PLAN'; end if;
  if coalesce(p_points_to_redeem,0)<0 then raise exception 'INVALID_POINTS'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'EMPTY_CART'; end if;
  if p_bank_account_id is null or not exists(select 1 from public.bank_accounts where id=p_bank_account_id and is_active) then raise exception 'BANK_ACCOUNT_REQUIRED'; end if;
  if p_payment_last_five is not null and p_payment_last_five !~ '^[0-9]{5}$' then raise exception 'INVALID_PAYMENT_LAST_FIVE'; end if;

  if nullif(upper(trim(coalesce(p_coupon_code,''))),'') is not null then
    select * into v_coupon from public.coupons where code=upper(trim(p_coupon_code)) for update;
    if not found then raise exception 'COUPON_NOT_FOUND'; end if;
    if not v_coupon.is_active or now()<v_coupon.valid_from or now()>v_coupon.valid_until then raise exception 'COUPON_EXPIRED'; end if;
    if exists(select 1 from public.coupon_members where coupon_id=v_coupon.id)
       and not exists(select 1 from public.coupon_members where coupon_id=v_coupon.id and member_id=v_member_id) then raise exception 'COUPON_NOT_ELIGIBLE'; end if;
    if v_coupon.total_usage_limit is not null and (select count(*) from public.coupon_redemptions where coupon_id=v_coupon.id)>=v_coupon.total_usage_limit then raise exception 'COUPON_USAGE_LIMIT'; end if;
    if (select count(*) from public.coupon_redemptions where coupon_id=v_coupon.id and member_id=v_member_id)>=v_coupon.per_member_limit then raise exception 'COUPON_MEMBER_LIMIT'; end if;
  end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid,quantity integer) loop
    if v_item.quantity is null or v_item.quantity<1 then raise exception 'INVALID_QUANTITY'; end if;
    select v.*,p.name as product_name,p.id as parent_product_id into v_variant
      from public.product_variants v join public.products p on p.id=v.product_id
      where v.id=v_item.variant_id and v.is_published and p.is_published for update of v;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    select v_variant.stock_on_hand-coalesce(sum(r.quantity) filter(where r.released_at is null and r.expires_at>now()),0)
      into v_available from public.inventory_reservations r where r.variant_id=v_variant.id;
    if v_available<v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
    v_subtotal:=v_subtotal+v_variant.price*v_item.quantity;
    v_deposit:=v_deposit+case when v_variant.kind='in_stock' and v_variant.deposit_rate=0 then v_variant.price*v_item.quantity else round(v_variant.price*v_item.quantity*v_variant.deposit_rate) end;
    if v_coupon.id is not null and (not exists(select 1 from public.coupon_products where coupon_id=v_coupon.id)
       or exists(select 1 from public.coupon_products where coupon_id=v_coupon.id and product_id=v_variant.parent_product_id))
    then v_coupon_eligible:=v_coupon_eligible+v_variant.price*v_item.quantity; end if;
  end loop;

  if v_coupon.id is not null then
    if v_coupon_eligible=0 then raise exception 'COUPON_PRODUCT_NOT_ELIGIBLE'; end if;
    v_coupon_discount:=least(v_coupon.discount_amount,v_coupon_eligible);
  end if;

  if coalesce(p_points_to_redeem,0)>0 then
    if v_coupon.id is not null and not v_coupon.combinable_with_points then raise exception 'COUPON_POINTS_NOT_COMBINABLE'; end if;
    select * into v_settings from public.point_settings where id=true;
    if p_points_to_redeem<v_settings.min_redeem_points then raise exception 'POINT_MINIMUM'; end if;
    perform pg_advisory_xact_lock(hashtext(v_member_id::text));
    select coalesce(sum(points),0) into v_balance from public.point_ledger where member_id=v_member_id;
    if p_points_to_redeem>v_balance then raise exception 'INSUFFICIENT_POINTS'; end if;
    v_point_discount:=p_points_to_redeem*v_settings.point_value;
    v_point_cap:=case when v_settings.max_redeem_mode='percent'
      then floor((v_subtotal-v_coupon_discount)*v_settings.max_redeem_value/100.0)::integer
      else v_settings.max_redeem_value end;
    v_point_cap:=least(v_point_cap,v_subtotal-v_coupon_discount);
    if v_point_discount>v_point_cap then raise exception 'POINT_LIMIT_EXCEEDED'; end if;
  end if;

  v_amount:=greatest(v_subtotal-v_coupon_discount-v_point_discount,0);
  v_deposit:=least(greatest(v_deposit-v_coupon_discount-v_point_discount,0),v_amount);
  perform set_config('app.verified_discount','on',true);
  insert into public.orders(id,order_number,member_id,status,pickup_plan,subtotal,coupon_discount,point_discount,amount_due,deposit_due,payment_deadline,bank_account_id,payment_last_five,coupon_id,points_redeemed)
  values(v_order_id,v_order_number,v_member_id,case when p_payment_last_five is null then 'pending_payment'::public.order_status else 'pending_review'::public.order_status end,
    p_pickup_plan,v_subtotal,v_coupon_discount,v_point_discount,v_amount,v_deposit,now()+interval '24 hours',p_bank_account_id,p_payment_last_five,v_coupon.id,coalesce(p_points_to_redeem,0));

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid,quantity integer) loop
    select v.*,p.name as product_name into v_variant from public.product_variants v join public.products p on p.id=v.product_id where v.id=v_item.variant_id;
    insert into public.order_items(order_id,variant_id,product_name,variant_name,unit_price,quantity,kind,deposit_rate,arrival_snapshot)
    values(v_order_id,v_variant.id,v_variant.product_name,v_variant.name,v_variant.price,v_item.quantity,v_variant.kind,v_variant.deposit_rate,v_variant.preorder_arrival);
    insert into public.inventory_reservations(variant_id,order_id,quantity,expires_at) values(v_variant.id,v_order_id,v_item.quantity,now()+interval '24 hours');
  end loop;
  if v_coupon.id is not null then insert into public.coupon_redemptions(coupon_id,member_id,order_id,discount_amount) values(v_coupon.id,v_member_id,v_order_id,v_coupon_discount); end if;
  if coalesce(p_points_to_redeem,0)>0 then insert into public.point_ledger(member_id,order_id,kind,points,reason) values(v_member_id,v_order_id,'redeem',-p_points_to_redeem,'訂單 '||v_order_number||' 點數折抵'); end if;
  return v_order_id;
end;
$$;

revoke all on function public.admin_save_coupon(uuid,uuid,text,text,integer,boolean,timestamptz,timestamptz,integer,integer,boolean,uuid[],uuid[]) from public,anon,authenticated;
grant execute on function public.admin_save_coupon(uuid,uuid,text,text,integer,boolean,timestamptz,timestamptz,integer,integer,boolean,uuid[],uuid[]) to service_role;
revoke all on function public.admin_update_birthday_coupon_settings(uuid,boolean,integer,integer,integer,boolean) from public,anon,authenticated;
grant execute on function public.admin_update_birthday_coupon_settings(uuid,boolean,integer,integer,integer,boolean) to service_role;
revoke all on function public.issue_birthday_coupons() from public,anon,authenticated;
revoke all on function public.member_available_coupons() from public,anon;
grant execute on function public.member_available_coupons() to authenticated;
revoke all on function public.create_discounted_order(jsonb,text,text,integer,uuid,text) from public,anon;
grant execute on function public.create_discounted_order(jsonb,text,text,integer,uuid,text) to authenticated;

commit;

select cron.unschedule(jobid) from cron.job where jobname='chaoji-issue-birthday-coupons';
select cron.schedule('chaoji-issue-birthday-coupons','0 1 * * *',$$select public.issue_birthday_coupons();$$);
