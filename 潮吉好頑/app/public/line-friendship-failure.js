// 好友檢查失敗的原因：網站登入過期（先換發再試）、需要重新 LINE 登入（LINE 授權過期、缺少或不一致），其餘為暫時故障
export const FRIENDSHIP_SESSION_EXPIRED = "session-expired";
export const FRIENDSHIP_LINE_RELOGIN = "line-relogin";
// /api/member/line-friendship 的 401 code 與 200 回應的 reason（src/member-api.ts）
const LINE_RELOGIN_CODES = new Set(["LINE_LOGIN_EXPIRED", "LINE_IDENTITY_MISMATCH"]);
const LINE_RELOGIN_REASONS = new Set(["LINE_PROVIDER_TOKEN_REQUIRED", "LINE_ID_MISSING"]);

export function lineFriendshipFailureKind(status, result = {}) {
  if (status === 401 && LINE_RELOGIN_CODES.has(result.code)) return FRIENDSHIP_LINE_RELOGIN;
  if (status === 401) return FRIENDSHIP_SESSION_EXPIRED;
  // requireUser 的 403：不是 LINE 會員登入
  if (status === 403) return FRIENDSHIP_LINE_RELOGIN;
  if (status === 200 && result.friendFlag !== true && LINE_RELOGIN_REASONS.has(result.reason)) return FRIENDSHIP_LINE_RELOGIN;
  return null;
}
