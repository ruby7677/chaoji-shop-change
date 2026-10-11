// LINE Flex 訊息：屬性值必須是 LINE Messaging API 接受的列舉值。曾因 alignItems: "start"（應為 "flex-start"）
// 被 LINE 以 400 拒絕（/body/contents/4/alignItems），且當時額度用完未能實測；這裡離線檢查所有訊息節點。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSourceModule } from "./harness.mjs";

const messages = await loadSourceModule("line-notification-messages.ts");

const SPACING = ["none", "xs", "sm", "md", "lg", "xl", "xxl"];
const ALLOWED = {
  layout: ["horizontal", "vertical", "baseline"],
  alignItems: ["flex-start", "center", "flex-end"],
  justifyContent: ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"],
  align: ["start", "end", "center"],
  gravity: ["top", "bottom", "center"],
  weight: ["regular", "bold"],
  spacing: SPACING,
  margin: SPACING,
  style: ["primary", "secondary", "link"],
  height: ["sm", "md"]
};
const PIXELS = /^\d+(\.\d+)?px$/;

function violations(node, path = "") {
  if (Array.isArray(node)) return node.flatMap((child, index) => violations(child, `${path}/${index}`));
  if (!node || typeof node !== "object") return [];
  const found = [];
  for (const [key, value] of Object.entries(node)) {
    if (ALLOWED[key] && typeof value === "string" && !ALLOWED[key].includes(value) && !((key === "spacing" || key === "margin") && PIXELS.test(value))) {
      found.push(`${path}/${key}=${value}`);
    }
    found.push(...violations(value, `${path}/${key}`));
  }
  return found;
}

const orderData = {
  storeName: "潮吉好頑", eventType: "status_changed", orderStatus: "ready_for_pickup", statusLabel: "現貨宅配待尾款／運費",
  orderNumber: "CJ-260925-093000-ABCD", items: "測試商品 x1", deliveryLine: "宅配", paymentLine: "匯款", hasPreorder: false,
  amountDue: 1350, depositDue: 1350, paidAmount: 1350, shippingFee: 120, finalPaymentConfirmed: false,
  shippingRecipientName: "王小明", shippingPhone: "0912345678", shippingAddress: "台北市民生路二段 93 號"
};

test("order Flex messages only use values LINE accepts", () => {
  for (const eventType of ["created", "payment_reported", "status_changed", "fulfillment_updated"]) {
    const message = messages.buildLineOrderFlexMessage({ ...orderData, eventType }, "alt");
    assert.equal(message.type, "flex");
    assert.deepEqual(violations(message.contents), [], `${eventType} Flex message`);
  }
});

test("birthday Flex message only uses values LINE accepts", () => {
  const message = messages.buildLineBirthdayFlexMessage("潮吉好頑", { name: "生日禮", code: "BDAY100", discountAmount: 100 }, "alt");
  assert.deepEqual(violations(message.contents), []);
});

test("rows align label and value at the top", () => {
  const message = messages.buildLineOrderFlexMessage(orderData, "alt");
  const rows = JSON.stringify(message.contents).match(/"alignItems":"[^"]+"/g) || [];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row === '"alignItems":"flex-start"'));
});

test("order Flex footer opens the orders page when it is configured, and keeps the hint text otherwise", () => {
  const url = "https://liff.line.me/2007619149-ORDERS";
  const withLink = messages.buildLineOrderFlexMessage(orderData, "alt", url);
  assert.deepEqual(violations(withLink.contents), []);
  const [button] = withLink.contents.footer.contents;
  assert.equal(button.type, "button");
  assert.deepEqual(button.action, { type: "uri", label: "查看訂單", uri: url });
  const [hint] = messages.buildLineOrderFlexMessage(orderData, "alt").contents.footer.contents;
  assert.equal(hint.text, "請回到官方帳號查看完整訂單資訊。");
});

// 客戶 LINE 卡片必須包含 Telegram 文字的每一行內容（標題與會員名稱除外），例如「私訊小幫手…」與預購付訂期限。
test("every line of the Telegram order text also appears in the customer LINE card", () => {
  const deliveries = ["到店取貨", "宅配", "賣貨便", "7-11店到店(交貨便)"];
  const events = [
    ["created", "pending_payment"], ["payment_reported", "pending_review"], ["status_changed", "confirmed"],
    ["status_changed", "ready_for_pickup"], ["status_changed", "completed"], ["status_changed", "cancelled"], ["fulfillment_updated", "ready_for_pickup"]
  ];
  let checked = 0;
  for (const deliveryLine of deliveries) for (const hasPreorder of [false, true]) for (const [eventType, orderStatus] of events) {
    const data = { ...orderData, deliveryLine, hasPreorder, eventType, orderStatus, statusLabel: "通用狀態", depositDue: 675, paidAmount: 675, productAmount: 1230, pickupStore: null };
    const text = messages.buildOrderNotificationMessage(data);
    if (!text) continue;
    const card = messages.buildLineOrderFlexMessage(data, text);
    const cardTexts = JSON.stringify(card.contents);
    const telegram = messages.buildTelegramOrderNotificationMessage(text, "王小明").split("\n").slice(1).filter(Boolean);
    for (const line of telegram) {
      if (line.startsWith("會員名稱：")) continue;
      const [label, ...rest] = line.split("：");
      const value = rest.join("：");
      const expected = value && label.length <= 12 ? (label === "訂單狀態" ? [value] : [label, value]) : [line];
      for (const part of expected) assert.ok(cardTexts.includes(JSON.stringify(part)), `${deliveryLine}/${hasPreorder}/${eventType}/${orderStatus} 缺少「${part}」`);
    }
    checked += 1;
  }
  assert.ok(checked > 20);
});

test("the LINE card shows the instruction status instead of the generic status label", () => {
  const data = { ...orderData, deliveryLine: "到店取貨", eventType: "status_changed", orderStatus: "confirmed", statusLabel: "已確認" };
  const card = messages.buildLineOrderFlexMessage(data, messages.buildOrderNotificationMessage(data));
  const body = JSON.stringify(card.contents.body);
  assert.match(body, /已確認訂單\(付款完成\)/);
  assert.match(body, /私訊小幫手約時間到店取貨/);
  assert.doesNotMatch(body, /"text":"已確認"/);
});