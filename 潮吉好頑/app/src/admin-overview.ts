// 後台概況（/api/admin/dashboard?section=overview）一次回傳統計、待辦訂單、最新訂單與低庫存規格。
// 待辦與低庫存由資料庫精準篩選（低庫存用與統計、通知相同的 low_stock_variants），不再依「最近 100 筆訂單／前 100 個商品」推算，
// 開啟後台只需這一個請求（原本需要 overview、orders、products 三個）。

// 概況只需要列表與狀態文字用得到的欄位；order_items(kind) 供前端判斷預購狀態文字。
const OVERVIEW_ORDER_SELECT = "id,order_number,status,delivery_method,bank_account_id,payment_last_five,deposit_due,amount_due,paid_amount,shipping_fee,final_payment_confirmed_at,created_at,profiles!orders_member_id_fkey(full_name),order_items(kind)";
// 與前端 TODO_RULES 相同的四種人工待辦：確認款項、退款處理、核對賣貨便、宅配尾款／運費。
const TODO_FILTER = "(status.eq.pending_review,status.eq.refund_pending,and(delivery_method.eq.seller_delivery,status.eq.pending_payment,bank_account_id.is.null),and(delivery_method.eq.home_delivery,status.eq.ready_for_pickup,final_payment_confirmed_at.is.null))";
const TODO_LIMIT = 50;
const RECENT_LIMIT = 6;
const LOW_STOCK_LIMIT = 20;

// 低庫存唯一定義在資料庫 low_stock_variants（商品與規格都上架、庫存 ≤ 安全庫存），與統計數字、通知一致。
type LowStockRow = { id: string; name: string; product_name: string | null; stock_on_hand: number; safety_stock: number };

export type AdminOverviewResult =
  | { ok: true; stats: unknown; overview: Record<string, unknown> }
  | { ok: false; response: Response };

export async function loadAdminOverview(
  base: string,
  headers: Record<string, string>,
  actorId: string,
  fetchRows: (url: URL) => Promise<unknown[]>
): Promise<AdminOverviewResult> {
  const url = (resource: string, params: Record<string, string>) => {
    const target = new URL(`${base}/rest/v1/${resource}`);
    Object.entries(params).forEach(([key, value]) => target.searchParams.set(key, value));
    return target;
  };
  const [statsResponse, todoRows, recentOrders, lowStockResponse] = await Promise.all([
    // admin_dashboard_stats 也會再次確認 actor 是管理員
    fetch(`${base}/rest/v1/rpc/admin_dashboard_stats`, { method: "POST", headers, body: JSON.stringify({ p_actor_id: actorId }) }),
    fetchRows(url("orders", { select: OVERVIEW_ORDER_SELECT, or: TODO_FILTER, order: "created_at.desc", limit: String(TODO_LIMIT + 1) })),
    fetchRows(url("orders", { select: OVERVIEW_ORDER_SELECT, order: "created_at.desc", limit: String(RECENT_LIMIT) })),
    fetch(`${base}/rest/v1/rpc/low_stock_variants`, { method: "POST", headers, body: JSON.stringify({ p_limit: LOW_STOCK_LIMIT }) })
  ]);
  if (!statsResponse.ok) return { ok: false, response: statsResponse };
  if (!lowStockResponse.ok) return { ok: false, response: lowStockResponse };
  const lowStock = (await lowStockResponse.json() as LowStockRow[]).map((variant) => ({
    id: variant.id,
    name: variant.name,
    product_name: variant.product_name || "商品",
    stock_on_hand: variant.stock_on_hand,
    safety_stock: variant.safety_stock
  }));
  return {
    ok: true,
    stats: await statsResponse.json(),
    overview: {
      todoOrders: todoRows.slice(0, TODO_LIMIT),
      todoTruncated: todoRows.length > TODO_LIMIT,
      recentOrders,
      lowStock
    }
  };
}
