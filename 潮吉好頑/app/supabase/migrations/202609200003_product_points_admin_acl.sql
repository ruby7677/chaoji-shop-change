-- 新版管理員商品 RPC 只允許 Worker service_role 呼叫。
revoke all on function public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind,
  integer, integer, text, numeric, text, boolean, integer, boolean
) from public, anon, authenticated;
grant execute on function public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind,
  integer, integer, text, numeric, text, boolean, integer, boolean
) to service_role;
