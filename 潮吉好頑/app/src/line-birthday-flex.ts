// 生日優惠券的客戶 LINE 卡片（由 line-notification-messages.ts 轉出，維持原匯入路徑）。
import type { LinePushMessage } from "./line-notification-messages";

function money(value: number) {
  return `NT$${value.toLocaleString("zh-TW")}`;
}

/** Customer-facing birthday coupon card. Keep the plain text as altText so
 * older LINE clients still receive the complete notification content. */
export function buildLineBirthdayFlexMessage(
  storeName: string,
  coupon: { name: string; code: string; discountAmount: number },
  altText: string
): LinePushMessage {
  const row = (label: string, value: string) => ({
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      { type: "text", text: label, color: "#8A8A8A", size: "sm", flex: 3, wrap: true },
      { type: "text", text: value || "-", color: "#3D3D3D", size: "sm", weight: "bold", flex: 7, wrap: true }
    ]
  });
  return {
    type: "flex",
    altText: altText.slice(0, 1500),
    contents: {
      type: "bubble",
      size: "mega",
      styles: {
        header: { backgroundColor: "#06C755" },
        body: { backgroundColor: "#FFFFFF" },
        footer: { backgroundColor: "#F3F3F3" }
      },
      header: {
        type: "box",
        layout: "horizontal",
        paddingAll: "18px",
        contents: [
          { type: "text", text: "官方帳號個人服務通知", color: "#FFFFFF", size: "lg", weight: "bold", flex: 1, wrap: true },
          { type: "text", text: "🔔", color: "#FFFFFF", size: "lg", flex: 0, align: "end" }
        ]
      },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        spacing: "md",
        contents: [
          { type: "text", text: "生日優惠通知", color: "#333333", size: "xl", weight: "bold", wrap: true },
          { type: "text", text: `${storeName}祝您生日快樂！`, color: "#555555", size: "md", margin: "md", wrap: true },
          { type: "separator", margin: "lg", color: "#E5E5E5" },
          row("優惠券", coupon.name.slice(0, 120)),
          row("優惠碼", coupon.code.slice(0, 80)),
          row("折抵金額", money(coupon.discountAmount))
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          { type: "text", text: "結帳時輸入優惠碼即可使用。", color: "#8A8A8A", size: "sm", align: "center", wrap: true }
        ]
      }
    }
  };
}
