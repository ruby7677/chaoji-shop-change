// LINE 登入回呼錯誤（#error／#error_code）轉成給會員看的訊息；純函式，供 auth-return-state.js 與測試共用。
// Supabase 擋下登入時也回 error=access_denied，但會帶 error_code（例如關閉註冊時的 signup_disabled）；
// 只有沒有 error_code 的 access_denied 才是會員在 LINE 同意畫面按了取消。
const ERROR_CODE_MESSAGES = {
  signup_disabled: "目前暫停新會員註冊，請聯絡客服",
  user_banned: "此帳號已停用，請聯絡客服"
};

/** 回傳錯誤訊息；回呼沒有錯誤時回傳 null。 */
export function authReturnErrorMessage(fragment) {
  const error = fragment.get("error");
  if (!error) return null;
  const code = fragment.get("error_code");
  if (code && ERROR_CODE_MESSAGES[code]) return ERROR_CODE_MESSAGES[code];
  if (error === "access_denied" && !code) return "你已取消 LINE 登入";
  return "LINE 登入未完成，請稍後再試";
}
