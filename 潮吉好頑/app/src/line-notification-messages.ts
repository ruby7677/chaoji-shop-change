/**
 * 通知文案集中設定區
 *
 * 會員通知由 LINE 發送，管理員通知由 Telegram 發送；兩者共用訂單文案。
 * 日後要調整顯示文字時，優先修改這個檔案，再重新部署 Worker。
 * ${...} 會由程式帶入訂單、會員或優惠券的即時資料，請保留這些欄位。
 */

export const NOTIFICATION_COPY = {
  test: {
    title: "Telegram 管理員通知測試成功",
    timeLabel: "測試時間",
    note: "這是一則由管理後台發出的測試訊息。"
  },
  order: {
    titleSuffix: "選物",
    status: {
      created: "待確認中",
      createdPayment: "待確認付款",
      paymentReported: "會員已回報匯款",
      preorderPaymentReported: "會員已回報付訂",
      storeConfirmed: "已確認訂單付訂完成",
      remoteConfirmed: "已確認訂單付訂完成，待到貨通知",
      sellerStockConfirmed: "已確認訂單，備貨中",
      homeStockConfirmed: "已確認訂單付訂完成，現貨備貨中",
      arrivedStorePreorder: "商品已到貨，私訊小幫手約取貨時間",
      arrivedSellerPreorder: "商品已到貨，私訊小幫手開賣貨便",
      arrivedHome: "商品已到貨，私訊小幫手確認尾款及運費",
      shippedSeller: "已出貨，請留意到貨的簡訊通知",
      shippedHome: "已出貨，請留意貨運的電話／簡訊通知",
      completedPickup: "已完成取貨"
    },
    labels: {
      order: "訂單編號",
      status: "訂單狀態",
      member: "會員名稱",
      items: "商品",
      delivery: "取貨方式",
      shipping: "運費",
      payment: "付款方式",
      deliveryNote: "配送說明",
      total: "總金額",
      deposit: "訂金",
      balance: "尾款／運費",
      totalBalance: "總計尾款",
      remaining: "待付尾款",
      recipient: "姓名",
      phone: "電話",
      address: "地址",
      recipientHeading: "收件資訊確認"
    },
    payment: {
      bank: "匯款／轉帳",
      seller: "賣貨便取貨付款"
    },
    delivery: {
      storeReported: "到店取貨",
      storePreorderReported: "到店取貨付尾款",
      storeConfirmed: "私訊小幫手約時間到店取貨",
      storePreorderArrived: "到店取貨",
      sellerReported: "賣貨便取貨付尾款",
      sellerShipped: "7-11賣貨便",
      home: "宅配寄送",
      preorderNoticeHeading: "預購商品注意事項：",
      preorderNoticeLine: "預購商品報價有時效性，請於訂單成立後2小時內完成付訂",
      preorderNoticeCancel: "否則訂單將自動取消",
      homeShippingPending: "待到貨與尾款一併確認通知",
      homeShippingPendingStock: "私訊小幫手確認"
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

export type OrderNotificationEventType = "created" | "payment_reported" | "status_changed" | "fulfillment_updated";

export function routeOrderNotificationRecipients(
  eventType: OrderNotificationEventType,
  memberLineUserId: string | null | undefined,
  telegramAdminChatIds: string[],
  suppressMemberLineRecipient = false
) {
  return {
    lineRecipients: eventType === "payment_reported" || suppressMemberLineRecipient || !memberLineUserId ? [] : [memberLineUserId],
    telegramRecipients: [...new Set(telegramAdminChatIds.filter(Boolean))]
  };
}

export type OrderMessageData = {
  storeName: string;
  eventType: OrderNotificationEventType;
  orderStatus: string;
  statusLabel: string;
  orderNumber: string;
  items: string;
  deliveryLine: string;
  paymentLine: string;
  hasPreorder: boolean;
  amountDue: number;
  depositDue: number;
  paidAmount: number;
  shippingFee: number;
  finalPaymentConfirmed: boolean;
  shippingRecipientName?: string | null;
  shippingPhone?: string | null;
  shippingAddress?: string | null;
};

/**
 * LINE Messaging API payload for a single push message.
 *
 * Order notifications use a Flex bubble for a richer, card-like presentation;
 * all other notification types continue to use the existing text payload.
 */
export type LinePushMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

function money(value: number) {
  return `NT$${value.toLocaleString("zh-TW")}`;
}

export function buildTelegramTestMessage(storeName: string, timestamp: string) {
  const copy = NOTIFICATION_COPY.test;
  return [storeName, copy.title, `${copy.timeLabel}：${timestamp}`, copy.note].join("\n");
}

export function buildOrderNotificationMessage(data: OrderMessageData): string | null {
  const copy = NOTIFICATION_COPY.order;
  const title = `【${data.storeName}${copy.titleSuffix}】`;
  const isSeller = data.deliveryLine === "賣貨便";
  const isHome = data.deliveryLine === "宅配";
  const isPreorder = data.hasPreorder;
  const productLine = `${copy.labels.items}：${data.items || "-"}`;
  const header = (status: string) => [
    title,
    `${copy.labels.order}：${data.orderNumber}`,
    `${copy.labels.status}：${status}`,
    ""
  ];
  const message = (status: string, lines: string[]) => header(status).concat(lines).join("\n");

  // completed 才代表實際取貨／寄送結案。宅配即使先前已確認尾款與運費，
  // 也必須等管理員執行「確認寄送完成並結束訂單」後才發最後出貨通知。
  if (data.eventType === "status_changed" && data.orderStatus === "completed") {
    if (isSeller) {
      return message(copy.status.shippedSeller, [productLine, `${copy.labels.delivery}：${copy.delivery.sellerShipped}`]);
    }
    if (isHome) {
      return message(copy.status.shippedHome, [productLine, `${copy.labels.delivery}：${copy.delivery.home}`]);
    }
    if (data.deliveryLine !== "到店取貨") return null;
    return message(copy.status.completedPickup, [productLine, `${copy.labels.delivery}：${data.deliveryLine}`]);
  }

  if (data.eventType === "created") {
    const lines = [
      productLine,
      `${copy.labels.total}：${money(data.amountDue)}`,
      ...(isSeller && !isPreorder ? [] : [`${copy.labels.deposit}：${money(data.depositDue)}`]),
      ...(isHome ? [`${copy.labels.shipping}：${isPreorder ? copy.delivery.homeShippingPending : copy.delivery.homeShippingPendingStock}`] : []),
      `${copy.labels.payment}：${isSeller && !isPreorder ? copy.payment.seller : copy.payment.bank}`
    ];
    if (isPreorder) lines.push("", copy.delivery.preorderNoticeHeading, copy.delivery.preorderNoticeLine, copy.delivery.preorderNoticeCancel);
    return message((isSeller || isHome) && !isPreorder ? copy.status.created : copy.status.createdPayment, lines);
  }

  if (data.eventType === "payment_reported") {
    const delivery = isSeller
      ? copy.delivery.sellerReported
      : isHome
        ? copy.delivery.home
        : isPreorder
          ? copy.delivery.storePreorderReported
          : copy.delivery.storeReported;
    return message(isPreorder ? copy.status.preorderPaymentReported : copy.status.paymentReported, [productLine, `${copy.labels.delivery}：${delivery}`]);
  }

  if (data.eventType === "fulfillment_updated" && data.finalPaymentConfirmed && isSeller) {
    return message(copy.status.shippedSeller, [productLine, `${copy.labels.delivery}：${copy.delivery.sellerShipped}`]);
  }

  const isArrival = data.eventType === "fulfillment_updated"
    || (data.eventType === "status_changed" && ["partially_ready", "ready_for_pickup"].includes(data.orderStatus));
  if (isArrival) {
    if (isSeller) {
      if (isPreorder) return message(copy.status.arrivedSellerPreorder, [productLine]);
      if (data.eventType === "status_changed" && data.orderStatus === "ready_for_pickup") {
        return message(copy.status.shippedSeller, [productLine, `${copy.labels.delivery}：${copy.delivery.sellerShipped}`]);
      }
      return null;
    }
    if (isHome) {
      // 儲存尾款／運費只更新付款與配送資料，不代表已寄出，也不重複發到貨通知。
      if (data.eventType === "fulfillment_updated") return null;
      if (!isPreorder) return null;
      return message(copy.status.arrivedHome, [productLine]);
    }
    if (isPreorder) return message(copy.status.arrivedStorePreorder, [productLine, `${copy.labels.delivery}：${copy.delivery.storePreorderArrived}`]);
    return null;
  }

  if (data.eventType === "status_changed" && data.orderStatus === "confirmed") {
    if (isSeller) return message(isPreorder ? copy.status.remoteConfirmed : copy.status.sellerStockConfirmed, [productLine]);
    if (isHome) return message(isPreorder ? copy.status.remoteConfirmed : copy.status.homeStockConfirmed, [productLine]);
    if (isPreorder) return message(copy.status.remoteConfirmed, [productLine]);
    return message(copy.status.storeConfirmed, [productLine, `${copy.labels.delivery}：${copy.delivery.storeConfirmed}`]);
  }

  return message(data.statusLabel || data.orderStatus, [productLine, `${copy.labels.delivery}：${data.deliveryLine}`]);
}

/**
 * Adds the member display name to the administrator-only Telegram copy.
 * Keep the original blank line after the status row so every existing event
 * keeps its layout; LINE customers use the Flex payload and never call this.
 */
export function buildTelegramOrderNotificationMessage(message: string, memberName?: string | null) {
  const lines = message.split("\n");
  const statusPrefix = `${NOTIFICATION_COPY.order.labels.status}：`;
  const statusIndex = lines.findIndex((line) => line.startsWith(statusPrefix));
  if (statusIndex < 0) return message;
  const safeMemberName = (memberName || "").replace(/[\r\n]+/g, " ").trim() || "會員";
  lines.splice(statusIndex + 1, 0, `${NOTIFICATION_COPY.order.labels.member}：${safeMemberName}`);
  return lines.join("\n");
}

function flexRow(label: string, value: string) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      { type: "text", text: label, color: "#8A8A8A", size: "sm", flex: 3, wrap: true },
      { type: "text", text: value || "-", color: "#3D3D3D", size: "sm", weight: "bold", flex: 7, wrap: true }
    ]
  };
}

function orderFlexTitle(data: OrderMessageData) {
  if (data.eventType === "created") return "訂單建立提醒";
  if (data.eventType === "payment_reported") return "匯款回報已送出";
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "賣貨便") return "賣貨便出貨通知";
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "宅配") return "宅配出貨通知";
  if (data.eventType === "fulfillment_updated") return "訂單進度更新";
  return "訂單狀態更新";
}

// 取消以紅色標示，其餘狀態維持 LINE 綠
function orderStatusColor(orderStatus: string) {
  return orderStatus === "cancelled" ? "#D92D20" : "#06C755";
}

function orderFlexSummary(data: OrderMessageData) {
  if (data.eventType === "created") {
    return "提醒您已成功建立訂單，請依頁面提示完成付款或回報匯款末五碼。";
  }
  if (data.eventType === "payment_reported") {
    return "已收到您的匯款回報，待管理員確認後會再通知您。";
  }
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "到店取貨") {
    return "訂單已完成取貨，謝謝您的支持！";
  }
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "賣貨便") {
    return "商品已由賣貨便出貨，請留意 7-ELEVEN 到貨通知。";
  }
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "宅配") {
    return "商品已寄出，請留意貨運的電話／簡訊通知。";
  }
  if (data.eventType === "status_changed" && data.orderStatus === "cancelled") {
    return "您的訂單已取消，如有疑問請直接回覆官方帳號。";
  }
  return "訂單進度已更新，請留意後續通知。";
}

/**
 * Builds the customer-facing LINE card while keeping the existing plain text
 * message as altText. Telegram and other internal channels continue to use
 * buildOrderNotificationMessage() unchanged.
 */
export function buildLineOrderFlexMessage(data: OrderMessageData, altText: string): LinePushMessage {
  const isSeller = data.deliveryLine === "賣貨便";
  const isHome = data.deliveryLine === "宅配";
  const itemSummary = data.items.slice(0, 500);
  const contents: Array<Record<string, unknown>> = [
    flexRow(NOTIFICATION_COPY.order.labels.order, data.orderNumber),
    flexRow(NOTIFICATION_COPY.order.labels.items, itemSummary),
    flexRow(NOTIFICATION_COPY.order.labels.delivery, data.deliveryLine),
    flexRow(NOTIFICATION_COPY.order.labels.payment, data.paymentLine)
  ];

  if (data.eventType === "created") {
    contents.push(flexRow(NOTIFICATION_COPY.order.labels.total, money(data.amountDue)));
    if (!isSeller || data.hasPreorder) {
      contents.push(flexRow(NOTIFICATION_COPY.order.labels.deposit, money(data.depositDue)));
    }
    if (isHome) {
      const shippingValue = data.shippingFee > 0
        ? money(data.shippingFee)
        : data.hasPreorder
          ? NOTIFICATION_COPY.order.delivery.homeShippingPending
          : NOTIFICATION_COPY.order.delivery.homeShippingPendingStock;
      contents.push(flexRow(NOTIFICATION_COPY.order.labels.shipping, shippingValue));
    }
  }

  // 確認付款只收訂金（預購）時，列出還要付的尾款；全額付清或賣貨便外部收款不顯示
  const remaining = Number(data.amountDue || 0) - Number(data.paidAmount || 0);
  if (data.eventType === "status_changed" && data.orderStatus === "confirmed" && Number(data.paidAmount || 0) > 0 && remaining > 0) {
    contents.push(flexRow(NOTIFICATION_COPY.order.labels.remaining, money(remaining)));
  }

  if (data.shippingRecipientName || data.shippingPhone || data.shippingAddress) {
    const recipient = [data.shippingRecipientName, data.shippingPhone].filter(Boolean).join("／").slice(0, 120);
    if (recipient) contents.push(flexRow(NOTIFICATION_COPY.order.labels.recipient, recipient));
    if (data.shippingAddress) contents.push(flexRow(NOTIFICATION_COPY.order.labels.address, data.shippingAddress.slice(0, 160)));
  }

  const safeAltText = altText.slice(0, 1500);
  return {
    type: "flex",
    altText: safeAltText,
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
          { type: "text", text: orderFlexTitle(data), color: "#333333", size: "xl", weight: "bold", wrap: true },
          { type: "text", text: orderFlexSummary(data), color: "#555555", size: "md", margin: "md", wrap: true },
          { type: "separator", margin: "lg", color: "#E5E5E5" },
          { type: "text", text: data.statusLabel || data.orderStatus, color: orderStatusColor(data.orderStatus), size: "md", weight: "bold", margin: "lg", wrap: true },
          ...contents
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: [
          { type: "text", text: "請回到官方帳號查看完整訂單資訊。", color: "#8A8A8A", size: "sm", align: "center", wrap: true }
        ]
      }
    }
  };
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

export function buildLowStockMessage(storeName: string, lines: string[]) {
  const copy = NOTIFICATION_COPY.lowStock;
  return [storeName, copy.title, ...lines.map((line) => `${copy.bullet}${line}`)].join("\n");
}

export function buildBirthdayCouponMessage(storeName: string, coupon: { name: string; code: string; discountAmount: number }) {
  const copy = NOTIFICATION_COPY.birthday;
  return [
    storeName,
    copy.greeting,
    `${copy.coupon}：${coupon.name}`,
    `${copy.code}：${coupon.code}`,
    `${copy.discount}：${money(coupon.discountAmount)}`
  ].join("\n");
}
