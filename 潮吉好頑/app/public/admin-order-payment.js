// 訂單「確認款項」相關的純函式：只做資料整理與文字組裝，不接觸 DOM，供 admin-orders-panel.js 使用。
// 對應規則見根目錄 AGENTS.md／.agents/skills/chaoji-shop-change/SKILL.md：後端行為（transition API）不變，這裡只決定顯示內容。
import { money } from "./product-format.js";

// 對應 admin-app.js 的 relationOne：關聯欄位可能是物件或單一元素陣列，這裡不 import 該模組以維持零 DOM 依賴。
function relationOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

// 本次確認款項所認列的金額：已完成尾款確認的訂單認列全額，否則認列訂金（對應 SQL paid_amount 規則）。
export function confirmationAmount(order) {
  return order?.final_payment_confirmed_at ? Number(order.amount_due || 0) : Number(order?.deposit_due || 0);
}

// 一鍵確認：這張卡片目前第一個可執行的下一步就是「確認款項」時才顯示捷徑按鈕。
export function isQuickConfirmable(order, transitions) {
  return Array.isArray(transitions) && transitions[0]?.value === "confirmed";
}

// 確認對話框內容：匯款訂單顯示訂單、會員、應收金額、末五碼與收款帳戶；
// 賣貨便外部訂單不經本站收款，顯示訂單、會員與訂單總額供核對外部訂單。
export function paymentConfirmation(order) {
  const amount = confirmationAmount(order);
  const isBankTransfer = Boolean(order?.bank_account_id);
  const member = relationOne(order?.profiles);
  const warnings = ["確認款項後會正式扣除商品庫存。"];
  if (isBankTransfer && !order?.payment_last_five) warnings.push("會員尚未回報匯款末五碼，請先核對帳戶入帳紀錄。");
  if (order?.delivery_method === "home_delivery" && !Number(order?.shipping_fee)) warnings.push("宅配尚未填寫實際運費。");
  if (isBankTransfer) {
    const account = relationOne(order.bank_accounts);
    return {
      title: `確認收到 ${money(amount)}？`,
      confirmLabel: "確認收到款項",
      details: [
        ["訂單", order.order_number],
        ["會員", member?.full_name || "未填姓名"],
        ["本次應收", money(amount)],
        ["匯款末五碼", order.payment_last_five || "尚未回報"],
        ["收款帳戶", account?.label || account?.bank_name || "未指定帳戶"]
      ],
      warnings
    };
  }
  return {
    title: "確認賣貨便訂單？",
    confirmLabel: "確認賣貨便訂單",
    details: [
      ["訂單", order?.order_number],
      ["會員", member?.full_name || "未填姓名"],
      ["訂單總額", money(Number(order?.amount_due || 0))]
    ],
    warnings
  };
}

// 訂單卡「金額摘要」列（收合狀態的 summary 文字）：總額／已收／待收。
export function moneySummary(order) {
  const total = Number(order?.amount_due || 0);
  const paid = Number(order?.paid_amount || 0);
  const balance = Math.max(total - paid, 0);
  return `總額 ${money(total)} · 已收 ${money(paid)} · 待收 ${money(balance)}`;
}
