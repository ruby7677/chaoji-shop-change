// 會員區「儲值金」：餘額與最近紀錄（線上一番賞 Stage 2）。
// 開啟會員資料視窗時才讀取，不增加每次開機的請求；從未有過儲值紀錄的會員不顯示此區。
import { escapeHtml, money } from "./product-format.js";
import { auth, formatDateTime } from "./app-core.js";

const MEMBER_WALLET_TTL_MS = 60 * 1000;
const WALLET_KIND_LABELS = { topup: "儲值", adjust: "調整", refund: "退款", reversal: "更正", draw: "抽獎", shipping: "獎品運費" };

let walletCache = { userId: null, value: null, expiresAt: 0 };
let walletInFlight = null;

export function clearMemberWalletCache() {
  walletCache = { userId: null, value: null, expiresAt: 0 };
  walletInFlight = null;
  renderMemberWallet(null);
}

export async function loadMemberWallet({ force = false } = {}) {
  const userId = auth.user?.id;
  const accessToken = auth.accessToken;
  if (!userId || !accessToken) return null;
  if (!force && walletCache.userId === userId && walletCache.expiresAt > Date.now()) {
    renderMemberWallet(walletCache.value);
    return walletCache.value;
  }
  if (walletInFlight?.userId === userId && walletInFlight.accessToken === accessToken) return walletInFlight.promise;
  const promise = (async () => {
    const response = await fetch("/api/member/wallet", { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "儲值金資料讀取失敗");
    // 登出或換帳號後才回來的舊回應不可寫進目前會員的畫面
    if (auth.user?.id === userId && auth.accessToken === accessToken) {
      walletCache = { userId, value: result, expiresAt: Date.now() + MEMBER_WALLET_TTL_MS };
      renderMemberWallet(result);
    }
    return result;
  })();
  walletInFlight = { userId, accessToken, promise };
  try {
    return await promise;
  } finally {
    if (walletInFlight?.promise === promise) walletInFlight = null;
  }
}

function walletSection() {
  let section = document.querySelector("#member-wallet-summary");
  if (section) return section;
  const points = document.querySelector("#member-points-summary");
  if (!points) return null;
  points.insertAdjacentHTML("afterend", '<section id="member-wallet-summary" class="member-points-summary hidden"><div><small>儲值金餘額</small><strong data-member-wallet-balance></strong></div><p>儲值金 1 元可抵 1 元、不會到期；儲值請聯繫官方 LINE 客服。</p><details><summary>最近儲值金紀錄</summary><div id="member-wallet-history"></div></details></section>');
  section = document.querySelector("#member-wallet-summary");
  return section;
}

function renderMemberWallet(wallet) {
  const ledger = Array.isArray(wallet?.ledger) ? wallet.ledger : [];
  const balance = Number(wallet?.balance) || 0;
  const existing = document.querySelector("#member-wallet-summary");
  if (!wallet || (!ledger.length && balance === 0)) {
    existing?.classList.add("hidden");
    return;
  }
  const section = walletSection();
  if (!section) return;
  section.classList.remove("hidden");
  section.querySelector("[data-member-wallet-balance]").textContent = money(balance);
  section.querySelector("#member-wallet-history").innerHTML = ledger.length
    ? ledger.slice(0, 10).map((entry) => `<div class="member-point-entry"><span>${escapeHtml(WALLET_KIND_LABELS[entry.kind] || entry.kind)} · ${escapeHtml(entry.reason)}<br /><small>${formatDateTime(entry.created_at)}</small></span><strong class="${entry.amount > 0 ? "movement-positive" : "movement-negative"}">${entry.amount > 0 ? "+" : "-"}${money(Math.abs(entry.amount))}</strong></div>`).join("")
    : '<p class="dialog-copy">目前沒有儲值金紀錄。</p>';
}
