-- 潮吉好頑：收緊公開 schema 內部函式的執行權限。
-- 不改變會員下單、付款回報或管理員 API 的既有流程。

begin;

-- 管理員判斷函式只需要被登入會員的 RLS policy 呼叫，匿名訪客不應直接執行。
revoke execute on function public.current_user_is_admin() from public, anon;
grant execute on function public.current_user_is_admin() to authenticated;

-- Auth trigger 專用函式不應成為 Data API RPC 入口。
revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;

-- 新訂單已固定將運費交由客服到貨後通知；相容函式保留但不開放前台呼叫。
revoke execute on function public.calculate_shipping_fee(text, integer) from public, anon, authenticated;

commit;
