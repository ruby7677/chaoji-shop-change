// 頂欄搜尋依目前分頁對應到該分頁自己的搜尋欄位；純函式，供 admin-shell.js 與測試共用。
// 未列出的分頁（概況、庫存、優惠券、收款帳戶、稽核紀錄、通知紀錄…）沒有自己的搜尋欄位，
// 一律 fallback 回訂單搜尋的文案，維持頂欄搜尋「預設找訂單」的既有行為。
const SEARCH_CONTEXTS = {
  orders: { input: "#admin-order-search", label: "搜尋訂單", placeholder: "搜尋訂單編號、姓名、手機、末五碼" },
  products: { input: "#admin-product-search", label: "搜尋商品", placeholder: "搜尋商品名稱、分類、規格或 SKU" },
  members: { input: "#admin-member-search", label: "搜尋會員", placeholder: "搜尋會員姓名或手機" }
};

const FALLBACK_CONTEXT = { input: null, label: "搜尋訂單", placeholder: "搜尋訂單編號、姓名、手機、末五碼" };

export function searchContextFor(tab) {
  return SEARCH_CONTEXTS[tab] || FALLBACK_CONTEXT;
}
