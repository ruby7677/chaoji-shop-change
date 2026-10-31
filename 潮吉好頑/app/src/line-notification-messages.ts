/**
 * 訂單與其他通知的訊息組裝（Telegram 純文字、LINE Flex 卡片）。
 * 文案在 notification-copy.ts；這裡只決定各事件要放哪些列。
 */

import { NOTIFICATION_COPY } from "./notification-copy";
import { parseOrderNotificationText } from "./notification-text-rows";

export { NOTIFICATION_COPY };

export { buildLineBirthdayFlexMessage } from "./line-birthday-flex";

export type OrderNotificationEventType = "created" | "payment_reported" | "final_payment_reported" | "final_payment_confirmed" | "status_changed" | "fulfillment_updated";

export function routeOrderNotificationRecipients(
  eventType: OrderNotificationEventType,
  memberLineUserId: string | null | undefined,
  telegramAdminChatIds: string[],
  suppressMemberLineRecipient = false
) {
  return {
    // 會員自己回報的訂金／尾款匯款只通知管理員
    lineRecipients: eventType === "payment_reported" || eventType === "final_payment_reported" || suppressMemberLineRecipient || !memberLineUserId ? [] : [memberLineUserId],
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
  /** 商品金額（優惠券與點數折抵後，不含運費） */
  productAmount?: number;
  /** 交貨便取件門市，例：臺南市中西區 民生門市（123456） */
  pickupStore?: string | null;
  /** 付款期限（已格式化為台灣時間） */
  paymentDeadline?: string | null;
  /** 會員在網站回報的尾款匯款末五碼 */
  finalPaymentReportedLastFive?: string | null;
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

function isPreorderHomeBalanceNotice(data: OrderMessageData) {
  return data.eventType === "fulfillment_updated" && data.deliveryLine === "宅配" && data.hasPreorder
    && !data.finalPaymentConfirmed && ["partially_ready", "ready_for_pickup"].includes(data.orderStatus);
}

export function buildOrderNotificationMessage(data: OrderMessageData): string | null {
  const copy = NOTIFICATION_COPY.order;
  const title = `【${data.storeName}${copy.titleSuffix}】`;
  const isSeller = data.deliveryLine === "賣貨便";
  const isHome = data.deliveryLine === "宅配";
  const isCvs = data.deliveryLine === copy.delivery.cvs;
  const isPreorder = data.hasPreorder;
  const productLine = `${copy.labels.items}：${data.items || "-"}`;
  const cvsDeliveryLine = `${copy.labels.delivery}：${copy.delivery.cvs}`;
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
    if (isCvs) return message(copy.status.shippedCvs, [productLine, cvsDeliveryLine]);
    if (isSeller) {
      return message(copy.status.shippedSeller, [productLine, `${copy.labels.delivery}：${copy.delivery.sellerShipped}`]);
    }
    if (isHome) {
      return message(copy.status.shippedHome, [productLine, `${copy.labels.delivery}：${copy.delivery.home}`]);
    }
    if (data.deliveryLine !== "到店取貨") return null;
    return message(copy.status.completedPickup, [productLine, `${copy.labels.delivery}：${data.deliveryLine}`]);
  }

  if (data.eventType === "created" && isCvs) {
    const lines = [
      productLine,
      `${copy.labels.productAmount}：${money(data.productAmount ?? data.amountDue - data.shippingFee)}`,
      `${copy.labels.shipping}：${data.shippingFee > 0 ? money(data.shippingFee) : copy.delivery.freeShipping}`,
      `${copy.labels.total}：${money(data.amountDue)}`,
      ...(isPreorder ? [`${copy.labels.deposit}：${money(data.depositDue)}`] : []),
      `${copy.labels.payment}：${copy.payment.bank}`
    ];
    if (isPreorder) lines.push("", copy.delivery.preorderNoticeHeading, copy.delivery.preorderNoticeLine, copy.delivery.preorderNoticeCancel);
    return message(copy.status.createdPayment, lines);
  }

  if (data.eventType === "created") {
    const sellerStock = isSeller && !isPreorder;
    // 現貨宅配建單時運費未定：只列商品金額，含運應付金額待小幫手確認運費後另行通知
    const homeStock = isHome && !isPreorder;
    const lines = [
      productLine,
      homeStock
        ? `${copy.labels.productAmount}：${money(data.productAmount ?? data.amountDue - data.shippingFee)}`
        : `${copy.labels.total}：${money(data.amountDue)}`,
      ...(sellerStock || homeStock ? [] : [`${copy.labels.deposit}：${money(data.depositDue)}`]),
      ...(isHome ? [`${copy.labels.shipping}：${isPreorder ? copy.delivery.homeShippingPending : copy.delivery.homeShippingPendingStock}`] : []),
      `${copy.labels.payment}：${sellerStock ? copy.payment.seller : copy.payment.bank}`
    ];
    if (isPreorder) lines.push("", copy.delivery.preorderNoticeHeading, copy.delivery.preorderNoticeLine, copy.delivery.preorderNoticeCancel);
    return message(sellerStock ? copy.status.created : copy.status.createdPayment, lines);
  }

  if (data.eventType === "payment_reported") {
    const delivery = isCvs
      ? copy.delivery.cvs
      : isSeller
      ? copy.delivery.sellerReported
      : isHome
        ? copy.delivery.home
        : isPreorder
          ? copy.delivery.storePreorderReported
          : copy.delivery.storeReported;
    return message(isPreorder ? copy.status.preorderPaymentReported : copy.status.paymentReported, [productLine, `${copy.labels.delivery}：${delivery}`]);
  }

  // 預購到貨後會員回報尾款末五碼：只發 Telegram，列出待核對的尾款金額與末五碼
  if (data.eventType === "final_payment_reported") {
    return message(copy.status.finalPaymentReported, [
      productLine,
      `${copy.labels.delivery}：${data.deliveryLine}`,
      `${copy.labels.balance}：${money(Math.max(data.amountDue - data.paidAmount, 0))}`,
      `${copy.labels.finalPaymentLastFive}：${data.finalPaymentReportedLastFive || "-"}`
    ]);
  }

  // 預購交貨便／宅配：管理員這次儲存才確認尾款入帳（仿照訂金確認的「付訂完成，待到貨通知」），會員與管理員各一則
  if (data.eventType === "final_payment_confirmed") {
    if (!isPreorder || !(isCvs || isHome)) return null;
    return message(copy.status.finalPaymentConfirmed, [productLine, `${copy.labels.delivery}：${data.deliveryLine}`]);
  }

  // 現貨宅配待付款：小幫手確認運費後通知客人含運總額，客人收到後才匯款
  if (data.eventType === "fulfillment_updated" && isHome && !isPreorder && data.orderStatus === "pending_payment") {
    // 卡片標題已是「運費已確認，請完成匯款」，狀態列維持「待確認付款」
    return message(copy.status.createdPayment, [
      productLine,
      `${copy.labels.productAmount}：${money(data.productAmount ?? data.amountDue - data.shippingFee)}`,
      `${copy.labels.shipping}：${data.shippingFee > 0 ? money(data.shippingFee) : copy.delivery.freeShipping}`,
      `${copy.labels.total}：${money(data.amountDue)}`,
      `${copy.labels.payment}：${copy.payment.bank}`,
      ...(data.paymentDeadline ? [`${copy.labels.deadline}：${data.paymentDeadline}`] : [])
    ]);
  }

  // 預購宅配到貨後：小幫手儲存尾款與運費（尚未入帳）時通知待付金額
  if (isPreorderHomeBalanceNotice(data)) {
    return message(copy.status.homeBalanceConfirmed, [
      productLine,
      `${copy.labels.shipping}：${data.shippingFee > 0 ? money(data.shippingFee) : copy.delivery.freeShipping}`,
      `${copy.labels.remaining}：${money(Math.max(data.amountDue - data.paidAmount, 0))}`,
      `${copy.labels.payment}：${copy.payment.bank}`,
      "",
      copy.delivery.homeBalanceAccount,
      copy.delivery.homeBalanceReport
    ]);
  }

  if (data.eventType === "fulfillment_updated" && data.finalPaymentConfirmed && isSeller) {
    return message(copy.status.shippedSeller, [productLine, `${copy.labels.delivery}：${copy.delivery.sellerShipped}`]);
  }

  // 預購到貨待付：訂單總額（店到店含運費）扣掉已付訂金；LINE 卡片以這列取代「付款方式」
  const arrivalBalanceLine = `${copy.labels.balance}：${money(Math.max(data.amountDue - (data.paidAmount || data.depositDue), 0))}`;
  const isArrival = data.eventType === "fulfillment_updated"
    || (data.eventType === "status_changed" && ["partially_ready", "ready_for_pickup"].includes(data.orderStatus));
  if (isArrival) {
    if (isCvs) {
      // 交貨便只有預購會標記到貨；儲存尾款不代表寄出，出貨通知在完成時發送。
      if (data.eventType === "fulfillment_updated" || !isPreorder) return null;
      // 無標籤的提醒會排在 LINE 卡片最下方（取件門市之後），引導客人點「查看訂單」看尾款與帳號
      return message(copy.status.arrivedCvs, [productLine, arrivalBalanceLine, "", copy.delivery.cvsArrivedOrdersHint]);
    }
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
    if (isPreorder) return message(copy.status.arrivedStorePreorder, [productLine, `${copy.labels.delivery}：${copy.delivery.storePreorderArrived}`, arrivalBalanceLine]);
    return null;
  }

  if (data.eventType === "status_changed" && data.orderStatus === "confirmed") {
    if (isCvs) return isPreorder ? message(copy.status.remoteConfirmed, [productLine]) : message(copy.status.cvsStockConfirmed, [productLine, cvsDeliveryLine]);
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
  if (data.eventType === "final_payment_reported") return "尾款匯款回報";
  if (data.eventType === "final_payment_confirmed") return "尾款確認通知";
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "賣貨便") return "賣貨便出貨通知";
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === "宅配") return "宅配出貨通知";
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === NOTIFICATION_COPY.order.delivery.cvs) return "7-11 店到店出貨通知";
  if (data.eventType === "fulfillment_updated" && data.deliveryLine === "宅配" && !data.hasPreorder && data.orderStatus === "pending_payment") return NOTIFICATION_COPY.order.status.homeFeeConfirmed;
  if (isPreorderHomeBalanceNotice(data)) return NOTIFICATION_COPY.order.status.homeBalanceConfirmed;
  if (data.eventType === "fulfillment_updated") return "訂單進度更新";
  return "訂單狀態更新";
}

// 取消以紅色標示，其餘狀態維持 LINE 綠
function orderStatusColor(orderStatus: string) {
  return orderStatus === "cancelled" ? "#D92D20" : "#06C755";
}

// 現貨宅配運費確認後的匯款提醒：說明文字以紅色提醒客人匯款
function isStockHomeFeeNotice(data: OrderMessageData) {
  return data.eventType === "fulfillment_updated" && data.deliveryLine === "宅配" && !data.hasPreorder && data.orderStatus === "pending_payment";
}

function orderFlexSummaryColor(data: OrderMessageData) {
  return isStockHomeFeeNotice(data) ? "#D92D20" : "#555555";
}

function orderFlexSummary(data: OrderMessageData) {
  if (data.eventType === "created" && data.deliveryLine === "宅配" && !data.hasPreorder) {
    return "提醒您已成功建立訂單，小幫手確認運費後會再通知您匯款金額，請先不要匯款。";
  }
  if (data.eventType === "created") {
    return "提醒您已成功建立訂單，請依頁面提示完成付款或回報匯款末五碼。";
  }
  if (isStockHomeFeeNotice(data)) {
    return "請依通知金額於付款期限內完成匯款，並在「查看訂單」回報匯款帳號末五碼。";
  }
  if (isPreorderHomeBalanceNotice(data)) {
    return "預購商品已到貨，請將尾款與運費一併匯款，確認入帳後安排寄出。";
  }
  if (data.eventType === "payment_reported") {
    return "已收到您的匯款回報，待管理員確認後會再通知您。";
  }
  if (data.eventType === "final_payment_confirmed") {
    return "已確認您的尾款與運費入帳，商品寄出後會再通知您。";
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
  if (data.eventType === "status_changed" && data.orderStatus === "completed" && data.deliveryLine === NOTIFICATION_COPY.order.delivery.cvs) {
    return "商品已寄出，請留意 7-ELEVEN 到貨的簡訊通知。";
  }
  if (data.eventType === "status_changed" && data.orderStatus === "cancelled") {
    return "您的訂單已取消，如有疑問請直接回覆官方帳號。";
  }
  return "訂單進度已更新，請留意後續通知。";
}

// 有訂單頁網址時，頁尾改成「查看訂單」按鈕（開啟獨立訂單頁）；沒有設定時維持提示文字
function orderFlexFooter(ordersUrl?: string | null) {
  if (ordersUrl) {
    return [{ type: "button", style: "primary", color: "#06C755", height: "sm", action: { type: "uri", label: "查看訂單", uri: ordersUrl } }];
  }
  return [{ type: "text", text: "請回到官方帳號查看完整訂單資訊。", color: "#8A8A8A", size: "sm", align: "center", wrap: true }];
}

/** 客戶的 LINE 卡片；altText 是與 Telegram 相同的文字訊息，卡片內容也由它逐行產生。 */
export function buildLineOrderFlexMessage(data: OrderMessageData, altText: string, ordersUrl?: string | null): LinePushMessage {
  const labels = NOTIFICATION_COPY.order.labels;
  // 卡片內容逐行取自與 Telegram 相同的文字訊息（altText），確保「私訊小幫手…」等指示與付款提醒不被省略
  const parsed = parseOrderNotificationText(altText, labels.status, [labels.order, labels.member]);
  const shownLabels = new Set(parsed.rows.map((row) => row.label));
  const contents: Array<Record<string, unknown>> = [
    flexRow(labels.order, data.orderNumber),
    ...parsed.rows.map((row) => flexRow(row.label, row.label === labels.items ? row.value.slice(0, 500) : row.value))
  ];
  if (!shownLabels.has(labels.items)) contents.push(flexRow(labels.items, data.items.slice(0, 500)));
  if (!shownLabels.has(labels.delivery)) contents.push(flexRow(labels.delivery, data.deliveryLine));
  // 已列出尾款／運費（預購到貨）時不再補付款方式
  if (!shownLabels.has(labels.payment) && !shownLabels.has(labels.balance)) contents.push(flexRow(labels.payment, data.paymentLine));

  // 以下是 LINE 卡片額外補充給客戶的資料（Telegram 文字沒有），只增不減
  // 確認付款只收訂金（預購）時，列出還要付的尾款；全額付清或賣貨便外部收款不顯示
  const remaining = Number(data.amountDue || 0) - Number(data.paidAmount || 0);
  if (data.eventType === "status_changed" && data.orderStatus === "confirmed" && Number(data.paidAmount || 0) > 0 && remaining > 0) {
    contents.push(flexRow(labels.remaining, money(remaining)));
  }
  if (data.shippingRecipientName || data.shippingPhone || data.shippingAddress) {
    const recipient = [data.shippingRecipientName, data.shippingPhone].filter(Boolean).join("／").slice(0, 120);
    if (recipient) contents.push(flexRow(labels.recipient, recipient));
    if (data.shippingAddress) contents.push(flexRow(labels.address, data.shippingAddress.slice(0, 160)));
  }
  if (data.pickupStore && !shownLabels.has(labels.pickupStore)) contents.push(flexRow(labels.pickupStore, data.pickupStore.slice(0, 160)));
  if (parsed.notes.length) {
    contents.push({ type: "separator", margin: "lg", color: "#E5E5E5" });
    parsed.notes.forEach((note, index) => contents.push({ type: "text", text: note, color: "#D92D20", size: "sm", weight: index === 0 ? "bold" : "regular", margin: index === 0 ? "md" : "none", wrap: true }));
  }
  const statusText = parsed.status || data.statusLabel || data.orderStatus;
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
          { type: "text", text: orderFlexSummary(data), color: orderFlexSummaryColor(data), size: "md", margin: "md", wrap: true },
          { type: "separator", margin: "lg", color: "#E5E5E5" },
          { type: "text", text: statusText, color: orderStatusColor(data.orderStatus), size: "md", weight: "bold", margin: "lg", wrap: true },
          ...contents
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "12px",
        contents: orderFlexFooter(ordersUrl)
      }
    }
  };
}


export function buildLowStockMessage(storeName: string, lines: string[]) {
  const copy = NOTIFICATION_COPY.lowStock;
  return [storeName, copy.title, ...lines.map((line) => `${copy.bullet}${line}`)].join("\n");
}

export function buildBackupFailureMessage(storeName: string, date: string, reason: string) {
  const copy = NOTIFICATION_COPY.backupFailed;
  const safeReason = reason.replace(/[\r\n]+/g, " ").trim().slice(0, 300) || "未知錯誤";
  return [storeName, copy.title, `${copy.dateLabel}：${date}`, `${copy.reasonLabel}：${safeReason}`, copy.note].join("\n");
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
