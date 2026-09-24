-- Phase 10: revoke only the obsolete eight-argument delivery RPC.
-- The current Worker calls the ten-argument overload with recipient fields;
-- authenticated access to that active overload remains required.
begin;

revoke execute on function public.create_delivery_order(
  jsonb, text, text, text, integer, uuid, text, text
) from authenticated;

commit;
