// 把訂單通知純文字（Telegram 與 LINE altText 共用的同一份文案）拆成 LINE Flex 可用的列，
// 讓 LINE 卡片逐行呈現與 Telegram 相同的內容，不另寫一份容易漏行的版本。

export type NotificationTextRows = {
  /** 「訂單狀態：」後的文字，含「私訊小幫手…」等客戶需要的指示 */
  status: string | null;
  /** 「標籤：內容」格式的列，順序與文字訊息相同 */
  rows: Array<{ label: string; value: string }>;
  /** 沒有標籤的說明文字（例：預購付訂期限提醒），保留原順序 */
  notes: string[];
};

const LABELED_LINE = /^([^：\n]{1,12})：(.+)$/;

export function parseOrderNotificationText(text: string, statusLabel: string, skipLabels: string[]): NotificationTextRows {
  const result: NotificationTextRows = { status: null, rows: [], notes: [] };
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  // 第一行是【店名選物】標題，LINE 卡片已有自己的標題
  for (const line of lines.slice(1)) {
    const match = line.match(LABELED_LINE);
    if (match && match[1] === statusLabel) { result.status = match[2]; continue; }
    if (match && skipLabels.includes(match[1])) continue;
    if (match) result.rows.push({ label: match[1], value: match[2] });
    else result.notes.push(line);
  }
  return result;
}
