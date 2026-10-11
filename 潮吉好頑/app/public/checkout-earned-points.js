/** 與完成訂單時入點規則相同：可積點商品金額扣除優惠券與點數折抵後，每滿門檻金額 1 點（不含運費）。 */
export function estimateEarnedPoints({ items, couponDiscount = 0, pointDiscount = 0, earnAmountPerPoint }) {
  const earnAmount = Number(earnAmountPerPoint);
  if (!Number.isFinite(earnAmount) || earnAmount <= 0) return 0;
  const eligible = items.reduce((sum, item) => sum + (item.points_eligible === false ? 0 : item.price * item.quantity), 0);
  return Math.floor(Math.max(eligible - couponDiscount - pointDiscount, 0) / earnAmount);
}
