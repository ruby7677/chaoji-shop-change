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
    status: {
      created: "待確認中",
      paymentReported: "會員已回報匯款",
      depositConfirmed: "已確認收到訂金",
      arrived: "已到貨，待付尾款出貨",
      shipping: "已確認收到尾款，出貨中",
      completed: "已完成"
    },
    labels: {
      order: "訂單編號",
      status: "訂單狀態",
      items: "商品",
      delivery: "取貨方式",
      payment: "付款方式",
      deliveryNote: "配送說明",
      total: "總金額",
      deposit: "訂金",
      balance: "尾款／運費",
      totalBalance: "總計尾款",
      recipient: "姓名",
      phone: "電話",
      address: "地址",
      recipientHeading: "收件資訊確認"
    },
    payment: {
      bankPending: "匯款／轉帳後、待客服確認通知",
      storePending: "到店支付後、待客服確認通知"
    },
    delivery: {
      remoteBalancePending: "待到貨後通知",
      genericBalancePending: "待到貨後客服通知",
      sellerBalancePending: "尾款待到貨後通知；賣貨便運費由 7-11 收取",
      arrivalNote: "到貨由客服通知補尾款後出貨",
      sellerNote: "到貨由客服通知補尾款後寄出；賣貨便運費由 7-11 於取貨時收取",
      storeBalance: "到店確認",
      storeNote: "到貨通知後到店取貨，尾款於取貨時確認"
    }
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
  orderStatus: string;
  statusLabel: string;
  orderNumber: string;
  items: string;
  deliveryLine: string;
  paymentLine: string;
  amountDue: number;
  depositDue: number;
  paidAmount: number;
  shippingFee: number;
  finalPaymentConfirmed: boolean;
  shippingRecipientName?: string | null;
  shippingPhone?: string | null;
  shippingAddress?: string | null;
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
  const isRemote = data.deliveryLine !== "到店取貨";
  const isHomeDelivery = data.deliveryLine === "宅配";
  const isPaymentReported = data.eventType === "payment_reported";
  const isDepositConfirmed = data.eventType === "status_changed" && data.orderStatus === "confirmed";
  const isArrival = (data.eventType === "fulfillment_updated" && !data.finalPaymentConfirmed)
    || (data.eventType === "status_changed" && ["partially_ready", "ready_for_pickup"].includes(data.orderStatus));
  const balance = Math.max(data.amountDue - data.paidAmount, 0);
  const productLine = `${copy.labels.items}：${data.items || "-"}`;
  const orderHeader = [
    data.storeName,
    `${copy.labels.order}：${data.orderNumber}`,
    `${copy.labels.status}：${copy.status.created}`,
    ""
  ];

  if (data.eventType === "created") {
    return [
      ...orderHeader,
      productLine,
      `${copy.labels.total}：${money(data.amountDue)}`,
      `${copy.labels.deposit}：${money(data.depositDue)}`,
      `${copy.labels.payment}：${data.paymentLine === "到店支付" ? copy.payment.storePending : copy.payment.bankPending}`
    ].join("\n");
  }

  if (data.finalPaymentConfirmed && isRemote) {
    return [
      data.storeName,
      `${copy.labels.order}：${data.orderNumber}`,
      `${copy.labels.status}：${copy.status.shipping}`,
      "",
      productLine
    ].join("\n");
  }

  if (isArrival && isRemote) {
    const tailAmount = Math.max(balance - data.shippingFee, 0);
    const isSellerDelivery = data.deliveryLine === "賣貨便";
    return [
      data.storeName,
      `${copy.labels.order}：${data.orderNumber}`,
      `${copy.labels.status}：${copy.status.arrived}`,
      "",
      productLine,
      `${copy.labels.delivery}：${data.deliveryLine}`,
      isSellerDelivery
        ? `${copy.labels.balance}：尾款${tailAmount.toLocaleString("zh-TW")}元／賣貨便運費由 7-11 收取`
        : `${copy.labels.balance}：尾款${tailAmount.toLocaleString("zh-TW")}元/運費${data.shippingFee.toLocaleString("zh-TW")}元`,
      `${copy.labels.totalBalance}：${(isSellerDelivery ? tailAmount : balance).toLocaleString("zh-TW")}元`,
      "",
      copy.labels.recipientHeading,
      `${copy.labels.recipient}：${data.shippingRecipientName || ""}`,
      `${copy.labels.phone}：${data.shippingPhone || ""}`,
      `${copy.labels.address}：${data.shippingAddress || ""}`
    ].join("\n");
  }

  if (isPaymentReported || isDepositConfirmed) {
    const depositStatus = isDepositConfirmed ? copy.status.depositConfirmed : copy.status.paymentReported;
    if (isHomeDelivery) {
      return [
        data.storeName,
        `${copy.labels.order}：${data.orderNumber}`,
        `${copy.labels.status}：${depositStatus}`,
        "",
        productLine,
        `${copy.labels.delivery}：${data.deliveryLine}`,
        `${copy.labels.balance}：${copy.delivery.remoteBalancePending}`,
        `${copy.labels.deliveryNote}：`,
        copy.delivery.arrivalNote
      ].join("\n");
    }
    return [
      data.storeName,
      `${copy.labels.order}：${data.orderNumber}`,
      `${copy.labels.status}：${depositStatus}`,
      "",
      `${copy.labels.delivery}：${data.deliveryLine}`,
      `${copy.labels.balance}：${isRemote ? (data.deliveryLine === "賣貨便" ? copy.delivery.sellerBalancePending : copy.delivery.genericBalancePending) : copy.delivery.storeBalance}`,
      `${copy.labels.deliveryNote}：`,
      isRemote ? (data.deliveryLine === "賣貨便" ? copy.delivery.sellerNote : copy.delivery.arrivalNote) : copy.delivery.storeNote
    ].join("\n");
  }

  return [
    data.storeName,
    `${copy.labels.order}：${data.orderNumber}`,
    `${copy.labels.status}：${data.statusLabel || data.orderStatus}`,
    "",
    productLine,
    `${copy.labels.delivery}：${data.deliveryLine}`,
    `${copy.labels.balance}：${isRemote ? (data.deliveryLine === "賣貨便" ? copy.delivery.sellerBalancePending : copy.delivery.genericBalancePending) : copy.delivery.storeBalance}`
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
