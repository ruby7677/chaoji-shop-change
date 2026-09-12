/**
 * LINE 通知文案集中設定區
 *
 * 日後要調整 LINE 顯示文字時，優先修改這個檔案，再重新部署 Worker。
 * ${...} 會由程式帶入訂單、會員或優惠券的即時資料，請保留這些欄位。
 */

export const LINE_NOTIFICATION_COPY = {
  test: {
    title: "LINE 通知測試成功",
    timeLabel: "測試時間",
    note: "這是一則由管理後台發出的測試訊息。"
  },
  order: {
    titles: {
      created: "訂單已建立",
      payment_reported: "會員已回報匯款",
      fulfillment_updated: "到貨／尾款資訊更新"
    },
    statusPrefix: "訂單狀態更新：",
    labels: {
      order: "訂單",
      items: "商品",
      delivery: "取貨方式",
      payment: "付款方式",
      deliveryNote: "配送說明",
      total: "訂單金額",
      deposit: "訂金"
    },
    storeDeliveryNote: "到店取貨免運",
    remoteDeliveryNote: "運費到貨後由客服通知，尾款與運費確認後安排寄出",
    storeFulfillment: "到店取貨，尾款於取貨時確認",
    remoteShippingLabel: "實際運費",
    remoteShippingPending: "待客服通知",
    remoteBalanceLabel: "尾款／運費",
    remoteBalanceConfirmed: "已確認入帳",
    remoteBalancePending: "尚未確認"
  },
  lowStock: {
    title: "低庫存提醒（統一通知）",
    bullet: "• "
  },
  birthday: {
    greeting: "生日快樂！",
    coupon: "您收到優惠券",
    code: "優惠碼",
    discount: "折抵"
  }
} as const;

export type LineOrderEventType = "created" | "payment_reported" | "status_changed" | "fulfillment_updated";

type OrderMessageData = {
  storeName: string;
  eventType: LineOrderEventType;
  statusLabel: string;
  orderNumber: string;
  items: string;
  deliveryLine: string;
  paymentLine: string;
  deliveryNote: string;
  amountDue: number;
  depositDue: number;
  fulfillmentLine: string;
};

function money(value: number) {
  return `NT$${value.toLocaleString("zh-TW")}`;
}

export function buildLineTestMessage(storeName: string, timestamp: string) {
  const copy = LINE_NOTIFICATION_COPY.test;
  return [storeName, copy.title, `${copy.timeLabel}：${timestamp}`, copy.note].join("\n");
}

export function buildOrderNotificationMessage(data: OrderMessageData) {
  const copy = LINE_NOTIFICATION_COPY.order;
  const title = data.eventType === "status_changed" ? `${copy.statusPrefix}${data.statusLabel}` : copy.titles[data.eventType];
  return [
    data.storeName,
    title,
    `${copy.labels.order}：${data.orderNumber}`,
    `${copy.labels.items}：${data.items || "-"}`,
    `${copy.labels.delivery}：${data.deliveryLine}`,
    `${copy.labels.payment}：${data.paymentLine}`,
    `${copy.labels.deliveryNote}：${data.deliveryNote}`,
    `${copy.labels.total}：${money(data.amountDue)}`,
    `${copy.labels.deposit}：${money(data.depositDue)}`,
    data.fulfillmentLine
  ].join("\n");
}

export function buildLowStockMessage(storeName: string, lines: string[]) {
  const copy = LINE_NOTIFICATION_COPY.lowStock;
  return [storeName, copy.title, ...lines.map((line) => `${copy.bullet}${line}`)].join("\n");
}

export function buildBirthdayCouponMessage(storeName: string, coupon: { name: string; code: string; discountAmount: number }) {
  const copy = LINE_NOTIFICATION_COPY.birthday;
  return [
    storeName,
    copy.greeting,
    `${copy.coupon}：${coupon.name}`,
    `${copy.code}：${coupon.code}`,
    `${copy.discount}：${money(coupon.discountAmount)}`
  ].join("\n");
}

