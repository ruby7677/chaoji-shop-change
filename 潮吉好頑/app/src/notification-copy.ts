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
      finalPaymentReported: "會員已匯尾款並回報末五碼",
      storeConfirmed: "已確認訂單(付款完成)",
      remoteConfirmed: "已確認訂單付訂完成，待到貨通知",
      sellerStockConfirmed: "已確認訂單，備貨中",
      homeStockConfirmed: "已確認訂單(付款完成)，現貨備貨中",
      arrivedStorePreorder: "商品已到貨，請確認尾款",
      arrivedSellerPreorder: "商品已到貨，私訊小幫手開賣貨便",
      arrivedHome: "商品已到貨，待小幫手確認尾款及運費後通知",
      homeFeeConfirmed: "運費已確認，請完成匯款",
      homeBalanceConfirmed: "尾款及運費已確認，請完成匯款",
      shippedSeller: "已出貨，請留意到貨的簡訊通知",
      shippedHome: "已出貨，請留意貨運的電話／簡訊通知",
      cvsStockConfirmed: "已確認訂單(付款完成)，待出貨",
      arrivedCvs: "商品已到貨，請匯尾款",
      shippedCvs: "已出貨，請留意到貨的簡訊通知",
      completedPickup: "已完成取貨"
    },
    labels: {
      order: "訂單編號",
      status: "訂單狀態",
      member: "會員名稱",
      items: "商品",
      delivery: "取貨方式",
      shipping: "運費",
      productAmount: "商品金額",
      pickupStore: "取件門市",
      payment: "付款方式",
      deliveryNote: "配送說明",
      total: "總金額",
      deposit: "訂金",
      balance: "尾款／運費",
      totalBalance: "總計尾款",
      deadline: "付款期限",
      remaining: "待付尾款",
      finalPaymentLastFive: "尾款末五碼",
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
      cvs: "7-11店到店(交貨便)",
      freeShipping: "免運",
      preorderNoticeHeading: "預購商品注意事項：",
      preorderNoticeLine: "預購商品報價有時效性，請於訂單成立後2小時內完成付訂",
      preorderNoticeCancel: "否則訂單將自動取消",
      homeShippingPending: "待到貨與尾款一併確認通知",
      homeShippingPendingStock: "待小幫手確認運費",
      homeBalanceAccount: "匯款帳號與訂金相同，可在「查看訂單」查看",
      homeBalanceReport: "匯款後請在「查看訂單」回報末五碼",
      cvsArrivedOrdersHint: "點擊⬇️查看訂單，查詢尾款/匯款帳號"
    }
  },
  lowStock: {
    title: "低庫存提醒（統一通知）",
    bullet: "• "
  },
  backupFailed: {
    title: "每日資料備份失敗",
    dateLabel: "備份日期",
    reasonLabel: "原因",
    note: "請到 Cloudflare Worker 紀錄查看，並確認 Supabase 與 R2（chaoji-backups）狀態。"
  },
  birthday: {
    greeting: "生日快樂！",
    coupon: "您收到優惠券",
    code: "優惠碼",
    discount: "折抵"
  }
} as const;
