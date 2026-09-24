-- 潮吉好頑：訂單編號 CJ-YYMMDD-HHMMSS 改用台灣時間（原本依資料庫 UTC，台灣早上 9 點的單顯示 01xxxx）。
-- 下單核心只有訂單編號用 to_char(now()) 轉成文字；付款期限以 now() + 固定小時（預購 2 小時、現貨 24 小時）
-- 或 3 個月計算，時區不影響其絕對時間。以函式層級設定 timezone，不需重寫整支函式；其他函式與排程不受影響。
-- 注意：日後以 create or replace 重新定義此函式時必須保留 set timezone（verify_schema.sql 會檢查）。

begin;

alter function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text)
  set timezone to 'Asia/Taipei';

commit;
