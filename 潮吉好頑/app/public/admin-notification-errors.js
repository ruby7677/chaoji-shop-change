// 通知寄送失敗訊息的白話說明（純函式）：Worker 存的是「LINE 429: …」「Telegram network: …」這類原始訊息，
// 後台改顯示原因與下一步，原始訊息仍保留給除錯。格式來源：src/notification-delivery.ts。
const PATTERN = /^(LINE|Telegram)\s+(network|\d{3})\s*:\s*([\s\S]*)$/i;

function explain(channel, code) {
  const status = Number(code);
  if (code === "network") return { reason: `連不上 ${channel}（網路逾時或中斷）`, hint: "系統會自動重試，通常不需處理。" };
  if (status === 429 && channel === "LINE") return { reason: "LINE 本月訊息額度已用完，或短時間內發送太多", hint: "額度重置或升級 LINE 方案後，按「重新排入」再送一次。" };
  if (status === 429) return { reason: "Telegram 限制發送頻率", hint: "系統會自動重試，通常不需處理。" };
  if (status === 401 || status === 403) {
    return channel === "LINE"
      ? { reason: "LINE 拒絕授權（權杖失效或權限不足）", hint: "檢查 LINE Messaging API 的 channel access token 設定。" }
      : { reason: "Telegram 拒絕授權（bot token 失效，或機器人被封鎖、移出群組）", hint: "檢查 bot token 與管理員的 chat id。" };
  }
  if (status === 400) return { reason: `${channel} 拒絕這則訊息（收件人或內容格式不正確）`, hint: "確認收件人仍是好友或仍在群組；重送前先查看原始訊息。" };
  if (status >= 500) return { reason: `${channel} 服務暫時故障`, hint: "系統會自動重試，通常不需處理。" };
  return { reason: `${channel} 回傳錯誤 ${status}`, hint: "" };
}

// 回傳 { reason, hint, raw }；無法辨識的格式原樣顯示在 reason
export function describeDeliveryError(message) {
  const raw = String(message || "").trim();
  if (!raw) return { reason: "無錯誤訊息", hint: "", raw: "" };
  const match = raw.match(PATTERN);
  if (!match) return { reason: raw, hint: "", raw };
  const channel = match[1].toLowerCase() === "line" ? "LINE" : "Telegram";
  return { ...explain(channel, match[2].toLowerCase()), raw };
}
