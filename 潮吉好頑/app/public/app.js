let products = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", icon: "🌀", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", icon: "⚔️", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

const cart = [];
const grid = document.querySelector("#product-grid");
const search = document.querySelector("#product-search");
const auth = { config: null, accessToken: null, refreshToken: null, lineProviderToken: null, user: null, profile: null, points: null, lineFriendFlag: null };
let activeCategory = "all";
let bankAccounts = [];
let currentOrders = [];
let activePaymentOrder = null;
let activeDetailProductId = null;
let adminData = null;
let cartDeliveryMethod = "store_pickup";
try {
  const savedDeliveryMethod = sessionStorage.getItem("cj-cart-delivery-method");
  if (["store_pickup", "seller_delivery", "home_delivery"].includes(savedDeliveryMethod)) cartDeliveryMethod = savedDeliveryMethod;
} catch { /* sessionStorage may be unavailable in restricted previews. */ }

const deliveryMethodLabels = { store_pickup: "到店取貨", seller_delivery: "賣貨便", home_delivery: "宅配" };
const deliveryMethodNotes = {
  store_pickup: "台南市中西區民生路二段 90 號，免運。",
  seller_delivery: "賣貨便運費由 7-11 於取貨時向客戶收取，不計入本站訂單；如有尾款，將由客服通知。",
  home_delivery: "到貨後由客服依包裹狀況通知實際運費；尾款與運費確認入帳後安排寄出。"
};

const orderStatusLabels = {
  pending_payment: "待付款",
  pending_review: "待確認款項",
  confirmed: "已確認",
  partially_ready: "部分到貨",
  ready_for_pickup: "可取貨",
  completed: "已完成",
  cancelled: "已取消",
  refund_pending: "退款處理中",
  refunded: "已退款"
};

const adminOrderTransitions = {
  pending_payment: [{ value: "confirmed", label: "確認到店付款", storePaymentOnly: true }, { value: "cancelled", label: "取消未付款訂單" }],
  pending_review: [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }],
  confirmed: [{ value: "partially_ready", label: "標記部分可取貨", splitOnly: true }, { value: "ready_for_pickup", label: "標記全部可取貨" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  partially_ready: [{ value: "ready_for_pickup", label: "標記全部可取貨" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  ready_for_pickup: [{ value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  completed: [{ value: "refund_pending", label: "進入退款處理" }],
  refund_pending: [{ value: "refunded", label: "確認已退款" }, { value: "completed", label: "取消退款，恢復已完成" }]
};

function money(value) { return `NT$${value.toLocaleString("zh-TW")}`; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }
function productMark(product) {
  const source = String(product?.category || product?.product_name || product?.name || "玩具").replace(/\s+/g, "");
  return escapeHtml(source.slice(0, 2) || "玩具");
}
function productAvailability(product) {
  if (product?.type === "現貨") return `現貨 ${Number(product.stock || 0)} 件`;
  return product?.preorder_arrival ? `預購 · ${product.preorder_arrival}` : "預購 · 海運與集運依實際進度";
}
function formatDateTime(value) { return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
let toastTimer = null;
function showToast(message) {
  const toast = document.querySelector("#toast");
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog && toast.parentElement !== openDialog) openDialog.appendChild(toast);
  else if (!openDialog && toast.parentElement !== document.body) document.body.appendChild(toast);
  toast.textContent = message;
  toast.classList.remove("show");
  window.requestAnimationFrame(() => toast.classList.add("show"));
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3000);
}
function selectedDeliveryMethod() { return document.querySelector("input[name='delivery_method']:checked")?.value || "store_pickup"; }
function selectedPaymentMethod() { return document.querySelector("input[name='payment_method']:checked")?.value || "bank_transfer"; }
function renderHeroSpotlight() {
  const visual = document.querySelector("#hero-product-visual");
  if (!visual) return;
  const product = products.find((item) => item.type === "現貨" && Number(item.stock || 0) > 0) || products.find((item) => Number(item.stock || 0) > 0) || products[0];
  const nameNode = document.querySelector("[data-hero-name]");
  const categoryNode = document.querySelector("[data-hero-category]");
  const availabilityNode = document.querySelector("[data-hero-availability]");
  const typeNode = document.querySelector("[data-hero-type]");
  const priceNode = document.querySelector("[data-hero-price]");
  const addButton = document.querySelector("[data-hero-add]");
  if (!product) {
    visual.innerHTML = '<div class="hero-placeholder"><span>玩具</span><small>目前沒有上架商品</small></div>';
    if (nameNode) nameNode.textContent = "等待下一個喜歡的";
    if (availabilityNode) availabilityNode.textContent = "暫無商品";
    if (addButton) { addButton.disabled = true; addButton.removeAttribute("data-hero-add"); addButton.textContent = "暫無商品"; }
    return;
  }
  const productName = product.product_name || product.name || "好頑選物";
  if (categoryNode) categoryNode.textContent = product.category || "好頑選物";
  if (availabilityNode) availabilityNode.textContent = productAvailability(product);
  if (typeNode) typeNode.textContent = `${product.category || "TOYS"} · ${product.type || "選物"}`;
  if (nameNode) nameNode.textContent = productName;
  if (priceNode) priceNode.textContent = money(Number(product.price || 0));
  visual.innerHTML = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(productName)}" />`
    : `<div class="hero-placeholder"><span>${productMark(product)}</span><small>${product.type === "現貨" ? "READY TO PLAY" : "COMING FROM AFAR"}</small></div>`;
  if (addButton) {
    const available = Number(product.stock || 0) > 0;
    addButton.dataset.heroAdd = product.id;
    addButton.disabled = !available;
    addButton.textContent = available ? "加入選物盒" : "目前無庫存";
  }
}
function renderProducts() {
  const keyword = search.value.trim().toLowerCase();
  const visible = products.filter((product) => (activeCategory === "all" || product.category === activeCategory || product.type === activeCategory) && `${product.category}${product.name}`.toLowerCase().includes(keyword));
  grid.innerHTML = visible.length ? visible.map((product) => `<article class="product-card" data-product-id="${escapeHtml(product.id)}"><div class="product-image">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" loading="lazy" />` : `<div class="product-placeholder"><span>${productMark(product)}</span><small>潮吉好頑選物</small></div>`}</div><div class="product-info"><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.type)}</span><h3>${escapeHtml(product.name)}</h3><p class="stock">${escapeHtml(productAvailability(product))}</p><div class="price">${money(Number(product.price || 0))}</div><div class="card-actions"><button type="button" data-add="${escapeHtml(product.id)}">加入選物盒</button><button type="button" class="detail-button" data-detail="${escapeHtml(product.id)}">查看規格</button></div></div></article>`).join("") : "<p class=\"empty-state\">目前沒有符合的商品。</p>";
}
function renderCart() {
  const items = document.querySelector("#cart-items");
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll("[data-cart-count]").forEach((node) => node.textContent = count);
  document.querySelector("[data-tray-count]")?.replaceChildren(document.createTextNode(`${count} 件`));
  document.querySelector("[data-tray-total]")?.replaceChildren(document.createTextNode(money(total)));
  document.querySelector("#selection-tray")?.classList.toggle("has-items", count > 0);
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  updateCartCheckoutAction();
  document.querySelector("#cart-total").textContent = money(total);
  document.querySelector("#cart-empty").classList.toggle("hidden", cart.length > 0);
  items.innerHTML = cart.map((item) => `<div class="cart-item"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price)} · ${escapeHtml(item.category)}</small><div class="quantity"><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1">−</button><b>${item.quantity}</b><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1">＋</button></div></div><div><strong>${money(item.price * item.quantity)}</strong><button class="remove" type="button" data-remove="${escapeHtml(item.id)}">移除</button></div></div>`).join("");
}
function saveCart() { sessionStorage.setItem("cj-cart", JSON.stringify(cart)); }
function addToCart(id) { const product = products.find((item) => item.id === id); const existing = cart.find((item) => item.id === id); if (existing) { if (existing.quantity >= product.stock) return showToast("已達可選購庫存上限"); existing.quantity += 1; } else cart.push({ ...product, quantity: 1 }); saveCart(); renderCart(); showToast(`${product.name} 已加入購物車`); }
function toggleCart() { const drawer = document.querySelector("#cart-drawer"); const open = drawer.classList.toggle("open"); document.querySelector(".overlay").classList.toggle("visible", open); drawer.setAttribute("aria-hidden", String(!open)); }
function selectedCartDeliveryMethod() { return cartDeliveryMethod; }
function setCartDeliveryMethod(method) {
  if (!["store_pickup", "seller_delivery", "home_delivery"].includes(method)) return;
  cartDeliveryMethod = method;
  try { sessionStorage.setItem("cj-cart-delivery-method", method); } catch { /* ignore restricted storage */ }
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  updateCartCheckoutAction();
}
function updateCartCheckoutAction() {
  const button = document.querySelector("#cart-drawer [data-checkout]");
  if (!button) return;
  const sellerCheckout = selectedCartDeliveryMethod() === "seller_delivery";
  button.textContent = sellerCheckout ? "前往賣貨便結帳" : "前往 結帳";
  button.setAttribute("aria-label", sellerCheckout ? "前往賣貨便結帳" : "前往本站結帳");
  button.classList.toggle("seller-checkout-button", sellerCheckout);
}
async function openSellerDeliveryCheckout() {
  if (!cart.length) return showToast("請先加入商品");
  const links = [...new Set(cart.map((item) => item.link || item.seller_link).filter(Boolean))];
  if (!links.length) return showToast("購物車商品尚未設定賣貨便連結，請改選其他取貨方式");
  if (links.length > 1) return showToast("購物車內商品屬於不同賣場，請分開前往賣貨便結帳");
  if (cart.some((item) => item.type === "預購")) return showToast("賣貨便核對流程目前僅適用現貨商品，預購請改選本站結帳");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const button = document.querySelector("#cart-drawer [data-checkout]");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "建立待確認紀錄…";
  }
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        items: cart.map((item) => ({ variant_id: item.id, quantity: item.quantity })),
        pickup_plan: "together",
        delivery_method: "seller_delivery",
        payment_method: "store_payment"
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || "賣貨便待確認訂單建立失敗");
    cart.splice(0);
    saveCart();
    renderCart();
    window.location.assign(links[0]);
  } catch (error) {
    showToast(error.message);
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      updateCartCheckoutAction();
    }
  }
}
function handleCartCheckout() {
  if (selectedCartDeliveryMethod() === "seller_delivery") return openSellerDeliveryCheckout();
  openCheckout();
}
function removeLegacySellerCheckoutOption() {
  const sellerInput = document.querySelector("input[name='delivery_method'][value='seller_delivery']");
  sellerInput?.closest("label")?.remove();
}

function detailVariants(product) {
  if (!product?.product_id) return [product].filter(Boolean);
  return products.filter((item) => item.product_id === product.product_id);
}

function renderProductDetail() {
  const container = document.querySelector("#product-detail-content");
  const product = products.find((item) => item.id === activeDetailProductId);
  if (!container || !product) return;
  const variants = detailVariants(product);
  const purchaseLimit = Number.isInteger(Number(product.purchase_limit)) && Number(product.purchase_limit) > 0 ? Number(product.purchase_limit) : null;
  const maxQuantity = purchaseLimit ? Math.min(product.stock, purchaseLimit) : product.stock;
  const variantOptions = variants.length > 1 ? `<label class="product-detail-field">選擇規格<select id="product-detail-variant">${variants.map((variant) => `<option value="${escapeHtml(variant.id)}" ${variant.id === product.id ? "selected" : ""}>${escapeHtml(variant.variant_name || variant.name)} · ${money(variant.price)} · ${variant.type === "現貨" ? `庫存 ${variant.stock}` : "預購"}</option>`).join("")}</select></label>` : `<p class="product-detail-variant"><strong>規格</strong>${escapeHtml(product.variant_name || "單一規格")}</p>`;
  const stockText = product.type === "現貨" ? `現貨庫存 ${product.stock} 件` : `預購${product.preorder_arrival ? `，預計 ${escapeHtml(product.preorder_arrival)} 到貨` : "，訂金 50%"}`;
  container.innerHTML = `<div class="product-detail-layout"><div class="product-detail-image">${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" />` : `<div class="product-placeholder"><span>${productMark(product)}</span><small>潮吉好頑選物</small></div>`}</div><div class="product-detail-info"><span class="product-category">${escapeHtml(product.category)} · ${escapeHtml(product.type)}</span><h2>${escapeHtml(product.product_name || product.name)}</h2><p class="product-detail-description">${escapeHtml(product.description || "尚未填寫商品說明")}</p>${variantOptions}<div class="product-detail-meta"><span>${escapeHtml(stockText)}</span><strong>${money(product.price)}</strong></div>${purchaseLimit ? `<small class="product-detail-limit">每位會員限購 ${purchaseLimit} 件</small>` : ""}<label class="product-detail-field">數量<input id="product-detail-quantity" type="number" min="1" max="${Math.max(maxQuantity, 1)}" step="1" value="${maxQuantity > 0 ? 1 : 0}" ${maxQuantity > 0 ? "" : "disabled"} /></label><button class="primary-button product-detail-add" type="button" data-detail-add ${maxQuantity > 0 ? "" : "disabled"}>${maxQuantity > 0 ? "加入購物車" : "目前無可售庫存"}</button></div></div>`;
}

function openProductDetail(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  activeDetailProductId = product.id;
  renderProductDetail();
  const dialog = document.querySelector("#product-detail-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function addDetailToCart() {
  const variantSelect = document.querySelector("#product-detail-variant");
  const quantityInput = document.querySelector("#product-detail-quantity");
  const variant = products.find((item) => item.id === (variantSelect?.value || activeDetailProductId));
  if (!variant || !quantityInput) return;
  const purchaseLimit = Number.isInteger(Number(variant.purchase_limit)) && Number(variant.purchase_limit) > 0 ? Number(variant.purchase_limit) : null;
  const maxQuantity = purchaseLimit ? Math.min(variant.stock, purchaseLimit) : variant.stock;
  const quantity = Number(quantityInput.value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) return showToast(`數量需介於 1 至 ${Math.max(maxQuantity, 1)} 件`);
  const existing = cart.find((item) => item.id === variant.id);
  if (existing && existing.quantity + quantity > maxQuantity) return showToast("已達可選購庫存或限購上限");
  if (existing) existing.quantity += quantity;
  else cart.push({ ...variant, quantity });
  saveCart();
  renderCart();
  document.querySelector("#product-detail-dialog")?.close();
  showToast(`${variant.name} 已加入購物車`);
}

function captureAuthSession() {
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (fragment.get("access_token")) {
    auth.accessToken = fragment.get("access_token");
    auth.refreshToken = fragment.get("refresh_token");
    auth.lineProviderToken = fragment.get("provider_token");
    sessionStorage.setItem("cj-auth", JSON.stringify({ accessToken: auth.accessToken, refreshToken: auth.refreshToken, lineProviderToken: auth.lineProviderToken }));
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem("cj-auth") || "null");
    auth.accessToken = saved?.accessToken ?? null;
    auth.refreshToken = saved?.refreshToken ?? null;
    auth.lineProviderToken = saved?.lineProviderToken ?? null;
  } catch { sessionStorage.removeItem("cj-auth"); }
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) auth.config = await response.json();
  } catch { auth.config = null; }
}

async function loadMember() {
  if (!auth.accessToken || !auth.config?.authEnabled) return;
  try {
    const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
    if (!response.ok) throw new Error("expired");
    auth.user = await response.json();
    await loadProfile();
    try { await loadPoints(); } catch { auth.points = null; }
    updateMemberButton();
    if (!profileIsComplete()) showProfileDialog(true);
  } catch {
    auth.accessToken = null; auth.refreshToken = null; auth.lineProviderToken = null; auth.user = null; auth.profile = null; auth.points = null; auth.lineFriendFlag = null; sessionStorage.removeItem("cj-auth");
  }
}

async function loadProfile() {
  const url = new URL(`${auth.config.supabaseUrl}/rest/v1/profiles`);
  url.searchParams.set("select", "full_name,phone,birthday,address,is_admin");
  url.searchParams.set("id", `eq.${auth.user.id}`);
  const response = await fetch(url, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
  if (!response.ok) throw new Error("會員資料讀取失敗");
  const rows = await response.json();
  auth.profile = rows[0] ?? { full_name: null, phone: null, birthday: null, address: null };
}

async function loadPoints() {
  const response = await fetch("/api/member/points", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "點數資料讀取失敗");
  auth.points = result;
  renderMemberPoints();
}

function renderMemberPoints() {
  const summary = document.querySelector("#member-points-summary");
  if (!auth.points) return summary.classList.add("hidden");
  summary.classList.remove("hidden");
  document.querySelector("[data-member-point-balance]").textContent = `${auth.points.balance || 0} 點`;
  const settings = auth.points.settings;
  document.querySelector("[data-member-point-rule]").textContent = settings
    ? `每消費 ${money(settings.earn_amount_per_point)} 累積 1 點；每點可折抵 ${money(settings.point_value)}，點數永不到期。`
    : "完成訂單後累積點數，點數永不到期。";
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  const entries = (auth.points.ledger || []).slice(0, 10);
  document.querySelector("#member-point-history").innerHTML = entries.length
    ? entries.map((entry) => `<div class="member-point-entry"><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)} · ${escapeHtml(entry.reason)}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong></div>`).join("")
    : '<p class="dialog-copy">目前沒有點數紀錄。</p>';
  let couponList = document.querySelector("#member-coupon-list");
  if (!couponList) {
    summary.insertAdjacentHTML("beforeend", '<details><summary>我的優惠券</summary><div id="member-coupon-list"></div></details>');
    couponList = document.querySelector("#member-coupon-list");
  }
  const coupons = auth.points.coupons || [];
  couponList.innerHTML = coupons.length ? coupons.map((coupon) => `<div class="member-point-entry"><span><b>${escapeHtml(coupon.code)}</b> · ${escapeHtml(coupon.name)}<br /><small>至 ${new Date(coupon.valid_until).toLocaleDateString("zh-TW")}</small></span><strong>-${money(coupon.discount_amount)}</strong></div>`).join("") : '<p class="dialog-copy">目前沒有已發送的優惠券。</p>';
}

function profileIsComplete() {
  return Boolean(auth.profile?.full_name?.trim() && auth.profile?.phone?.trim());
}

function updateMemberButton() {
  const displayName = auth.profile?.full_name || auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "會員";
  const button = document.querySelector("[data-demo='login']");
  button.textContent = displayName;
  button.title = "查看或修改會員資料";
  document.querySelector("[data-orders-open]").classList.remove("hidden");
  document.querySelector("[data-admin-open]").classList.toggle("hidden", auth.profile?.is_admin !== true);
  if (auth.profile?.full_name) document.querySelector("#checkout-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-phone").value = auth.profile.phone;
  if (auth.profile?.address) document.querySelector("#checkout-address").value = auth.profile.address;
}

function showProfileDialog(required = false) {
  const dialog = document.querySelector("#profile-dialog");
  const metadataName = auth.user?.user_metadata?.name || auth.user?.user_metadata?.full_name || "";
  document.querySelector("#profile-name").value = auth.profile?.full_name || metadataName;
  document.querySelector("#profile-phone").value = auth.profile?.phone || "";
  document.querySelector("#profile-birthday").value = auth.profile?.birthday || "";
  document.querySelector("#profile-address").value = auth.profile?.address || "";
  document.querySelector("#profile-birthday").max = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  document.querySelector("#profile-error").classList.add("hidden");
  document.querySelector(".profile-close").classList.toggle("hidden", required);
  document.querySelector("#profile-dialog-title").textContent = required ? "完成會員資料" : "會員資料";
  document.querySelector("[data-profile-copy]").textContent = required
    ? "第一次使用 LINE 登入，請先填寫基本資料。姓名與手機為必填，生日與地址可稍後補上。"
    : "可在這裡更新聯絡資料；生日與地址為選填。";
  renderMemberPoints();
  dialog.dataset.required = String(required);
  if (!dialog.open) dialog.showModal();
}

function beginLineLogin() {
  if (!auth.config?.authEnabled) return showToast("LINE Login 尚未在 Supabase 啟用");
  saveCart();
  const redirectTo = location.origin + location.pathname;
  const url = new URL(`${auth.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", auth.config.lineProvider);
  url.searchParams.set("redirect_to", redirectTo);
  url.searchParams.set("bot_prompt", "normal");
  location.assign(url.toString());
}

async function saveProfile(profile) {
  const response = await fetch(`${auth.config.supabaseUrl}/rest/v1/profiles?id=eq.${auth.user.id}`, {
    method: "PATCH",
    headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(profile)
  });
  if (!response.ok) throw new Error("會員資料儲存失敗");
  const rows = await response.json();
  if (!rows.length) throw new Error("找不到會員資料，請重新登入後再試");
  auth.profile = rows[0];
  updateMemberButton();
}

async function submitProfile(event) {
  event.preventDefault();
  const submitButton = document.querySelector(".profile-submit");
  const fullName = document.querySelector("#profile-name").value.trim();
  const rawPhone = document.querySelector("#profile-phone").value.trim();
  const phone = rawPhone.replace(/[\s-]/g, "");
  const birthday = document.querySelector("#profile-birthday").value || null;
  const address = document.querySelector("#profile-address").value.trim() || null;
  document.querySelector("#profile-error").classList.add("hidden");
  if (!fullName) return showProfileError("請填寫姓名");
  if (!/^09\d{8}$/.test(phone)) return showProfileError("請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  submitButton.disabled = true;
  submitButton.textContent = "儲存中…";
  try {
    await saveProfile({ full_name: fullName, phone, birthday, address });
    document.querySelector("#checkout-name").value = fullName;
    document.querySelector("#checkout-phone").value = phone;
    document.querySelector("#profile-dialog").close();
    showToast("會員資料已儲存");
  } catch (error) {
    showProfileError(error.message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "儲存會員資料";
  }
}

function showProfileError(message) {
  const errorNode = document.querySelector("#profile-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

function renderCheckoutSummary() {
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const deliveryMethod = selectedDeliveryMethod();
  const points = Math.max(0, Number(document.querySelector("#checkout-points")?.value || 0));
  const settings = auth.points?.settings;
  const pointDiscount = settings ? Math.min(points * settings.point_value, total) : 0;
  const estimatedTotal = Math.max(total - pointDiscount, 0);
  document.querySelector("#checkout-order-summary").innerHTML = cart.map((item) => `<div><span>${escapeHtml(item.name)} × ${item.quantity}</span><span>${money(item.price * item.quantity)}</span></div>`).join("") + `<div><span>商品總額</span><span>${money(total)}</span></div>${pointDiscount ? `<div><span>點數折抵（最終以系統計算為準）</span><span>-${money(pointDiscount)}</span></div>` : ""}<div><span>預估應付總額</span><span>${money(estimatedTotal)}</span></div><p class="checkout-summary-note"><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod])}</strong>：${escapeHtml(deliveryMethodNotes[deliveryMethod])}</p>`;
}

function ensureShippingRecipientFields() {
  const addressLabel = document.querySelector("#checkout-address-label");
  if (!addressLabel || document.querySelector("#checkout-recipient-name-label")) return;
  addressLabel.insertAdjacentHTML("beforebegin", '<label id="checkout-recipient-name-label" class="hidden">宅配收件人姓名 <input id="checkout-recipient-name" maxlength="60" autocomplete="name" placeholder="請填寫收件人姓名" /></label><label id="checkout-recipient-phone-label" class="hidden">宅配收件人電話 <input id="checkout-recipient-phone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="09xx-xxx-xxx" /></label>');
  if (auth.profile?.full_name) document.querySelector("#checkout-recipient-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-recipient-phone").value = auth.profile.phone;
}

function ensurePaymentMethodUI() {
  const bankAccounts = document.querySelector("#checkout-bank-accounts");
  const bankFieldset = bankAccounts?.closest("fieldset");
  if (bankFieldset) bankFieldset.id = "checkout-bank-fieldset";
  if (bankFieldset && !document.querySelector("#payment-method-fieldset")) {
    bankFieldset.insertAdjacentHTML("beforebegin", '<fieldset id="payment-method-fieldset"><legend>付款方式</legend><label class="radio"><input checked type="radio" name="payment_method" value="bank_transfer" /> <span><strong>匯款／轉帳</strong><small>匯款後回報帳號末五碼，管理員確認後保留庫存。</small></span></label><label id="store-payment-option" class="radio"><input type="radio" name="payment_method" value="store_payment" /> <span><strong>到店支付</strong><small>僅限到店取貨的現貨商品，取貨時現金或轉帳付款。</small></span></label></fieldset>');
  }
  const lastFive = document.querySelector("#payment-last-five");
  const lastFiveLabel = lastFive?.closest("label");
  if (lastFiveLabel) lastFiveLabel.id = "payment-last-five-label";
  const paymentForm = document.querySelector("#payment-form");
  if (paymentForm && !document.querySelector("#payment-store-note")) paymentForm.insertAdjacentHTML("beforeend", '<p id="payment-store-note" class="dialog-copy hidden">此訂單選擇到店支付，不需要回報匯款末五碼；請依通知時間到店付款取貨。</p>');
}

function syncDeliveryFields() {
  ensureShippingRecipientFields();
  const method = selectedDeliveryMethod();
  const planFieldset = document.querySelector("#pickup-plan-fieldset");
  const addressLabel = document.querySelector("#checkout-address-label");
  const addressInput = document.querySelector("#checkout-address");
  const recipientLabel = document.querySelector("#checkout-recipient-name-label");
  const recipientInput = document.querySelector("#checkout-recipient-name");
  const recipientPhoneLabel = document.querySelector("#checkout-recipient-phone-label");
  const recipientPhoneInput = document.querySelector("#checkout-recipient-phone");
  const isHome = method === "home_delivery";
  if (planFieldset) planFieldset.classList.toggle("hidden", method !== "store_pickup");
  if (addressLabel) addressLabel.classList.toggle("hidden", !isHome);
  if (addressInput) addressInput.required = isHome;
  if (recipientLabel) recipientLabel.classList.toggle("hidden", !isHome);
  if (recipientInput) recipientInput.required = isHome;
  if (recipientPhoneLabel) recipientPhoneLabel.classList.toggle("hidden", !isHome);
  if (recipientPhoneInput) recipientPhoneInput.required = isHome;
  syncPaymentFields();
  renderCheckoutSummary();
}

function syncPaymentFields() {
  const method = selectedDeliveryMethod();
  const hasPreorder = cart.some((item) => item.type === "預購");
  const storeOption = document.querySelector("#store-payment-option");
  const storeInput = document.querySelector("input[name='payment_method'][value='store_payment']");
  const bankFieldset = document.querySelector("#checkout-bank-fieldset");
  const canPayAtStore = method === "store_pickup" && !hasPreorder;
  if (storeOption) storeOption.classList.toggle("hidden", !canPayAtStore);
  if (storeInput) {
    storeInput.disabled = !canPayAtStore;
    if (!canPayAtStore && storeInput.checked) {
      const bankInput = document.querySelector("input[name='payment_method'][value='bank_transfer']");
      if (bankInput) bankInput.checked = true;
    }
  }
  if (bankFieldset) bankFieldset.classList.toggle("hidden", selectedPaymentMethod() !== "bank_transfer");
  const submitButton = document.querySelector(".checkout-submit");
  if (submitButton && selectedPaymentMethod() === "store_payment") submitButton.textContent = "建立到店支付訂單";
  else if (submitButton) submitButton.textContent = "建立訂單";
}

function ensureCheckoutBenefits() {
  if (document.querySelector("#checkout-coupon-code")) return;
  document.querySelector("#checkout-order-summary").insertAdjacentHTML("afterend", '<section class="checkout-benefits"><h3>優惠折抵</h3><label>優惠碼<input id="checkout-coupon-code" maxlength="32" placeholder="輸入優惠碼（選填）" list="member-coupon-options" /><datalist id="member-coupon-options"></datalist></label><label>使用點數<input id="checkout-points" type="number" min="0" step="1" value="0" /><small id="checkout-point-help">未使用點數</small></label><p>優惠券適用商品、使用次數與併用規則會在建立訂單時由系統驗證。</p></section>');
}

function renderCheckoutBenefits() {
  ensureCheckoutBenefits();
  const balance = auth.points?.balance || 0;
  const settings = auth.points?.settings;
  const pointsInput = document.querySelector("#checkout-points");
  pointsInput.max = String(balance);
  document.querySelector("#checkout-point-help").textContent = settings ? `可用 ${balance} 點；最低 ${settings.min_redeem_points} 點，每點折 ${money(settings.point_value)}` : "點數資料載入中";
  document.querySelector("#member-coupon-options").innerHTML = (auth.points?.coupons || []).map((coupon) => `<option value="${escapeHtml(coupon.code)}">${escapeHtml(coupon.name)} · 折 ${money(coupon.discount_amount)} · 至 ${new Date(coupon.valid_until).toLocaleDateString("zh-TW")}</option>`).join("");
}

async function loadBankAccounts(force = false) {
  const container = document.querySelector("#checkout-bank-accounts");
  const submitButton = document.querySelector(".checkout-submit");
  if (bankAccounts.length && !force) return renderBankAccounts();
  container.innerHTML = '<p class="dialog-copy">載入收款帳戶中…</p>';
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/bank-accounts", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "收款帳戶載入失敗");
    bankAccounts = Array.isArray(result.accounts) ? result.accounts : [];
    renderBankAccounts();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    submitButton.disabled = true;
  }
}

function renderBankAccounts() {
  const container = document.querySelector("#checkout-bank-accounts");
  const submitButton = document.querySelector(".checkout-submit");
  if (!bankAccounts.length) {
    container.innerHTML = '<p class="form-error">商店尚未設定收款帳戶，目前無法建立訂單，請聯繫 LINE 客服。</p>';
    submitButton.disabled = selectedPaymentMethod() !== "store_payment";
    return;
  }
  container.innerHTML = bankAccounts.map((account, index) => `<label class="bank-option"><input type="radio" name="bank_account" value="${escapeHtml(account.id)}" ${index === 0 ? "checked" : ""} /><span><strong>${escapeHtml(account.label || account.bank_name)}</strong><small>${escapeHtml(account.bank_name)} ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></span></label>`).join("");
  submitButton.disabled = false;
  syncPaymentFields();
}

function showLineFriendDialog(message = "請先加入潮吉好頑官方 LINE，才能建立訂單並收到訂單狀態通知。") {
  const dialog = document.querySelector("#line-friend-dialog");
  const error = document.querySelector("#line-friend-error");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
  if (dialog && !dialog.open) dialog.showModal();
}

async function checkLineFriendship() {
  if (!auth.accessToken || !auth.user) return false;
  const response = await fetch("/api/member/line-friendship", { headers: { Authorization: `Bearer ${auth.accessToken}`, ...(auth.lineProviderToken ? { "X-LINE-Login-Access-Token": auth.lineProviderToken } : {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "LINE 好友狀態暫時無法確認");
  auth.lineFriendFlag = result.friendFlag === true;
  return auth.lineFriendFlag;
}

async function requireLineFriendshipForCheckout() {
  try {
    const isFriend = await checkLineFriendship();
    if (isFriend) return true;
    showLineFriendDialog();
    return false;
  } catch (error) {
    showLineFriendDialog(error.message);
    return false;
  }
}

async function openCheckout() {
  if (!cart.length) return showToast("請先加入商品");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  removeLegacySellerCheckoutOption();
  const cartMethod = selectedCartDeliveryMethod();
  if (cartMethod !== "seller_delivery") {
    const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${cartMethod}']`);
    if (deliveryInput) deliveryInput.checked = true;
  }
  try { await loadPoints(); } catch { /* 結帳仍可不使用優惠 */ }
  if (document.querySelector("#cart-drawer").classList.contains("open")) toggleCart();
  ensurePaymentMethodUI();
  renderCheckoutBenefits();
  syncDeliveryFields();
  renderCheckoutSummary();
  document.querySelector("#checkout-error").classList.add("hidden");
  document.querySelector("#checkout-dialog").showModal();
  await loadBankAccounts();
}

function bankAccountFromOrder(order) {
  return Array.isArray(order.bank_accounts) ? order.bank_accounts[0] : order.bank_accounts;
}

function renderPaymentOrder(order) {
  ensurePaymentMethodUI();
  const account = bankAccountFromOrder(order);
  const balance = Math.max(order.amount_due - order.deposit_due, 0);
  const deliveryMethod = order.delivery_method || "store_pickup";
  const storePayment = !order.bank_account_id;
  const sellerDelivery = deliveryMethod === "seller_delivery";
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運。" : sellerDelivery ? "賣貨便運費由 7-11 於取貨時向客戶收取，不計入訂單；如有尾款，請依客服通知完成付款。" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}；請將尾款與運費一併匯款，確認入帳後安排寄出。` : "到貨後由客服通知實際運費，請將尾款與運費一併匯款，確認入帳後安排寄出。";
  const paymentText = sellerDelivery ? "賣貨便付款（外部）" : storePayment ? "到店支付" : "匯款／轉帳";
  const bankDetail = sellerDelivery ? "此訂單需在 7-ELEVEN 賣貨便完成付款，本站不收取賣貨便款項。" : storePayment ? "到店取貨時支付，不需回報匯款末五碼。" : `<strong>${escapeHtml(account?.label || account?.bank_name || "收款帳戶")}</strong><br />銀行：${escapeHtml(account?.bank_name || "-")}<br />帳號：${escapeHtml(account?.account_number || "-")}<br />戶名：${escapeHtml(account?.account_name || "-")}`;
  document.querySelector("#payment-order-detail").innerHTML = `<div class="payment-order-card"><h3>${escapeHtml(order.order_number)}</h3><div class="payment-row"><span>取貨方式</span><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod] || "到店取貨")}</strong></div><div class="payment-row"><span>付款方式</span><strong>${paymentText}</strong></div><div class="payment-row"><span>商品原價</span><strong>${money(order.subtotal)}</strong></div>${order.coupon_discount ? `<div class="payment-row"><span>優惠券</span><strong>-${money(order.coupon_discount)}</strong></div>` : ""}${order.point_discount ? `<div class="payment-row"><span>點數折抵</span><strong>-${money(order.point_discount)}</strong></div>` : ""}${deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${sellerDelivery ? "賣貨便運費" : "實際運費"}</span><strong>${sellerDelivery ? "由 7-11 向客戶收取" : order.shipping_fee ? money(order.shipping_fee) : "待客服通知"}</strong></div>` : ""}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div><div class="payment-row amount"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>${balance ? `<div class="payment-row"><span>尾款／運費</span><strong>${money(balance)}</strong></div>` : ""}<p class="dialog-copy">${escapeHtml(deliveryNotice)}</p>${order.shipping_address ? `<p class="dialog-copy">宅配地址：${escapeHtml(order.shipping_address)}</p>` : ""}<div class="bank-detail">${bankDetail}</div><p class="deadline">付款／保留期限：${formatDateTime(order.payment_deadline)}</p></div>`;
  document.querySelector("#payment-last-five-label")?.classList.toggle("hidden", storePayment);
  const lastFiveInput = document.querySelector("#payment-last-five");
  if (lastFiveInput) lastFiveInput.required = !storePayment;
  document.querySelector(".payment-submit")?.classList.toggle("hidden", storePayment);
  document.querySelector("#payment-store-note")?.classList.toggle("hidden", !storePayment);
}

function showPaymentDialog(order) {
  activePaymentOrder = order;
  renderPaymentOrder(order);
  document.querySelector("#payment-last-five").value = "";
  document.querySelector("#payment-error").classList.add("hidden");
  const dialog = document.querySelector("#payment-dialog");
  if (!dialog.open) dialog.showModal();
}

function showCheckoutError(message) {
  const errorNode = document.querySelector("#checkout-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

async function submitOrder() {
  if (!auth.config?.authEnabled) return showToast("目前為靜態預覽，尚未連接訂單資料庫");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const fullName = document.querySelector("#checkout-name").value.trim();
  const phone = document.querySelector("#checkout-phone").value.trim();
  const deliveryMethod = selectedDeliveryMethod();
  const paymentMethod = selectedPaymentMethod();
  const pickupPlan = document.querySelector("input[name='pickup']:checked")?.value || "together";
  const shippingAddress = document.querySelector("#checkout-address").value.trim();
  const shippingRecipientName = document.querySelector("#checkout-recipient-name")?.value.trim() || "";
  const shippingPhone = document.querySelector("#checkout-recipient-phone")?.value.trim() || "";
  const bankAccountId = paymentMethod === "bank_transfer" ? document.querySelector("input[name='bank_account']:checked")?.value : null;
  const normalizedPhone = phone.replace(/[\s-]/g, "");
  const normalizedShippingPhone = shippingPhone.replace(/[\s-]/g, "");
  if (!/^09\d{8}$/.test(normalizedPhone)) throw new Error("請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  if (paymentMethod === "store_payment" && (deliveryMethod !== "store_pickup" || cart.some((item) => item.type === "預購"))) throw new Error("到店支付僅適用到店取貨的現貨商品");
  if (paymentMethod === "bank_transfer" && !bankAccountId) throw new Error("請選擇收款帳戶");
  if (deliveryMethod === "home_delivery" && !shippingAddress) throw new Error("宅配請填寫收件地址");
  if (deliveryMethod === "home_delivery" && !shippingRecipientName) throw new Error("宅配請填寫收件人姓名");
  if (deliveryMethod === "home_delivery" && !/^09\d{8}$/.test(normalizedShippingPhone)) throw new Error("宅配請填寫有效的收件人手機號碼");
  await saveProfile({ full_name: fullName, phone: normalizedPhone, birthday: auth.profile?.birthday || null, address: deliveryMethod === "home_delivery" ? shippingAddress : (auth.profile?.address || null) });
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: cart.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, delivery_method: deliveryMethod, payment_method: paymentMethod, shipping_address: deliveryMethod === "home_delivery" ? shippingAddress : null, shipping_recipient_name: deliveryMethod === "home_delivery" ? shippingRecipientName : null, shipping_phone: deliveryMethod === "home_delivery" ? normalizedShippingPhone : null, bank_account_id: bankAccountId, coupon_code: document.querySelector("#checkout-coupon-code")?.value.trim() || null, points_to_redeem: Number(document.querySelector("#checkout-points")?.value || 0) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  await loadPoints().catch(() => {});
  cart.splice(0); saveCart(); renderCart(); document.querySelector("#checkout-dialog").close();
  showPaymentDialog(result.order);
}

async function submitPayment(event) {
  event.preventDefault();
  if (!activePaymentOrder) return;
  if (!activePaymentOrder.bank_account_id) return showToast("此訂單為到店支付，取貨時付款即可");
  const lastFive = document.querySelector("#payment-last-five").value.trim();
  const errorNode = document.querySelector("#payment-error");
  const submitButton = document.querySelector(".payment-submit");
  errorNode.classList.add("hidden");
  if (!/^\d{5}$/.test(lastFive)) {
    errorNode.textContent = "請輸入 5 位數字";
    return errorNode.classList.remove("hidden");
  }
  submitButton.disabled = true;
  submitButton.textContent = "送出中…";
  try {
    const response = await fetch(`/api/orders/${activePaymentOrder.id}/payment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bank_account_id: activePaymentOrder.bank_account_id, payment_last_five: lastFive })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "付款回報失敗");
    document.querySelector("#payment-dialog").close();
    activePaymentOrder = result.order;
    showToast("末五碼已送出，請等待管理員確認");
    await openOrders();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "送出末五碼，等待確認";
  }
}

function renderOrders() {
  const container = document.querySelector("#orders-list");
  if (!currentOrders.length) {
    container.innerHTML = '<p class="dialog-copy">目前還沒有訂單。</p>';
    return;
  }
  container.innerHTML = currentOrders.map((order) => {
    const items = (order.order_items || []).map((item) => `${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}`).join("<br />");
    const expired = order.status === "pending_payment" && new Date(order.payment_deadline) <= new Date();
    const deliveryMethod = order.delivery_method || "store_pickup";
    const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運" : deliveryMethod === "seller_delivery" ? "賣貨便運費由 7-11 於取貨時收取，不計入訂單" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}` : "運費到貨後由客服通知";
    const paymentNotice = deliveryMethod === "seller_delivery" ? "賣貨便付款（外部）" : order.bank_account_id ? "匯款／轉帳" : "到店支付";
    return `<article class="order-card"><div class="order-card-head"><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(deliveryMethodLabels[deliveryMethod] || "到店取貨")}</small></div><span class="status-chip">${expired ? "付款逾期" : escapeHtml(orderStatusLabels[order.status] || order.status)}</span></div><div class="order-items">${items}</div><div class="payment-row"><span>付款方式</span><strong>${paymentNotice}</strong></div><div class="payment-row"><span>配送費用</span><strong>${deliveryNotice}</strong></div><div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div><div class="payment-row"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>${deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>尾款／運費</span><strong>${order.final_payment_confirmed_at ? "已確認" : "待客服通知或確認"}</strong></div>` : ""}${order.bank_account_id && order.status === "pending_payment" && !expired ? `<button type="button" data-order-payment="${order.id}">回報匯款末五碼</button>` : ""}</article>`;
  }).join("");
}

async function openOrders() {
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const dialog = document.querySelector("#orders-dialog");
  const container = document.querySelector("#orders-list");
  container.innerHTML = '<p class="dialog-copy">載入訂單中…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const response = await fetch("/api/orders", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "訂單紀錄載入失敗");
    currentOrders = Array.isArray(result.orders) ? result.orders : [];
    renderOrders();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
}

async function adminFetch(path, options = {}) {
  const hasFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(options.body && !hasFormData ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "管理操作失敗");
  return result;
}

async function testLineNotification() {
  const button = document.querySelector("[data-line-test]");
  if (button) {
    button.disabled = true;
    button.textContent = "測試中…";
  }
  try {
    const result = await adminFetch("/api/admin/line-test", { method: "POST", body: JSON.stringify({}) });
    showToast(result.message || "LINE 測試通知已送出");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "測試 LINE 通知";
    }
  }
}

function relationOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function openAdmin() {
  if (!auth.user || auth.profile?.is_admin !== true) return showToast("僅限管理員使用");
  const dialog = document.querySelector("#admin-dialog");
  if (!dialog.open) dialog.showModal();
  await loadAdminData();
}

async function loadAdminData() {
  const loading = document.querySelector("#admin-loading");
  const errorNode = document.querySelector("#admin-error");
  loading.classList.remove("hidden");
  errorNode.classList.add("hidden");
  document.querySelectorAll(".admin-panel").forEach((panel) => panel.classList.add("hidden"));
  try {
    adminData = await adminFetch("/api/admin/dashboard");
    renderAdminData();
    switchAdminTab(document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview");
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
}

function switchAdminTab(tab) {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.toggle("active", button.dataset.adminTab === tab));
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.adminPanel !== tab));
}

function localDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function ensureDiscountAdminUI() {
  if (document.querySelector("[data-admin-tab='discounts']")) return;
  document.querySelector(".admin-nav").insertAdjacentHTML("beforeend", '<button type="button" data-admin-tab="discounts">優惠券</button>');
  document.querySelector(".admin-content").insertAdjacentHTML("beforeend", '<section class="admin-panel hidden" data-admin-panel="discounts"><p class="eyebrow">COUPONS</p><h2>優惠券與生日券</h2><p class="dialog-copy">固定金額折扣；可限定商品、會員、期限、使用次數及是否可與點數併用。</p><details class="admin-create" open><summary>新增／編輯優惠券</summary><form id="admin-coupon-form" class="admin-form"><input id="coupon-id" type="hidden" /><div class="form-grid"><label>優惠碼<input id="coupon-code" required maxlength="32" pattern="[A-Za-z0-9_-]{3,32}" /></label><label>名稱<input id="coupon-name" required maxlength="80" /></label><label>固定折抵金額<input id="coupon-amount" required type="number" min="1" step="1" /></label><label>每位會員可用次數<input id="coupon-member-limit" required type="number" min="1" step="1" value="1" /></label><label>開始時間<input id="coupon-valid-from" required type="datetime-local" /></label><label>結束時間<input id="coupon-valid-until" required type="datetime-local" /></label><label>總使用次數<input id="coupon-total-limit" type="number" min="1" step="1" placeholder="留空代表不限" /></label><label class="check-field"><input id="coupon-combinable" type="checkbox" /> 可與點數併用</label><label class="check-field"><input id="coupon-active" type="checkbox" checked /> 啟用優惠券</label><fieldset class="wide coupon-scope"><legend>限定商品（未勾選代表全部）</legend><div id="coupon-product-options"></div></fieldset><fieldset class="wide coupon-scope"><legend>限定會員（未勾選代表全部）</legend><div id="coupon-member-options"></div></fieldset></div><div class="form-actions"><button class="primary-button" type="submit">儲存優惠券</button><button class="secondary-button" type="button" data-coupon-reset>清除／新增</button></div></form></details><details class="admin-create"><summary>生日券自動發送規則</summary><form id="birthday-coupon-form" class="admin-form"><div class="form-grid"><label>折抵金額<input id="birthday-amount" required type="number" min="1" step="1" value="100" /></label><label>生日前幾天發送<input id="birthday-before" required type="number" min="0" max="60" value="7" /></label><label>發送後有效天數<input id="birthday-valid-days" required type="number" min="1" max="365" value="30" /></label><label class="check-field"><input id="birthday-combinable" type="checkbox" /> 可與點數併用</label><label class="check-field"><input id="birthday-enabled" type="checkbox" /> 啟用自動生日券</label></div><div class="form-actions"><button class="primary-button" type="submit">儲存生日券規則</button><button class="secondary-button" type="button" data-birthday-issue>立即執行生日券發送</button></div></form></details><h3>優惠券列表</h3><div id="admin-coupon-list" class="admin-card-list"></div></section>');
  resetCouponForm();
}

function resetCouponForm() {
  document.querySelector("#admin-coupon-form").reset();
  document.querySelector("#coupon-id").value = "";
  document.querySelector("#coupon-active").checked = true;
  document.querySelector("#coupon-member-limit").value = "1";
  document.querySelector("#coupon-valid-from").value = localDateTime();
  document.querySelector("#coupon-valid-until").value = localDateTime(Date.now() + 30 * 86400000);
}

function renderAdminDiscounts() {
  const productBox = document.querySelector("#coupon-product-options");
  const memberBox = document.querySelector("#coupon-member-options");
  productBox.innerHTML = (adminData.products || []).map((product) => `<label><input type="checkbox" name="coupon_product" value="${product.id}" /> ${escapeHtml(product.name)}</label>`).join("") || "<small>尚無商品</small>";
  memberBox.innerHTML = (adminData.members || []).map((member) => `<label><input type="checkbox" name="coupon_member" value="${member.id}" /> ${escapeHtml(member.full_name || member.phone || "未命名會員")}</label>`).join("") || "<small>尚無會員</small>";
  const birthday = adminData.birthdaySettings;
  if (birthday) {
    document.querySelector("#birthday-amount").value = birthday.discount_amount;
    document.querySelector("#birthday-before").value = birthday.issue_days_before;
    document.querySelector("#birthday-valid-days").value = birthday.valid_days;
    document.querySelector("#birthday-combinable").checked = birthday.combinable_with_points;
    document.querySelector("#birthday-enabled").checked = birthday.enabled;
  }
  const list = document.querySelector("#admin-coupon-list");
  list.innerHTML = (adminData.coupons || []).map((coupon) => `<div class="admin-card coupon-card"><div><strong>${escapeHtml(coupon.code)} · ${escapeHtml(coupon.name)}</strong><small>折 ${money(coupon.discount_amount)} · ${coupon.combinable_with_points ? "可" : "不可"}與點數併用 · 已用 ${(coupon.coupon_redemptions || []).length}${coupon.total_usage_limit ? `/${coupon.total_usage_limit}` : ""} · ${coupon.is_active ? "啟用" : "停用"}<br />${new Date(coupon.valid_from).toLocaleString("zh-TW")} 至 ${new Date(coupon.valid_until).toLocaleString("zh-TW")}${coupon.is_birthday ? " · 生日券" : ""}</small></div>${coupon.is_birthday ? "" : `<button type="button" data-coupon-edit="${coupon.id}">編輯</button>`}</div>`).join("") || '<div class="empty-state">尚未建立優惠券。</div>';
}

function renderAdminData() {
  ensureDiscountAdminUI();
  Object.entries(adminData.stats || {}).forEach(([key, value]) => {
    const node = document.querySelector(`[data-stat="${key}"]`);
    if (node) node.textContent = value;
  });
  renderAdminAccounts();
  renderAdminOrders();
  renderAdminMembers();
  renderAdminProducts();
  renderAdminMovements();
  renderAdminSelects();
  renderAdminDiscounts();
  removeLegacyShippingUI();
}

function removeLegacyShippingUI() {
  document.querySelector("[data-admin-tab='shipping']")?.remove();
  document.querySelector("[data-admin-panel='shipping']")?.remove();
  const checkoutCopy = document.querySelector("#checkout-form > .dialog-copy");
  if (checkoutCopy) checkoutCopy.textContent = "確認後會保留商品；匯款訂單請在 24 小時內完成匯款並回報帳號末五碼，到店支付的現貨訂單最長保留 3 個月。賣貨便運費由 7-11 於取貨時向客戶收取，不計入本站訂單；宅配實際運費於商品到貨後由客服通知，請將尾款與運費一併匯款，確認後才安排寄出。";
  const checkoutTerms = document.querySelector("#checkout-form > .terms");
  if (checkoutTerms) checkoutTerms.textContent = "送出後將立即保留庫存；逾期未回報付款，系統會自動取消並釋放庫存。付款完成視同同意代購規則；賣貨便運費由 7-11 於取貨時收取，不計入本站訂單，宅配運費則於到貨後由客服通知，尾款與應付運費確認後才安排寄出，任何原因不接受退換貨。";
  const productCopy = document.querySelector("[data-admin-panel='products'] > .dialog-copy");
  if (productCopy) productCopy.textContent = "每件商品可上傳 1 張主圖，支援 JPG、PNG、WebP，上限 5MB。商品到貨後由客服通知取貨或寄送安排。";
  const orderCopy = document.querySelector("[data-admin-panel='orders'] > .dialog-copy");
  if (orderCopy) orderCopy.textContent = "確認訂金／付款後才會扣除庫存；賣貨便運費由 7-11 向客戶收取，不計入訂單；宅配到貨後再填寫實際運費，確認尾款與運費入帳後才安排寄出。";
  const ordersCopy = document.querySelector("#orders-dialog .dialog-copy");
  if (ordersCopy) ordersCopy.textContent = "可查看訂單狀態，匯款訂單可補填匯款帳號末五碼；到店支付訂單請依通知到店付款。";
}

function renderPointSettings() {
  const settings = adminData.pointSettings;
  if (!settings) return;
  document.querySelector("#point-earn-amount").value = settings.earn_amount_per_point;
  document.querySelector("#point-value").value = settings.point_value;
  document.querySelector("#point-min-redeem").value = settings.min_redeem_points;
  document.querySelector("#point-max-mode").value = settings.max_redeem_mode;
  document.querySelector("#point-max-value").value = settings.max_redeem_value;
  syncPointMaxHint();
}

function memberPointEntries(memberId) {
  return (adminData.pointEntries || []).filter((entry) => entry.member_id === memberId);
}

function renderAdminMembers() {
  renderPointSettings();
  const container = document.querySelector("#admin-member-list");
  const keyword = document.querySelector("#admin-member-search").value.trim().toLowerCase();
  const members = (adminData.members || []).filter((member) => `${member.full_name || ""} ${member.phone || ""}`.toLowerCase().includes(keyword));
  if (!members.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的會員。</div>';
    return;
  }
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  container.innerHTML = members.map((member) => {
    const entries = memberPointEntries(member.id).slice(0, 8);
    const history = entries.map((entry) => { const order = relationOne(entry.orders); const actor = relationOne(entry.actor); return `<li><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)}${order?.order_number ? ` · ${escapeHtml(order.order_number)}` : ""}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong><small>${formatDateTime(entry.created_at)} · ${escapeHtml(entry.reason)}${actor?.full_name ? ` · 操作：${escapeHtml(actor.full_name)}` : ""}</small></li>`; }).join("");
    const memberOrders = (adminData.orders || []).filter((order) => order.member_id === member.id).slice(0, 8);
    const orderHistory = memberOrders.map((order) => `<li><span>${escapeHtml(order.order_number)} · ${escapeHtml(orderStatusLabels[order.status] || order.status)}</span><strong>${money(order.amount_due)}</strong><small>${formatDateTime(order.created_at)} · ${order.delivery_method === "store_pickup" ? "到店取貨" : order.delivery_method === "seller_delivery" ? "賣貨便" : "宅配"}</small></li>`).join("");
    return `<article class="admin-member-card"><header><div><h3>${escapeHtml(member.full_name || "尚未填寫姓名")}${member.is_admin ? " · 管理員" : ""}</h3><small>${escapeHtml(member.phone || "尚未填寫手機")} · 加入於 ${formatDateTime(member.created_at)}</small></div><div class="member-metrics"><span>點數<b>${member.point_balance}</b></span><span>累積消費<b>${money(member.lifetime_spend)}</b></span><span>訂單<b>${member.order_count}</b></span></div></header><div class="member-extra"><span>生日：${escapeHtml(member.birthday || "未填")}</span><span>地址：${escapeHtml(member.address || "未填")}</span></div><form class="admin-point-adjust" data-admin-points-form="${member.id}"><label>異動點數<input name="points" required type="number" step="1" placeholder="增加填正數、扣除填負數" /></label><label>原因<input name="reason" required maxlength="200" placeholder="例如：活動贈點、人工更正" /></label><button class="secondary-button" type="submit">調整點數</button></form><details class="admin-order-history"><summary>消費紀錄（${member.order_count || 0}）</summary>${orderHistory ? `<ol class="member-ledger">${orderHistory}</ol>` : '<p>尚無消費紀錄。</p>'}</details><details class="admin-order-history"><summary>點數紀錄（${memberPointEntries(member.id).length}）</summary>${history ? `<ol class="member-ledger">${history}</ol>` : '<p>尚無點數紀錄。</p>'}</details></article>`;
  }).join("");
}

function syncPointMaxHint() {
  const mode = document.querySelector("#point-max-mode").value;
  const input = document.querySelector("#point-max-value");
  input.max = mode === "percent" ? "100" : "";
  document.querySelector("#point-max-hint").textContent = mode === "percent" ? "百分比請填 0–100" : "固定折抵金額（元）";
}

async function submitPointSettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/point-settings", { method: "PUT", body: JSON.stringify({
    earn_amount_per_point: Number(document.querySelector("#point-earn-amount").value),
    point_value: Number(document.querySelector("#point-value").value),
    min_redeem_points: Number(document.querySelector("#point-min-redeem").value),
    max_redeem_mode: document.querySelector("#point-max-mode").value,
    max_redeem_value: Number(document.querySelector("#point-max-value").value)
  }) });
  await loadAdminData();
  switchAdminTab("members");
  showToast("點數規則已儲存");
}

function editCoupon(couponId) {
  const coupon = (adminData.coupons || []).find((item) => item.id === couponId);
  if (!coupon) return;
  document.querySelector("#coupon-id").value = coupon.id;
  document.querySelector("#coupon-code").value = coupon.code;
  document.querySelector("#coupon-name").value = coupon.name;
  document.querySelector("#coupon-amount").value = coupon.discount_amount;
  document.querySelector("#coupon-member-limit").value = coupon.per_member_limit;
  document.querySelector("#coupon-valid-from").value = localDateTime(coupon.valid_from);
  document.querySelector("#coupon-valid-until").value = localDateTime(coupon.valid_until);
  document.querySelector("#coupon-total-limit").value = coupon.total_usage_limit || "";
  document.querySelector("#coupon-combinable").checked = coupon.combinable_with_points;
  document.querySelector("#coupon-active").checked = coupon.is_active;
  const productIds = new Set((coupon.coupon_products || []).map((item) => item.product_id));
  const memberIds = new Set((coupon.coupon_members || []).map((item) => item.member_id));
  document.querySelectorAll("[name='coupon_product']").forEach((input) => { input.checked = productIds.has(input.value); });
  document.querySelectorAll("[name='coupon_member']").forEach((input) => { input.checked = memberIds.has(input.value); });
  document.querySelector("#admin-coupon-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitCoupon(event) {
  event.preventDefault();
  const id = document.querySelector("#coupon-id").value;
  const totalLimit = document.querySelector("#coupon-total-limit").value;
  const body = {
    code: document.querySelector("#coupon-code").value.toUpperCase(), name: document.querySelector("#coupon-name").value,
    discount_amount: Number(document.querySelector("#coupon-amount").value), per_member_limit: Number(document.querySelector("#coupon-member-limit").value),
    valid_from: new Date(document.querySelector("#coupon-valid-from").value).toISOString(), valid_until: new Date(document.querySelector("#coupon-valid-until").value).toISOString(),
    total_usage_limit: totalLimit ? Number(totalLimit) : null, combinable_with_points: document.querySelector("#coupon-combinable").checked,
    is_active: document.querySelector("#coupon-active").checked,
    product_ids: [...document.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value),
    member_ids: [...document.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)
  };
  await adminFetch(id ? `/api/admin/coupons/${id}` : "/api/admin/coupons", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
  await loadAdminData(); resetCouponForm(); switchAdminTab("discounts"); showToast("優惠券已儲存");
}

async function submitBirthdaySettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/birthday-coupon-settings", { method: "PUT", body: JSON.stringify({ enabled: document.querySelector("#birthday-enabled").checked, discount_amount: Number(document.querySelector("#birthday-amount").value), issue_days_before: Number(document.querySelector("#birthday-before").value), valid_days: Number(document.querySelector("#birthday-valid-days").value), combinable_with_points: document.querySelector("#birthday-combinable").checked }) });
  await loadAdminData(); switchAdminTab("discounts"); showToast("生日券規則已儲存");
}

async function issueBirthdayCouponsNow() {
  if (!window.confirm("確定要立即執行生日券發送嗎？已發送過的會員不會重複取得。")) return;
  const result = await adminFetch("/api/admin/birthday-coupons/issue", { method: "POST" });
  await loadAdminData();
  switchAdminTab("discounts");
  showToast(`生日券發送完成（新增 ${result.issued || 0} 張）`);
}

async function submitMemberPointAdjustment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("會員點數表單資料無法讀取");
  const pointsField = form.querySelector("[name='points']");
  const reasonField = form.querySelector("[name='reason']");
  if (!(pointsField instanceof HTMLInputElement) || !(reasonField instanceof HTMLInputElement)) throw new Error("會員點數表單欄位不完整");
  const points = Number(pointsField.value);
  const reason = reasonField.value.trim();
  if (!Number.isInteger(points) || points === 0 || !reason) throw new Error("請填寫非 0 點數與異動原因");
  if (!window.confirm(`確定要${points > 0 ? "增加" : "扣除"} ${Math.abs(points)} 點？`)) return;
  await adminFetch(`/api/admin/members/${form.dataset.adminPointsForm}/points`, { method: "POST", body: JSON.stringify({ points, reason }) });
  await loadAdminData();
  switchAdminTab("members");
  showToast("會員點數已調整");
}

function adminOrderHistory(orderId) {
  return (adminData.orderHistory || []).filter((entry) => entry.order_id === orderId);
}

function renderAdminOrders() {
  const container = document.querySelector("#admin-order-list");
  const keyword = document.querySelector("#admin-order-search").value.trim().toLowerCase();
  const status = document.querySelector("#admin-order-status-filter").value;
  const orders = (adminData.orders || []).filter((order) => {
    const member = relationOne(order.profiles);
    const searchable = `${order.order_number} ${member?.full_name || ""} ${member?.phone || ""} ${order.payment_last_five || ""}`.toLowerCase();
    return (status === "all" || order.status === status) && searchable.includes(keyword);
  });
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的訂單。</div>';
    return;
  }
  container.innerHTML = orders.map((order) => {
    const member = relationOne(order.profiles);
    const account = relationOne(order.bank_accounts);
    const items = (order.order_items || []).map((item) => `<div><span>${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}</span><strong>${money(item.unit_price * item.quantity)}</strong></div>`).join("");
    const transitions = (adminOrderTransitions[order.status] || []).filter((item) => (!item.splitOnly || order.pickup_plan === "split") && (!item.storePaymentOnly || !order.bank_account_id));
    const options = transitions.map((item) => {
      const label = item.value === "confirmed" && order.delivery_method === "seller_delivery"
        ? "確認賣貨便訂單並扣除庫存"
        : item.value === "completed" && order.delivery_method === "seller_delivery"
          ? "確認賣貨便已取貨並完成訂單"
          : item.label;
      return `<option value="${item.value}">${escapeHtml(label)}</option>`;
    }).join("");
    const history = adminOrderHistory(order.id).slice(0, 5).map((entry) => { const actor = relationOne(entry.profiles); return `<li><span>${escapeHtml(orderStatusLabels[entry.from_status] || entry.from_status)} → ${escapeHtml(orderStatusLabels[entry.to_status] || entry.to_status)}</span><small>${formatDateTime(entry.created_at)}${actor?.full_name ? ` · ${escapeHtml(actor.full_name)}` : ""}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small></li>`; }).join("");
    const balance = Math.max(order.amount_due - order.paid_amount, 0);
    const deliveryLabel = deliveryMethodLabels[order.delivery_method || "store_pickup"] || "到店取貨";
    const shippingInfo = order.delivery_method === "home_delivery" ? `<p class="admin-order-note">收件人：${escapeHtml(order.shipping_recipient_name || "未填寫")}<br />電話：${escapeHtml(order.shipping_phone || "未填寫")}<br />地址：${escapeHtml(order.shipping_address || "未填寫")}</p>` : "";
    return `<article class="admin-order-card"><header><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(deliveryLabel)} · ${order.pickup_plan === "split" ? "分批取貨" : "等候到齊"}${order.confirmed_at || order.payment_confirmed_at ? ` · 確認：${formatDateTime(order.confirmed_at || order.payment_confirmed_at)}` : ""}</small></div><span class="status-chip status-${order.status}">${escapeHtml(orderStatusLabels[order.status] || order.status)}</span></header><div class="admin-order-member"><strong>${escapeHtml(member?.full_name || "未填姓名")}</strong><span>${escapeHtml(member?.phone || "未填手機")}</span></div><div class="admin-order-items">${items}</div><div class="admin-order-payment"><span>總額 <b>${money(order.amount_due)}</b></span><span>運費 <b>${order.shipping_fee ? money(order.shipping_fee) : "免運"}</b></span><span>訂金應付 <b>${money(order.deposit_due)}</b></span><span>已確認 <b>${money(order.paid_amount || 0)}</b></span><span>待收尾款 <b>${money(balance)}</b></span></div>${shippingInfo}<div class="admin-order-bank"><span>${escapeHtml(account?.label || account?.bank_name || "未指定帳戶")}</span><span>匯款末五碼：<b>${escapeHtml(order.payment_last_five || "尚未回報")}</b></span></div>${order.admin_note ? `<p class="admin-order-note">目前備註：${escapeHtml(order.admin_note)}</p>` : ""}${transitions.length ? `<form class="admin-order-action" data-admin-order-form="${order.id}"><label>下一步<select name="target_status">${options}</select></label><label>管理備註<textarea name="note" rows="2" maxlength="1000" placeholder="取消與退款相關操作必填；其他操作可選填"></textarea></label><button class="primary-button" type="submit">更新訂單</button></form>` : '<p class="admin-order-terminal">此訂單目前沒有可執行的下一步。</p>'}<details class="admin-order-history"><summary>狀態紀錄（${adminOrderHistory(order.id).length}）</summary>${history ? `<ol>${history}</ol>` : '<p>尚無管理異動紀錄。</p>'}</details></article>`;
  }).join("");
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const paymentNode = card.querySelector(".admin-order-payment > span:nth-child(2)");
    const order = orders[index];
    if (!paymentNode || !order) return;
    paymentNode.innerHTML = `付款方式 <b>${order.delivery_method === "seller_delivery" ? "賣貨便付款（外部）" : order.bank_account_id ? "匯款／轉帳" : "到店支付"}</b>`;
    const paymentGrid = card.querySelector(".admin-order-payment");
    const shippingFeeLabel = order.delivery_method === "store_pickup" ? "免運" : order.delivery_method === "seller_delivery" ? "由 7-11 收取" : order.shipping_fee ? money(order.shipping_fee) : "待客服通知";
    const balanceLabel = order.delivery_method === "store_pickup" ? "到店確認" : order.delivery_method === "seller_delivery" ? "依賣貨便訂單" : order.final_payment_confirmed_at ? "已確認" : "尚未確認";
    if (paymentGrid) paymentGrid.insertAdjacentHTML("beforeend", `<span>${order.delivery_method === "seller_delivery" ? "賣貨便運費" : "實際運費"} <b>${shippingFeeLabel}</b></span><span>尾款／運費 <b>${balanceLabel}</b></span>`);
    if (order.delivery_method === "home_delivery") {
      const form = document.createElement("form");
      form.className = "admin-fulfillment-form";
      form.dataset.adminFulfillmentForm = order.id;
      const shippingFeeField = order.delivery_method === "seller_delivery"
        ? '<input type="hidden" name="shipping_fee" value="0" /><p class="admin-order-terminal">賣貨便運費由 7-11 向客戶收取，不計入訂單金額。</p>'
        : `<label>實際運費<input name="shipping_fee" type="number" min="0" step="1" value="${Number(order.shipping_fee || 0)}" required /><small>到貨／包裝完成後填寫，會加入待收金額。</small></label>`;
      const finalPaymentLabel = order.delivery_method === "seller_delivery" ? "已確認尾款入帳" : "已確認尾款與運費入帳";
      const submitLabel = order.delivery_method === "seller_delivery" ? "儲存尾款／出貨資料" : "儲存尾款／運費";
      const notePlaceholder = order.delivery_method === "seller_delivery" ? "例如：7-11 取貨連結或客服通知日期" : "例如：宅配大箱運費、客服通知日期";
      form.innerHTML = `<div class="form-grid"><div>${shippingFeeField}</div><label>尾款匯款末五碼<input name="final_payment_last_five" maxlength="5" inputmode="numeric" pattern="[0-9]{5}" value="${escapeHtml(order.final_payment_last_five || "")}" placeholder="付款後填寫" /></label><label class="check-field"><input name="final_payment_confirmed" type="checkbox" ${order.final_payment_confirmed_at ? "checked" : ""} /> ${finalPaymentLabel}</label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="${notePlaceholder}">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="secondary-button" type="submit">${submitLabel}</button>`;
      card.insertBefore(form, card.querySelector(".admin-order-action") || card.querySelector(".admin-order-history"));
    }
  });
}

async function submitAdminOrderTransition(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("訂單表單資料無法讀取");
  const targetStatusField = form.querySelector("select[name='target_status']");
  const noteField = form.querySelector("textarea[name='note']");
  if (!(targetStatusField instanceof HTMLSelectElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("訂單表單欄位不完整");
  const targetStatus = targetStatusField.value;
  const note = noteField.value.trim();
  if (["cancelled", "refund_pending", "refunded"].includes(targetStatus) && !note) throw new Error("取消或退款相關操作必須填寫原因");
  const warning = targetStatus === "confirmed"
    ? "確認款項後會正式扣除商品庫存。確定繼續？"
    : targetStatus === "completed"
      ? "完成訂單代表商品已取走且尾款已收訖。確定繼續？"
      : ["cancelled", "refund_pending", "refunded"].includes(targetStatus)
        ? "此操作不會自動回補已扣除的庫存，後續可依個案從庫存異動調整。確定繼續？"
        : "確定更新此訂單狀態？";
  if (!window.confirm(warning)) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminOrderForm}/transition`, { method: "POST", body: JSON.stringify({ target_status: targetStatus, note }) });
    await loadAdminData();
    switchAdminTab("orders");
    showToast("訂單狀態已更新");
    await loadProducts();
    renderProducts();
  } finally {
    button.disabled = false;
  }
}

async function submitAdminOrderFulfillment(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("尾款與運費表單資料無法讀取");
  const shippingField = form.elements.namedItem("shipping_fee");
  const finalFiveField = form.elements.namedItem("final_payment_last_five");
  const confirmedField = form.elements.namedItem("final_payment_confirmed");
  const noteField = form.elements.namedItem("note");
  if (!(shippingField instanceof HTMLInputElement) || !(finalFiveField instanceof HTMLInputElement) || !(confirmedField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("尾款與運費表單欄位不完整");
  const shippingFee = Number(shippingField.value);
  const finalFive = finalFiveField.value.trim();
  const confirmed = confirmedField.checked;
  if (!Number.isInteger(shippingFee) || shippingFee < 0) throw new Error("實際運費必須是 0 或正整數");
  if (confirmed && !/^\d{5}$/.test(finalFive)) throw new Error("請填寫 5 位數尾款匯款末五碼");
  if (confirmed && !window.confirm("確認尾款與運費已入帳？確認後即可完成寄送訂單。")) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminFulfillmentForm}/fulfillment`, { method: "PATCH", body: JSON.stringify({ shipping_fee: shippingFee, final_payment_confirmed: confirmed, final_payment_last_five: finalFive || null, note: noteField.value.trim() }) });
    await loadAdminData();
    switchAdminTab("orders");
    showToast("尾款與實際運費已更新");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

function renderAdminAccounts() {
  const container = document.querySelector("#admin-account-list");
  const accounts = adminData.accounts || [];
  container.innerHTML = accounts.length ? accounts.map((account) => `<div class="admin-card"><div><strong>${escapeHtml(account.label)} ${account.is_active ? "" : "（已停用）"}</strong><small>${escapeHtml(account.bank_name)} · ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></div><button type="button" data-account-edit="${account.id}">編輯</button></div>`).join("") : '<div class="empty-state">尚未設定收款帳戶；新增後前台才可建立訂單。</div>';
}

function renderAdminSelects() {
  const products = adminData.products || [];
  const productOptions = products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
  document.querySelector("#admin-variant-product").innerHTML = productOptions || '<option value="">請先建立商品</option>';
  const variantOptions = products.flatMap((product) => (product.product_variants || []).map((variant) => `<option value="${variant.id}">${escapeHtml(product.name)} · ${escapeHtml(variant.name)}（庫存 ${variant.stock_on_hand}）</option>`)).join("");
  document.querySelector("#admin-inventory-variant").innerHTML = variantOptions || '<option value="">目前沒有商品規格</option>';
}

function renderAdminProducts() {
  const container = document.querySelector("#admin-product-list");
  if (!document.querySelector("#admin-product-search")) {
    container.insertAdjacentHTML("beforebegin", '<div class="admin-order-toolbar admin-product-toolbar"><label>搜尋商品<input id="admin-product-search" type="search" placeholder="商品名稱、分類、規格或 SKU" /></label><label>上架狀態<select id="admin-product-status"><option value="all">全部商品</option><option value="published">已上架</option><option value="unpublished">未上架</option></select></label></div>');
  }
  const keyword = document.querySelector("#admin-product-search")?.value.trim().toLowerCase() || "";
  const status = document.querySelector("#admin-product-status")?.value || "all";
  const products = (adminData.products || []).filter((product) => {
    const category = relationOne(product.categories)?.name || "";
    const variants = product.product_variants || [];
    const searchable = `${product.name} ${category} ${variants.map((variant) => `${variant.name} ${variant.sku}`).join(" ")}`.toLowerCase();
    return searchable.includes(keyword) && (status === "all" || (status === "published" ? product.is_published : !product.is_published));
  });
  if (!products.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的商品。</div>';
    removeLegacyShippingUI();
    return;
  }
  container.innerHTML = products.map((product, index) => {
    const category = relationOne(product.categories)?.name || "未分類";
    const productVariants = product.product_variants || [];
    const totalStock = productVariants.reduce((sum, variant) => sum + variant.stock_on_hand, 0);
    const publishedVariants = productVariants.filter((variant) => variant.is_published).length;
    const prices = productVariants.map((variant) => variant.price);
    const priceRange = prices.length ? `${money(Math.min(...prices))}${Math.min(...prices) === Math.max(...prices) ? "" : `–${money(Math.max(...prices))}`}` : "尚無價格";
    const imageUrl = product.image_path ? `/api/product-images/${product.id}?v=${encodeURIComponent(product.image_updated_at || "1")}` : "";
    const variants = productVariants.map((variant) => {
      const lowStock = variant.stock_on_hand <= variant.safety_stock;
      return `<details class="admin-variant-card"><summary><span class="variant-identity"><b>${escapeHtml(variant.name)}</b><small>SKU ${escapeHtml(variant.sku)}</small></span><span class="variant-summary"><em class="admin-chip ${variant.kind === "preorder" ? "chip-preorder" : ""}">${variant.kind === "preorder" ? "預購" : "現貨"}</em><em class="admin-chip ${lowStock ? "chip-warning" : ""}">庫存 ${variant.stock_on_hand}</em><strong>${money(variant.price)}</strong>${variant.is_published ? "" : '<em class="admin-chip chip-muted">未上架</em>'}</span></summary><form class="admin-form" data-edit-variant-form="${variant.id}"><div class="form-grid"><label>規格名稱<input name="name" required value="${escapeHtml(variant.name)}" /></label><label>SKU<input name="sku" required value="${escapeHtml(variant.sku)}" /></label><label>類型<select name="kind"><option value="in_stock" ${variant.kind === "in_stock" ? "selected" : ""}>現貨</option><option value="preorder" ${variant.kind === "preorder" ? "selected" : ""}>預購</option></select></label><label>售價<input name="price" type="number" min="0" step="1" required value="${variant.price}" /></label><label>安全庫存<input name="safety_stock" type="number" min="0" step="1" value="${variant.safety_stock}" /></label><label>訂金比例（%）<input name="deposit_rate" type="number" min="0" max="100" value="${Math.round(Number(variant.deposit_rate) * 100)}" /></label><label>預計到貨區間<input name="preorder_arrival" value="${escapeHtml(variant.preorder_arrival || "")}" /></label><label>排序<input name="display_order" type="number" value="${variant.display_order}" /></label><label class="wide">賣貨便連結<input name="seller_link" type="url" value="${escapeHtml(variant.seller_link || "")}" /></label><label class="check-field"><input name="is_published" type="checkbox" ${variant.is_published ? "checked" : ""} /> 上架此規格</label></div><button class="primary-button" type="submit">儲存規格</button></form></details>`;
    }).join("");
    return `<article class="admin-product-card" data-tone="${index % 4}"><header class="admin-product-head"><div class="admin-product-thumbnail">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy" />` : '<span aria-hidden="true">📦</span>'}</div><div class="admin-product-title"><div class="admin-product-labels"><span class="admin-product-number">#${String(index + 1).padStart(2, "0")}</span><span class="admin-chip">${escapeHtml(category)}</span><span class="admin-chip ${product.is_published ? "chip-live" : "chip-muted"}">${product.is_published ? "已上架" : "未上架"}</span></div><h3>${escapeHtml(product.name)}</h3><p>${escapeHtml(product.description || "尚未填寫商品說明")}</p></div><div class="admin-product-metrics"><span>規格<b>${publishedVariants}/${productVariants.length}</b></span><span>總庫存<b>${totalStock}</b></span><span>售價<b>${priceRange}</b></span></div></header><details class="admin-product-edit"><summary>編輯商品資料與照片</summary><form class="admin-form" data-edit-product-form="${product.id}" data-category-id="${escapeHtml(product.category_id || "")}"><div class="form-grid"><label>商品名稱<input name="name" required value="${escapeHtml(product.name)}" /></label><label>排序<input name="display_order" type="number" value="${product.display_order}" /></label><label class="wide">商品說明<textarea name="description" rows="3">${escapeHtml(product.description || "")}</textarea></label><label>每位會員限購數量<input name="purchase_limit" type="number" min="1" step="1" value="${product.purchase_limit ?? ""}" placeholder="留空代表不限購" /></label><label class="wide image-upload-field">更換商品主圖<input name="image" type="file" accept="image/jpeg,image/png,image/webp" /><small>${imageUrl ? "已有主圖；選擇新檔案後會取代現有照片。" : "目前尚無主圖。"} 上限 5MB。</small></label><label class="check-field"><input name="is_published" type="checkbox" ${product.is_published ? "checked" : ""} /> 上架商品</label></div><button class="primary-button" type="submit">儲存商品</button></form></details><section class="admin-variant-group"><h4>商品規格 <span>${productVariants.length}</span></h4>${variants || '<div class="empty-state">此商品尚無規格。</div>'}</section></article>`;
  }).join("");
  removeLegacyShippingUI();
}

function renderAdminMovements() {
  const container = document.querySelector("#admin-movement-list");
  const movements = adminData.movements || [];
  container.innerHTML = movements.length ? movements.map((movement) => {
    const variant = relationOne(movement.product_variants);
    const product = relationOne(variant?.products);
    const positive = movement.quantity_delta > 0;
    return `<div class="admin-card"><div><strong>${escapeHtml(product?.name || "商品")} · ${escapeHtml(variant?.name || variant?.sku || "規格")}</strong><small>${escapeHtml(movement.reason)} · ${formatDateTime(movement.created_at)}</small></div><strong class="${positive ? "movement-positive" : "movement-negative"}">${positive ? "+" : ""}${movement.quantity_delta}</strong></div>`;
  }).join("") : '<div class="empty-state">目前沒有庫存異動紀錄。</div>';
}

function resetAccountForm() {
  document.querySelector("#admin-account-form").reset();
  document.querySelector("#admin-account-id").value = "";
  document.querySelector("#admin-account-order").value = "0";
  document.querySelector("#admin-account-active").checked = true;
  document.querySelector("[data-account-form-title]").textContent = "新增收款帳戶";
  document.querySelector("[data-account-cancel]").classList.add("hidden");
}

function editAccount(accountId) {
  const account = (adminData.accounts || []).find((item) => item.id === accountId);
  if (!account) return;
  document.querySelector("#admin-account-id").value = account.id;
  document.querySelector("#admin-account-label").value = account.label;
  document.querySelector("#admin-bank-name").value = account.bank_name;
  document.querySelector("#admin-account-name").value = account.account_name;
  document.querySelector("#admin-account-number").value = account.account_number;
  document.querySelector("#admin-account-order").value = account.display_order;
  document.querySelector("#admin-account-active").checked = account.is_active;
  document.querySelector("[data-account-form-title]").textContent = "編輯收款帳戶";
  document.querySelector("[data-account-cancel]").classList.remove("hidden");
  document.querySelector("#admin-account-label").focus();
}

async function submitAdminAccount(event) {
  event.preventDefault();
  const id = document.querySelector("#admin-account-id").value;
  const body = {
    label: document.querySelector("#admin-account-label").value,
    bank_name: document.querySelector("#admin-bank-name").value,
    account_name: document.querySelector("#admin-account-name").value,
    account_number: document.querySelector("#admin-account-number").value,
    display_order: Number(document.querySelector("#admin-account-order").value || 0),
    is_active: document.querySelector("#admin-account-active").checked
  };
  await adminFetch(id ? `/api/admin/bank-accounts/${id}` : "/api/admin/bank-accounts", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
  resetAccountForm();
  bankAccounts = [];
  await loadAdminData();
  switchAdminTab("accounts");
  showToast("收款帳戶已儲存");
}

function productFormBody() {
  const kind = document.querySelector("#admin-kind").value;
  return {
    category_name: document.querySelector("#admin-category-name").value,
    product_name: document.querySelector("#admin-product-name").value,
    description: document.querySelector("#admin-product-description").value,
    variant_name: document.querySelector("#admin-variant-name").value,
    sku: document.querySelector("#admin-sku").value,
    kind,
    price: Number(document.querySelector("#admin-price").value),
    stock: Number(document.querySelector("#admin-stock").value),
    purchase_limit: document.querySelector("#admin-purchase-limit").value ? Number(document.querySelector("#admin-purchase-limit").value) : null,
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-deposit-rate").value || 0) / 100,
    preorder_arrival: document.querySelector("#admin-arrival").value,
    seller_link: document.querySelector("#admin-seller-link").value,
    is_published: document.querySelector("#admin-published").checked
  };
}

function validateProductImage(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("照片僅支援 JPG、PNG 或 WebP");
  if (file.size > 5 * 1024 * 1024) throw new Error("商品照片不可超過 5MB");
}

async function uploadAdminProductImage(productId, file) {
  if (!file) return;
  validateProductImage(file);
  const formData = new FormData();
  formData.append("image", file);
  await adminFetch(`/api/admin/products/${productId}/image`, { method: "POST", body: formData });
}

async function submitAdminProduct(event) {
  event.preventDefault();
  const image = document.querySelector("#admin-product-image").files[0];
  validateProductImage(image);
  const result = await adminFetch("/api/admin/products", { method: "POST", body: JSON.stringify(productFormBody()) });
  await uploadAdminProductImage(result.ids.product_id, image);
  event.currentTarget.reset();
  document.querySelector("#admin-variant-name").value = "單一規格";
  document.querySelector("#admin-stock").value = "0";
  document.querySelector("#admin-purchase-limit").value = "";
  document.querySelector("#admin-deposit-rate").value = "0";
  await loadAdminData();
  switchAdminTab("products");
  showToast("商品已建立");
}

async function submitNewVariant(event) {
  event.preventDefault();
  const kind = document.querySelector("#admin-new-kind").value;
  const body = {
    product_id: document.querySelector("#admin-variant-product").value,
    name: document.querySelector("#admin-new-variant-name").value,
    sku: document.querySelector("#admin-new-sku").value,
    kind,
    price: Number(document.querySelector("#admin-new-price").value),
    safety_stock: Number(document.querySelector("#admin-new-safety-stock").value || 3),
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-new-deposit-rate").value || 0) / 100,
    preorder_arrival: document.querySelector("#admin-new-arrival").value,
    seller_link: document.querySelector("#admin-new-seller-link").value,
    is_published: document.querySelector("#admin-new-published").checked
  };
  await adminFetch("/api/admin/variants", { method: "POST", body: JSON.stringify(body) });
  event.currentTarget.reset();
  document.querySelector("#admin-new-safety-stock").value = "3";
  document.querySelector("#admin-new-deposit-rate").value = "0";
  await loadAdminData();
  switchAdminTab("products");
  showToast("商品規格已新增");
}

async function submitInventoryAdjustment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  const variantId = document.querySelector("#admin-inventory-variant").value;
  if (!variantId) throw new Error("請先選擇商品規格");
  if (button instanceof HTMLButtonElement) {
    button.disabled = true;
    button.textContent = "更新中…";
  }
  try {
    const result = await adminFetch(`/api/admin/variants/${variantId}/inventory`, { method: "POST", body: JSON.stringify({ quantity_delta: Number(document.querySelector("#admin-inventory-delta").value), reason: document.querySelector("#admin-inventory-reason").value }) });
    form.reset();
    await loadAdminData();
    switchAdminTab("inventory");
    const variantSelect = document.querySelector("#admin-inventory-variant");
    if (variantSelect) variantSelect.value = variantId;
    const variantLabel = variantSelect?.selectedOptions?.[0]?.textContent?.trim() || "商品規格";
    const feedback = document.querySelector("#admin-inventory-feedback");
    if (feedback) {
      feedback.textContent = `${variantLabel} 已更新，最新庫存 ${Number(result.stock_on_hand ?? 0)} 件。`;
      feedback.classList.remove("hidden");
    }
    showToast(`庫存已更新：${variantLabel} ${Number(result.stock_on_hand ?? 0)} 件`);
  } finally {
    if (button instanceof HTMLButtonElement) {
      button.disabled = false;
      button.textContent = "確認調整庫存";
    }
  }
}

async function submitDynamicAdminForm(event) {
  const productId = event.target.dataset.editProductForm;
  const variantId = event.target.dataset.editVariantForm;
  if (!productId && !variantId) return;
  event.preventDefault();
  const formData = new FormData(event.target);
  if (productId) {
    const image = formData.get("image");
    validateProductImage(image instanceof File && image.size ? image : null);
    const purchaseLimit = String(formData.get("purchase_limit") || "").trim();
    await adminFetch(`/api/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), description: formData.get("description"), category_id: event.target.dataset.categoryId, purchase_limit: purchaseLimit ? Number(purchaseLimit) : null, display_order: Number(formData.get("display_order") || 0), is_published: formData.get("is_published") === "on" }) });
    if (image instanceof File && image.size) await uploadAdminProductImage(productId, image);
  } else {
    const kind = formData.get("kind");
    await adminFetch(`/api/admin/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), sku: formData.get("sku"), kind, price: Number(formData.get("price")), safety_stock: Number(formData.get("safety_stock") || 3), deposit_rate: kind === "preorder" ? 0.5 : Number(formData.get("deposit_rate") || 0) / 100, preorder_arrival: formData.get("preorder_arrival"), display_order: Number(formData.get("display_order") || 0), seller_link: formData.get("seller_link"), is_published: formData.get("is_published") === "on" }) });
  }
  await loadAdminData();
  switchAdminTab("products");
  showToast(productId ? "商品資料已儲存" : "規格資料已儲存");
}

function syncDepositField(kindSelector, rateInput) {
  const preorder = kindSelector.value === "preorder";
  if (preorder) rateInput.value = "50";
  rateInput.readOnly = preorder;
}

document.addEventListener("click", (event) => {
  const add = event.target.closest("[data-add]"); if (add) addToCart(add.dataset.add);
  const heroAdd = event.target.closest("[data-hero-add]"); if (heroAdd) addToCart(heroAdd.dataset.heroAdd);
  const change = event.target.closest("[data-quantity]"); if (change) { const item = cart.find((entry) => entry.id === change.dataset.quantity); const delta = Number(change.dataset.delta); const max = products.find((product) => product.id === item.id).stock; item.quantity = Math.min(max, item.quantity + delta); if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const remove = event.target.closest("[data-remove]"); if (remove) { const item = cart.find((entry) => entry.id === remove.dataset.remove); cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const detail = event.target.closest("[data-detail]"); if (detail) openProductDetail(detail.dataset.detail);
  if (event.target.closest("[data-detail-add]")) addDetailToCart();
  if (event.target.closest("[data-cart-toggle]")) toggleCart();
  if (event.target.closest("[data-checkout]")) handleCartCheckout();
  if (event.target.closest("[data-admin-open]")) openAdmin();
  if (event.target.closest("[data-admin-close]")) document.querySelector("#admin-dialog").close();
  if (event.target.closest("[data-checkout-close]")) document.querySelector("#checkout-dialog").close();
  if (event.target.closest("[data-demo='login']")) auth.user ? showProfileDialog(false) : beginLineLogin();
  if (event.target.closest("[data-profile-close]")) document.querySelector("#profile-dialog").close();
  if (event.target.closest("[data-orders-open]")) openOrders();
  if (event.target.closest("[data-orders-close]")) document.querySelector("#orders-dialog").close();
  if (event.target.closest("[data-payment-close], [data-payment-later]")) document.querySelector("#payment-dialog").close();
  const lineFriendCheck = event.target.closest("[data-line-friend-check]");
  if (lineFriendCheck) {
    lineFriendCheck.disabled = true;
    lineFriendCheck.textContent = "檢查中…";
    document.querySelector("#line-friend-error")?.classList.add("hidden");
    checkLineFriendship().then((isFriend) => {
      if (!isFriend) return showLineFriendDialog();
      document.querySelector("#line-friend-dialog")?.close();
      return openCheckout();
    }).catch((error) => showLineFriendDialog(error.message)).finally(() => {
      lineFriendCheck.disabled = false;
      lineFriendCheck.textContent = "我已加入，重新檢查";
    });
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) switchAdminTab(adminTab.dataset.adminTab);
  if (event.target.closest("[data-admin-refresh]")) loadAdminData();
  if (event.target.closest("[data-line-test]")) testLineNotification().catch((error) => showToast(error.message));
  if (event.target.closest("[data-birthday-issue]")) issueBirthdayCouponsNow().catch((error) => showToast(error.message));
  const accountEdit = event.target.closest("[data-account-edit]");
  if (accountEdit) editAccount(accountEdit.dataset.accountEdit);
  if (event.target.closest("[data-account-cancel]")) resetAccountForm();
  if (event.target.closest("[data-coupon-reset]")) resetCouponForm();
  const couponEdit = event.target.closest("[data-coupon-edit]");
  if (couponEdit) editCoupon(couponEdit.dataset.couponEdit);
  const paymentOrderButton = event.target.closest("[data-order-payment]");
  if (paymentOrderButton) {
    const order = currentOrders.find((item) => item.id === paymentOrderButton.dataset.orderPayment);
    if (order) { document.querySelector("#orders-dialog").close(); showPaymentDialog(order); }
  }
});
document.addEventListener("change", (event) => {
  if (event.target.matches("#admin-order-status-filter")) renderAdminOrders();
  if (event.target.matches("#admin-product-status")) renderAdminProducts();
  if (event.target.matches("#point-max-mode")) syncPointMaxHint();
  if (event.target.matches("#admin-kind")) syncDepositField(event.target, document.querySelector("#admin-deposit-rate"));
  if (event.target.matches("#admin-new-kind")) syncDepositField(event.target, document.querySelector("#admin-new-deposit-rate"));
  if (event.target.matches("[data-edit-variant-form] select[name='kind']")) syncDepositField(event.target, event.target.form.elements.deposit_rate);
  if (event.target.matches("input[name='delivery_method']")) syncDeliveryFields();
  if (event.target.matches("input[name='cart_delivery_method']")) setCartDeliveryMethod(event.target.value);
  if (event.target.matches("input[name='delivery_method']")) setCartDeliveryMethod(event.target.value);
  if (event.target.matches("input[name='payment_method']")) syncPaymentFields();
  if (event.target.matches("input[name='pickup']")) renderCheckoutSummary();
  if (event.target.matches("#product-detail-variant")) {
    activeDetailProductId = event.target.value;
    renderProductDetail();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.matches("#admin-order-search")) renderAdminOrders();
  if (event.target.matches("#admin-member-search")) renderAdminMembers();
  if (event.target.matches("#admin-product-search")) renderAdminProducts();
  if (event.target.matches("#checkout-points")) renderCheckoutSummary();
  if (event.target.matches("#checkout-address")) renderCheckoutSummary();
});
document.addEventListener("submit", async (event) => {
  if (event.target.matches("#admin-coupon-form")) {
    try { await submitCoupon(event); } catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.matches("#birthday-coupon-form")) {
    try { await submitBirthdaySettings(event); } catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.matches("[data-admin-points-form]")) {
    try { await submitMemberPointAdjustment(event); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.matches("[data-admin-order-form]")) {
    try { await submitAdminOrderTransition(event); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (event.target.matches("[data-admin-fulfillment-form]")) {
    try { await submitAdminOrderFulfillment(event); }
    catch (error) { showToast(error.message); }
    return;
  }
  if (!event.target.matches("[data-edit-product-form], [data-edit-variant-form]")) return;
  try { await submitDynamicAdminForm(event); }
  catch (error) { showToast(error.message); }
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { activeCategory = button.dataset.category; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); renderProducts(); }));
search.addEventListener("input", renderProducts);
document.querySelector("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector(".checkout-submit");
  document.querySelector("#checkout-error").classList.add("hidden");
  submitButton.disabled = true;
  submitButton.textContent = "建立訂單中…";
  try { await submitOrder(); }
  catch (error) { showCheckoutError(error.message); }
  finally {
    submitButton.disabled = bankAccounts.length === 0;
    submitButton.textContent = "保留商品並取得匯款資訊";
  }
});
document.querySelector("#payment-form").addEventListener("submit", submitPayment);
document.querySelector("#profile-form").addEventListener("submit", submitProfile);
document.querySelector("#admin-account-form").addEventListener("submit", async (event) => { try { await submitAdminAccount(event); } catch (error) { showToast(error.message); } });
document.querySelector("#admin-product-form").addEventListener("submit", async (event) => { try { await submitAdminProduct(event); } catch (error) { showToast(error.message); } });
document.querySelector("#admin-variant-form").addEventListener("submit", async (event) => { try { await submitNewVariant(event); } catch (error) { showToast(error.message); } });
document.querySelector("#admin-inventory-form").addEventListener("submit", async (event) => { try { await submitInventoryAdjustment(event); } catch (error) { showToast(error.message); } });
document.querySelector("#admin-point-settings-form").addEventListener("submit", async (event) => { try { await submitPointSettings(event); } catch (error) { showToast(error.message); } });
document.querySelector("#profile-dialog").addEventListener("cancel", (event) => {
  if (event.currentTarget.dataset.required === "true") event.preventDefault();
});
async function loadProducts() {
  try {
    const response = await fetch("/api/catalog");
    if (!response.ok) return;
    const payload = await response.json();
    if (Array.isArray(payload.products) && payload.products.length) products = payload.products.map((product) => ({ ...product, link: product.seller_link, icon: product.category?.startsWith("BX") ? "🌀" : "⚔️" }));
  } catch {
    // 在純靜態預覽時保留示範資料。
  }
}

removeLegacyShippingUI();
removeLegacySellerCheckoutOption();
captureAuthSession();
await Promise.all([loadRuntimeConfig(), loadProducts()]);
await loadMember();
try { const savedCart = JSON.parse(sessionStorage.getItem("cj-cart") || "[]"); if (Array.isArray(savedCart)) cart.push(...savedCart.filter((item) => products.some((product) => product.id === item.id))); } catch { sessionStorage.removeItem("cj-cart"); }
renderHeroSpotlight(); renderProducts(); renderCart();
