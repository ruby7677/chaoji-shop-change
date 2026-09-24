import { liffState, initializeLiffClient, preloadLiffSdk, canRequestLineFriendship, requestLineFriendship } from "./liff-auth.js";
import { escapeHtml, hasProductDiscount, isPreorderItem, money, productAvailability, productMark, productPriceMarkup } from "./product-format.js";
import { productCardMarkup } from "./product-card.js";
import { mountHeroCarousel } from "./hero-carousel.js";
import { createProductPage } from "./product-page.js";
import { initAnchorScroll, scrollToAnchor } from "./anchor-scroll.js";
import { selectHeroSlides } from "./hero-slides.js";
import { initAdminProductGallery } from "./admin-product-gallery.js";
import { initAdminProductsTable, renderAdminProductsTable } from "./admin-products-table.js";
import { initAdminShell } from "./admin-shell.js";
import { adminConfirm } from "./admin-confirm.js";

let products = [
  { id: "bx35", category: "BX系列", name: "BX35抽抽包 亞洲版", price: 1300, stock: 8, type: "現貨", icon: "🌀", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" },
  { id: "ux20", category: "UX系列", name: "UX20 榮耀戰神 亞洲版", price: 1350, stock: 23, type: "現貨", icon: "⚔️", link: "https://myship.7-11.com.tw/cart/confirm/GM2606221488922" }
];

const cart = [];
const grid = document.querySelector("#product-grid");
const search = document.querySelector("#product-search");
const auth = { config: null, accessToken: null, refreshToken: null, lineProviderToken: null, user: null, profile: null, points: null, lineFriendFlag: null };
let liffSessionMatches = false;
const MEMBER_POINTS_TTL_MS = 12 * 60 * 1000;
const LINE_FRIENDSHIP_TTL_MS = 15 * 60 * 1000;
const AUTH_RETURN_STATE_KEY = "chaoji:auth-return-state";
const AUTH_RETURN_MAX_AGE_MS = 10 * 60 * 1000;
const LIFF_AUTO_LOGIN_KEY = "chaoji:liff-oauth-attempt";
const LIFF_AUTO_LOGIN_MAX_AGE_MS = 2 * 60 * 1000;
const LIFF_AUTO_CALLBACK_PARAM = "cj_liff_oauth";
const LIFF_CONTEXT_KEY = "chaoji:liff-context";
const AUTH_BOOT_FAILSAFE_MS = 30000;
const AUTH_BOOT_STABLE_MESSAGE = "正在準備潮吉好頑…";
const HERO_IMAGE_DECODE_TIMEOUT_MS = 1200;
let authBootFailsafe = null;
let authBootFailed = false;
let authBootstrapInFlight = null;
let liffBridgeInFlight = null;
let liffBridgeResolved = false;
let liffBridgeResult = false;
let memberLoadInFlight = null;
let memberLoadResolved = false;
let liffOAuthCallbackSeen = false;
let liffAutoLoginAttemptAt = 0;
let liffPrimaryRedirectPending = false;
let initialPageRendered = false;
let memberPointsCache = { userId: null, value: null, expiresAt: 0 };
let memberPointsInFlight = null;
let lineFriendshipCache = { userId: null, value: null, expiresAt: 0 };
let lineFriendshipInFlight = null;
let authReturnState = null;
let shouldRestoreAuthReturnState = false;
let authReturnError = null;
let pendingReturnCheckout = null;
let activeCategory = "all";
let bankAccounts = [];
let currentOrders = [];
let activePaymentOrder = null;
let adminData = null;
let adminDataActorId = null;
let adminManagementOptionsActorId = null;
let adminManagementOptionsLoadedAt = 0;
let adminManagementOptionsInFlight = null;
let cartDeliveryMethod = "store_pickup";
let activeCheckoutScope = null;
let activeCheckoutItems = null;
const cartGroupDeliveryMethods = { in_stock: "store_pickup", preorder: "store_pickup" };
const MEMBER_CART_SYNC_DEBOUNCE_MS = 750;
let cartSyncTimer = null;
let cartSyncRevision = 0;
let cartSyncUserId = null;
let lastSyncedCartHash = null;
let pendingCartSnapshot = null;
let pendingCartHash = null;
let cartSyncInFlight = null;
let cartSyncGeneration = 0;
let identitySyncUserId = null;
let identitySyncInFlight = null;
const adminSections = ["overview", "orders", "members", "products", "inventory", "discounts", "audit", "notifications", "settings"];
const ADMIN_MANAGEMENT_OPTIONS_SECTIONS = new Set(["products", "inventory", "discounts"]);
const ADMIN_MANAGEMENT_OPTIONS_TTL_MS = 5 * 60 * 1000;
const adminSectionLoaded = new Set();
const adminSectionInFlight = new Map();
const adminSectionPages = { orders: 0, members: 0, products: 0, inventory: 0, discounts: 0, audit: 0, notifications: 0 };
const adminSearchDebounceTimers = { orders: null, members: null, products: null, inventory: null, discounts: null, audit: null, notifications: null };

function resetMemberCartSyncState() {
  if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
  cartSyncTimer = null;
  cartSyncRevision += 1;
  cartSyncGeneration += 1;
  lastSyncedCartHash = null;
  pendingCartSnapshot = null;
  pendingCartHash = null;
  // A pending fetch cannot be cancelled reliably across browsers. Drop the
  // guard and use cartSyncGeneration so its completion cannot update a new
  // member session.
  cartSyncInFlight = null;
  cartSyncUserId = null;
}

function clearMemberStateCache() {
  memberPointsCache = { userId: null, value: null, expiresAt: 0 };
  memberPointsInFlight = null;
  lineFriendshipCache = { userId: null, value: null, expiresAt: 0 };
  lineFriendshipInFlight = null;
  auth.points = null;
  auth.lineFriendFlag = null;
  resetMemberCartSyncState();
  renderMemberPoints();
}
try {
  const savedDeliveryMethod = sessionStorage.getItem("cj-cart-delivery-method");
  if (["store_pickup", "seller_delivery", "home_delivery"].includes(savedDeliveryMethod)) cartDeliveryMethod = savedDeliveryMethod;
  for (const scope of Object.keys(cartGroupDeliveryMethods)) {
    const savedGroupMethod = sessionStorage.getItem(`cj-cart-delivery-method-${scope}`);
    if (["store_pickup", "seller_delivery", "home_delivery"].includes(savedGroupMethod)) cartGroupDeliveryMethods[scope] = savedGroupMethod;
    else cartGroupDeliveryMethods[scope] = cartDeliveryMethod;
  }
} catch { /* sessionStorage may be unavailable in restricted previews. */ }

const deliveryMethodLabels = { store_pickup: "到店取貨", seller_delivery: "賣貨便", home_delivery: "宅配" };
const deliveryMethodNotes = {
  store_pickup: "台南市中西區民生路二段 93 號，免運。",
  seller_delivery: "本站先建立待確認訂單，再前往賣貨便完成結帳；運費由 7-11 於取貨時向客戶收取。",
  home_delivery: "現貨宅配匯款時先私訊小幫手確認運費再連同商品一併匯款即可；預購商品到貨後通知，尾款與運費確認入帳後安排寄出。"
};

const orderStatusLabels = {
  pending_payment: "待付款",
  pending_review: "待確認款項",
  confirmed: "已確認",
  partially_ready: "部分到貨",
  ready_for_pickup: "配送處理中",
  completed: "已完成訂單",
  cancelled: "已取消",
  refund_pending: "退款處理中",
  refunded: "已退款"
};

const adminOrderTransitions = {
  pending_payment: [{ value: "confirmed", label: "確認到店付款", storePaymentOnly: true }, { value: "cancelled", label: "取消未付款訂單" }],
  pending_review: [{ value: "confirmed", label: "確認款項並扣除庫存" }, { value: "cancelled", label: "取消訂單" }],
  confirmed: [{ value: "partially_ready", label: "標記預購商品部分到貨", splitOnly: true }, { value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  partially_ready: [{ value: "ready_for_pickup", label: "更新到貨狀態" }, { value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  ready_for_pickup: [{ value: "completed", label: "完成取貨並確認尾款" }, { value: "refund_pending", label: "進入退款處理" }, { value: "cancelled", label: "取消訂單" }],
  completed: [{ value: "refund_pending", label: "進入退款處理" }],
  refund_pending: [{ value: "refunded", label: "確認已退款" }, { value: "completed", label: "取消退款，恢復已完成" }]
};

const customerServiceLineUrl = "https://line.me/R/ti/p/@078isxfl?ts=03122133&oat_content=url";
function linkCustomerServiceText(value) {
  return escapeHtml(value).replaceAll("小幫手", `<a class="helper-contact-link" href="${customerServiceLineUrl}" target="_blank" rel="noopener noreferrer">小幫手</a>`);
}
function orderIncludesPreorder(order) { return (order?.order_items || []).some(isPreorderItem); }
function orderInventoryTypeLabel(order) {
  const kinds = (order?.order_items || []).map((item) => String(item?.type || item?.kind || "").toLowerCase());
  const hasPreorder = kinds.some((kind) => ["預購", "preorder"].includes(kind));
  const hasInStock = kinds.some((kind) => ["現貨", "in_stock"].includes(kind));
  if (hasPreorder && hasInStock) return "現貨／預購";
  return hasPreorder ? "預購" : "現貨";
}
function orderStatusLabel(order, status = order?.status) {
  if (status === "ready_for_pickup") {
    if (order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便已到貨" : "現貨賣貨便已出貨";
    if (order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待尾款／運費" : "現貨宅配待尾款／運費";
    if (order?.delivery_method === "store_pickup" && orderIncludesPreorder(order)) return "待取貨";
    return "配送處理中";
  }
  return orderStatusLabels[status] || status || "未知狀態";
}
function adminOrderStatusLabel(order, status = order?.status) {
  if (status === "confirmed" && order?.delivery_method === "store_pickup" && !orderIncludesPreorder(order)) return "待取貨";
  if (status === "confirmed" && order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待到貨" : "現貨宅配備貨中";
  if (status === "confirmed" && order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便待到貨" : "現貨賣貨便備貨中";
  if (status === "ready_for_pickup" && order?.delivery_method === "home_delivery") return orderIncludesPreorder(order) ? "預購宅配待尾款／運費" : "現貨宅配待尾款／運費";
  if (status === "ready_for_pickup" && order?.delivery_method === "seller_delivery") return orderIncludesPreorder(order) ? "預購賣貨便已到貨" : "現貨賣貨便已出貨";
  if (status === "ready_for_pickup" && order?.delivery_method === "store_pickup" && orderIncludesPreorder(order)) return "預購到店待取貨";
  if (status === "confirmed") return "到店通知";
  return orderStatusLabel(order, status);
}
function formatDateTime(value) { return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
let toastTimer = null;
let pageScrollLockState = null;
const pageScrollStyleKeys = ["position", "top", "left", "right", "width", "overflow", "paddingRight"];

function hasOpenOverlay() {
  return Boolean(document.querySelector("dialog[open], .cart-drawer.open"));
}

function lockPageScroll() {
  if (pageScrollLockState) return;
  const bodyStyle = document.body.style;
  pageScrollLockState = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    styles: Object.fromEntries(pageScrollStyleKeys.map((key) => [key, bodyStyle[key]]))
  };
  const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  bodyStyle.position = "fixed";
  bodyStyle.top = `-${pageScrollLockState.scrollY}px`;
  bodyStyle.left = "0";
  bodyStyle.right = "0";
  bodyStyle.width = "100%";
  bodyStyle.overflow = "hidden";
  bodyStyle.paddingRight = scrollbarWidth ? `${scrollbarWidth}px` : pageScrollLockState.styles.paddingRight;
  document.documentElement.classList.add("is-scroll-locked");
}

function unlockPageScroll() {
  if (!pageScrollLockState) return;
  const state = pageScrollLockState;
  pageScrollLockState = null;
  const bodyStyle = document.body.style;
  pageScrollStyleKeys.forEach((key) => { bodyStyle[key] = state.styles[key] || ""; });
  document.documentElement.classList.remove("is-scroll-locked");
  // html 設有 scroll-behavior:smooth；還原位置須立即完成，否則關閉視窗後整頁會從頂端滑回原處
  window.scrollTo({ left: state.scrollX, top: state.scrollY, behavior: "instant" });
}

function syncPageScrollLock() {
  if (hasOpenOverlay()) lockPageScroll();
  else unlockPageScroll();
}

function showDialog(dialog) {
  if (!dialog) return;
  // 先鎖頁面再 showModal：鎖定會讓整頁捲動位置歸 0，若 dialog 已在 top layer，
  // iOS Safari 會沿用舊捲動位置的繪製與點擊範圍（畫面被截斷、無法操作；例如從頁尾開後台）
  if (!dialog.open) {
    lockPageScroll();
    dialog.showModal();
  }
  syncPageScrollLock();
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) dialog.close();
  syncPageScrollLock();
}

function hideToast() {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.classList.remove("show");
  toast.setAttribute("aria-hidden", "true");
  toastTimer = null;
}
function showToast(message, kind = "neutral") {
  const toast = document.querySelector("#toast");
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog && toast.parentElement !== openDialog) openDialog.appendChild(toast);
  else if (!openDialog && toast.parentElement !== document.body) document.body.appendChild(toast);
  const toastKind = ["success", "error", "warning"].includes(kind) ? kind : "neutral";
  toast.textContent = message;
  toast.classList.remove("show", "toast-success", "toast-error", "toast-warning");
  if (toastKind !== "neutral") toast.classList.add(`toast-${toastKind}`);
  toast.setAttribute("role", toastKind === "error" ? "alert" : "status");
  toast.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => toast.classList.add("show"));
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, 3000);
}
function selectedDeliveryMethod() { return document.querySelector("input[name='delivery_method']:checked")?.value || "store_pickup"; }
function selectedPaymentMethod() { return document.querySelector("input[name='payment_method']:checked")?.value || "bank_transfer"; }
let heroCarousel = null;
function renderHeroSpotlight() {
  const spotlight = document.querySelector("#hero-product-spotlight");
  if (!spotlight) return;
  const slides = selectHeroSlides(products);
  if (slides.length) {
    heroCarousel?.destroy();
    heroCarousel = mountHeroCarousel(spotlight, slides);
    return;
  }
  renderSingleHeroSpotlight();
}
function renderSingleHeroSpotlight() {
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
  if (priceNode) priceNode.innerHTML = productPriceMarkup(product);
  visual.innerHTML = product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(productName)}" />`
    : `<div class="hero-placeholder"><span>${productMark(product)}</span><small>${product.type === "現貨" ? "READY TO PLAY" : "COMING FROM AFAR"}</small></div>`;
  if (addButton) {
    const available = Number(product.stock || 0) > 0;
    addButton.dataset.heroAdd = product.id;
    addButton.disabled = !available;
    addButton.textContent = available ? "加入購物車" : "目前無庫存";
  }
}
function renderProducts() {
  const keyword = search.value.trim().toLowerCase();
  const visible = products.filter((product) => (activeCategory === "all" || product.category === activeCategory || product.type === activeCategory) && `${product.category}${product.name}`.toLowerCase().includes(keyword));
  grid.innerHTML = visible.length ? visible.map(productCardMarkup).join("") : "<p class=\"empty-state\">目前沒有符合的商品。</p>";
}
function cartItemMarkup(item) {
  return `<div class="cart-item"><div><h3>${escapeHtml(item.name)}</h3><small>${money(item.price)} · ${escapeHtml(item.category)} · ${isPreorderItem(item) ? "預購" : "現貨"}</small><div class="quantity"><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="-1">−</button><b>${item.quantity}</b><button type="button" data-quantity="${escapeHtml(item.id)}" data-delta="1">＋</button></div></div><div><strong>${money(item.price * item.quantity)}</strong><button class="remove" type="button" data-remove="${escapeHtml(item.id)}">移除</button></div></div>`;
}

function renderCartSplitGroups() {
  const itemsNode = document.querySelector("#cart-items");
  const groups = cartGroups();
  const mixed = groups.in_stock.length > 0 && groups.preorder.length > 0;
  itemsNode?.classList.toggle("is-mixed", mixed);
  itemsNode?.querySelector("#cart-split-groups")?.remove();
  const globalChoice = document.querySelector(".cart-delivery-choice");
  const globalNote = document.querySelector(".cart-delivery-note");
  globalChoice?.classList.toggle("hidden", mixed);
  globalNote?.classList.toggle("hidden", mixed);
  if (!itemsNode || !mixed) return;
  const wrapper = document.createElement("div");
  wrapper.id = "cart-split-groups";
  wrapper.className = "cart-split-groups";
  wrapper.innerHTML = `<p class="cart-split-note">購物車含現貨與預購，系統會分開建立 2 筆訂單；付款期限、庫存確認與 LINE 通知也會分開計算。</p>` + ["in_stock", "preorder"].map((scope) => {
    const group = groups[scope];
    const title = scope === "in_stock" ? "現貨商品" : "預購商品";
    const subtotal = group.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const method = selectedCartDeliveryMethod(scope);
    const sellerNote = scope === "preorder"
      ? "本站先建立預購訂單；到貨後客服通知，再由客服開賣貨便。運費由 7-11 取貨時收取。"
      : "先建立本站待確認訂單，再前往賣貨便完成結帳；運費由 7-11 取貨時收取。";
    const options = [
      ["store_pickup", "到店取貨", "台南市中西區民生路二段 93 號", ""],
      ["seller_delivery", "賣貨便", sellerNote, scope === "in_stock" ? "現貨／賣貨便 無法使用優惠券、點數折抵" : ""],
      ["home_delivery", "宅配", "現貨備貨完成或預購商品到貨後，由客服通知實際運費。", ""]
    ];
    return `<section class="cart-group" data-cart-group="${scope}"><header><div><span class="eyebrow">${scope === "in_stock" ? "READY" : "PREORDER"}</span><h3>${title}</h3></div><strong>${money(subtotal)}</strong></header><div class="cart-group-items">${group.map(cartItemMarkup).join("")}</div><fieldset class="cart-group-delivery"><legend>此組商品取貨方式</legend>${options.map(([value, label, note, warning]) => `<label class="cart-delivery-option"><input type="radio" name="cart_group_delivery_method_${scope}" value="${value}" data-group-delivery="${scope}" ${method === value ? "checked" : ""} /> <span><strong>${label}</strong><small>${note}</small>${warning ? `<em class="cart-seller-benefit-warning">${warning}</em>` : ""}</span></label>`).join("")}</fieldset><p class="cart-delivery-feedback hidden" data-group-feedback="${scope}" role="status" aria-live="polite"></p><button class="primary-button cart-group-checkout" type="button" data-checkout-scope="${scope}">${scope === "in_stock" ? "結帳現貨商品" : "結帳預購商品"}</button></section>`;
  }).join("");
  itemsNode.appendChild(wrapper);
}

function syncGlobalCartDeliveryCopy() {
  const allPreorder = cart.length > 0 && cart.every(isPreorderItem);
  const hasInStock = cart.some((item) => !isPreorderItem(item));
  const sellerOption = document.querySelector("input[name='cart_delivery_method'][value='seller_delivery']")?.closest("label");
  const sellerNote = sellerOption?.querySelector("small");
  const sellerWarning = sellerOption?.querySelector(".cart-seller-benefit-warning");
  if (sellerNote) sellerNote.textContent = allPreorder
    ? "本站先建立預購訂單；到貨後客服通知並開立賣貨便，運費由 7-11 取貨時收取。"
    : "前往賣貨便完成結帳，運費由 7-11 取貨時收取。";
  sellerWarning?.classList.toggle("hidden", !hasInStock);
  const note = document.querySelector(".cart-delivery-note");
  if (note) note.textContent = allPreorder
    ? "預購賣貨便流程：先建立本站訂金訂單 → 到貨後客服通知 → 客服開立賣貨便供尾款取貨。"
    : "現貨賣貨便流程：加入購物車 → 選賣貨便 → 建立本站待確認訂單 → 前往賣貨便 → 管理員人工核對。";
}

function renderCart() {
  const items = document.querySelector("#cart-items");
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  document.querySelectorAll("[data-cart-count]").forEach((node) => node.textContent = count);
  document.querySelector("[data-tray-count]")?.replaceChildren(document.createTextNode(`${count} 件`));
  document.querySelector("[data-tray-total]")?.replaceChildren(document.createTextNode(money(total)));
  document.querySelector("#selection-tray")?.classList.toggle("has-items", count > 0);
  const currentGroups = cartGroups();
  const remainingScope = currentGroups.in_stock.length && !currentGroups.preorder.length ? "in_stock" : currentGroups.preorder.length && !currentGroups.in_stock.length ? "preorder" : null;
  if (remainingScope && cartGroupDeliveryMethods[remainingScope]) cartDeliveryMethod = cartGroupDeliveryMethods[remainingScope];
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  document.querySelector("#cart-total").textContent = money(total);
  document.querySelector("#cart-empty").classList.toggle("hidden", cart.length > 0);
  items.innerHTML = cart.map(cartItemMarkup).join("");
  items.querySelectorAll(".cart-item small").forEach((meta) => {
    const [price, ...labels] = meta.textContent.split(" · ");
    if (!labels.length) return;
    meta.classList.add("cart-item-meta");
    meta.innerHTML = `<span>${escapeHtml(price)}</span><span>${escapeHtml(labels.join(" · "))}</span>`;
  });
  renderCartSplitGroups();
  syncGlobalCartDeliveryCopy();
  updateCartCheckoutAction();
}
function cartPayload(items = cart) { return items.map((item) => ({ variant_id: item.id, quantity: item.quantity })); }
function persistCartLocally() {
  try { sessionStorage.setItem("cj-cart", JSON.stringify(cart)); } catch { /* ignore restricted storage */ }
}
function stableCartHash(items = cart) {
  const entries = (Array.isArray(items) ? items : []).map((item) => {
    const variantId = item?.variant_id ?? item?.id;
    const quantity = Number(item?.quantity);
    if (variantId === undefined || variantId === null || !Number.isFinite(quantity)) return null;
    return { variant_id: String(variantId), quantity };
  }).filter(Boolean);
  entries.sort((left, right) => left.variant_id.localeCompare(right.variant_id) || left.quantity - right.quantity);
  return JSON.stringify(entries);
}
function snapshotCart(items = cart) {
  return (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
}
function queueMemberCartSnapshot(items = cart) {
  pendingCartSnapshot = snapshotCart(items);
  pendingCartHash = stableCartHash(pendingCartSnapshot);
  return pendingCartHash;
}
function scheduleMemberCartSync() {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  cartSyncRevision += 1;
  const hash = queueMemberCartSnapshot(cart);
  if (!cartSyncInFlight && hash === lastSyncedCartHash) {
    pendingCartSnapshot = null;
    pendingCartHash = null;
    if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
    cartSyncTimer = null;
    return;
  }
  if (cartSyncTimer) window.clearTimeout(cartSyncTimer);
  const revision = cartSyncRevision;
  cartSyncTimer = window.setTimeout(() => {
    cartSyncTimer = null;
    syncMemberCartToServer(revision).catch(() => {});
  }, MEMBER_CART_SYNC_DEBOUNCE_MS);
}
async function replaceMemberCartOnServer(items = cart) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  const response = await fetch("/api/cart", {
    method: "PUT",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: cartPayload(items) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "會員購物車同步失敗");
}
function runMemberCartSync({ silent = false } = {}) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return Promise.resolve();
  const userId = auth.user.id;
  const generation = cartSyncGeneration;
  if (cartSyncInFlight) return cartSyncInFlight;
  let pump;
  pump = (async () => {
    while (cartSyncGeneration === generation && auth.accessToken && auth.user?.id === userId && auth.config?.authEnabled && pendingCartSnapshot) {
      const snapshot = pendingCartSnapshot;
      const hash = pendingCartHash ?? stableCartHash(snapshot);
      pendingCartSnapshot = null;
      pendingCartHash = null;
      if (hash === lastSyncedCartHash) continue;
      try {
        await replaceMemberCartOnServer(snapshot);
      } catch (error) {
        if (!silent && cartSyncGeneration === generation && auth.user?.id === userId) showToast(error.message || "會員購物車同步失敗，稍後會再試", "warning");
        return;
      }
      if (cartSyncGeneration === generation && auth.user?.id === userId) lastSyncedCartHash = hash;
    }
  })();
  const guardedPump = pump.finally(() => {
    if (cartSyncInFlight === guardedPump) cartSyncInFlight = null;
  });
  cartSyncInFlight = guardedPump;
  return guardedPump;
}
async function syncMemberCartToServer(revision = cartSyncRevision) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled || revision !== cartSyncRevision) return;
  // Keep only the newest state at flush time; any snapshot already in flight
  // is completed before runMemberCartSync drains this replacement.
  queueMemberCartSnapshot(cart);
  try { await runMemberCartSync(); }
  catch (error) { showToast(error.message || "會員購物車同步失敗，稍後會再試", "warning"); }
}
async function syncMemberCartNow({ silent = false } = {}) {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled) return;
  if (cartSyncTimer) { window.clearTimeout(cartSyncTimer); cartSyncTimer = null; }
  cartSyncRevision += 1;
  queueMemberCartSnapshot(cart);
  if (!cartSyncInFlight && pendingCartHash === lastSyncedCartHash) {
    pendingCartSnapshot = null;
    pendingCartHash = null;
    return;
  }
  try { await runMemberCartSync({ silent }); }
  catch (error) { if (!silent) showToast(error.message || "會員購物車同步失敗", "warning"); }
}
function saveCart(options = {}) {
  persistCartLocally();
  if (options.sync !== false) scheduleMemberCartSync();
}
function loadLocalCart() {
  try {
    const savedCart = JSON.parse(sessionStorage.getItem("cj-cart") || "[]");
    if (Array.isArray(savedCart)) {
      cart.push(...savedCart.slice(0, 50).map((item) => {
        const product = products.find((entry) => entry.id === item.id);
        const quantity = Number(item.quantity);
        const stock = Number(product?.stock || 0);
        return product && stock > 0 && Number.isInteger(quantity) && quantity > 0 ? { ...product, quantity: Math.min(quantity, stock, 100) } : null;
      }).filter(Boolean));
    }
  } catch { try { sessionStorage.removeItem("cj-cart"); } catch { /* ignore restricted storage */ } }
}
async function loadMemberCart() {
  if (!auth.accessToken || !auth.user || !auth.config?.authEnabled || cartSyncUserId === auth.user.id) return;
  try {
    const response = await fetch("/api/cart", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "會員購物車載入失敗");
    const remoteItems = Array.isArray(result.items) ? result.items : [];
    const remoteHashItems = remoteItems.map((remote) => {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(remote?.variant_id).toLowerCase());
      return { variant_id: product?.id ?? remote?.variant_id, quantity: remote?.quantity };
    });
    const remoteCartHash = stableCartHash(remoteHashItems);
    const localItems = cart.slice();
    const merged = new Map();
    for (const item of localItems) {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(item.id).toLowerCase());
      const quantity = Number(item.quantity);
      if (product && Number.isInteger(quantity) && quantity > 0 && Number(product.stock || 0) > 0) merged.set(item.id, { ...product, quantity: Math.min(quantity, Number(product.stock || 0), 100) });
    }
    for (const remote of remoteItems) {
      const product = products.find((entry) => String(entry.id).toLowerCase() === String(remote.variant_id).toLowerCase());
      const quantity = Number(remote.quantity);
      if (!product || !Number.isInteger(quantity) || quantity < 1 || Number(product.stock || 0) <= 0) continue;
      const existing = merged.get(product.id);
      merged.set(product.id, { ...product, quantity: Math.min((existing?.quantity || 0) + quantity, Number(product.stock || 0), 100) });
    }
    cart.splice(0, cart.length, ...[...merged.values()].slice(0, 50));
    cartSyncUserId = auth.user.id;
    lastSyncedCartHash = remoteCartHash;
    saveCart({ sync: false });
    if (stableCartHash(cart) !== remoteCartHash) await syncMemberCartNow({ silent: true });
    if (document.body.classList.contains("auth-boot-ready")) renderCart();
  } catch (error) {
    showToast(error.message || "會員購物車同步失敗，仍保留本機購物車", "warning");
  }
}
function addToCart(id) { const product = products.find((item) => item.id === id); const existing = cart.find((item) => item.id === id); if (existing) { if (existing.quantity >= product.stock) return showToast("已達可選購庫存上限"); existing.quantity += 1; } else cart.push({ ...product, quantity: 1 }); saveCart(); renderCart(); showToast(`${product.name} 已加入購物車`); }
function toggleCart() { const drawer = document.querySelector("#cart-drawer"); const open = drawer.classList.toggle("open"); document.querySelector(".overlay").classList.toggle("visible", open); drawer.setAttribute("aria-hidden", String(!open)); syncPageScrollLock(); }
function cartGroups() {
  return {
    in_stock: cart.filter((item) => !isPreorderItem(item)),
    preorder: cart.filter((item) => isPreorderItem(item))
  };
}
function cartItemsForScope(scope) {
  if (scope === "in_stock") return cart.filter((item) => !isPreorderItem(item));
  if (scope === "preorder") return cart.filter((item) => isPreorderItem(item));
  return cart;
}
function checkoutCartItems() { return activeCheckoutItems || cartItemsForScope(activeCheckoutScope); }
function selectedCartDeliveryMethod(scope = null) {
  if (!scope || !cartGroups().in_stock.length || !cartGroups().preorder.length) return cartDeliveryMethod;
  return cartGroupDeliveryMethods[scope] || cartDeliveryMethod;
}
function flashAddedButton(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add("is-added");
  button.textContent = "已加入 ✓";
  window.setTimeout(() => {
    if (!button.isConnected) return;
    button.disabled = false;
    button.classList.remove("is-added");
    button.textContent = originalLabel;
  }, 1100);
}
function addToCartWithFeedback(id, button) {
  const beforeCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  addToCart(id);
  const afterCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (afterCount > beforeCount) flashAddedButton(button);
}
function setCartDeliveryMethod(method) {
  if (!["store_pickup", "seller_delivery", "home_delivery"].includes(method)) return;
  cartDeliveryMethod = method;
  const groups = cartGroups();
  const scope = groups.in_stock.length && !groups.preorder.length ? "in_stock" : groups.preorder.length && !groups.in_stock.length ? "preorder" : null;
  if (scope) cartGroupDeliveryMethods[scope] = method;
  try { sessionStorage.setItem("cj-cart-delivery-method", method); } catch { /* ignore restricted storage */ }
  if (scope) try { sessionStorage.setItem(`cj-cart-delivery-method-${scope}`, method); } catch { /* ignore restricted storage */ }
  document.querySelectorAll("input[name='cart_delivery_method']").forEach((input) => { input.checked = input.value === cartDeliveryMethod; });
  updateCartCheckoutAction();
}
function setCartGroupDeliveryMethod(scope, method) {
  if (!Object.prototype.hasOwnProperty.call(cartGroupDeliveryMethods, scope) || !["store_pickup", "seller_delivery", "home_delivery"].includes(method)) return;
  cartGroupDeliveryMethods[scope] = method;
  try { sessionStorage.setItem(`cj-cart-delivery-method-${scope}`, method); } catch { /* ignore restricted storage */ }
  updateCartCheckoutAction();
}
function cartSellerDeliveryState(scope = null) {
  const method = selectedCartDeliveryMethod(scope);
  const groupItems = cartItemsForScope(scope);
  if (method !== "seller_delivery" || !groupItems.length) return { invalid: false, message: "" };
  if (scope === "preorder" || groupItems.every(isPreorderItem)) return { invalid: false, message: "預購會先建立本站訂單並收取訂金；商品到貨後由客服通知，再開立賣貨便供尾款取貨。" };
  const links = [...new Set(groupItems.map((item) => item.link || item.seller_link).filter(Boolean))];
  if (groupItems.some(isPreorderItem)) return { invalid: true, message: "現貨與預購已分組，請分開選擇取貨方式。" };
  if (!links.length) return { invalid: true, message: "這組現貨商品尚未設定賣貨便連結，請改選到店取貨或宅配。" };
  if (links.length > 1) return { invalid: true, message: "這組商品有不同賣場連結，請拆成不同批次結帳。" };
  return { invalid: false, message: "下一步會先建立本站「待確認」訂單，再開啟賣貨便；完成賣貨便結帳後，請等待管理員人工核對。" };
}
function syncCartDeliveryFeedback(scope = null) {
  const feedback = scope ? document.querySelector(`[data-group-feedback='${scope}']`) : document.querySelector("#cart-delivery-feedback");
  const state = cartSellerDeliveryState(scope);
  if (!feedback) return state;
  feedback.textContent = state.message;
  feedback.classList.toggle("hidden", !state.message);
  feedback.classList.toggle("is-error", state.invalid);
  feedback.classList.toggle("is-ready", Boolean(state.message) && !state.invalid);
  feedback.setAttribute("role", state.invalid ? "alert" : "status");
  return state;
}
function updateCartCheckoutAction() {
  const button = document.querySelector("#cart-drawer [data-checkout]");
  const groups = cartGroups();
  const mixed = groups.in_stock.length > 0 && groups.preorder.length > 0;
  if (button) {
    button.classList.toggle("hidden", mixed);
    if (!mixed) {
      const scope = groups.preorder.length ? "preorder" : "in_stock";
      const method = selectedCartDeliveryMethod(scope);
      const sellerCheckout = method === "seller_delivery" && scope === "in_stock";
      const sellerState = syncCartDeliveryFeedback();
      button.textContent = sellerCheckout ? "前往賣貨便結帳" : "前往 結帳";
      button.setAttribute("aria-label", sellerCheckout ? "前往賣貨便結帳" : "前往本站結帳");
      button.classList.toggle("seller-checkout-button", sellerCheckout);
      button.disabled = sellerCheckout && sellerState.invalid;
      button.setAttribute("aria-disabled", String(button.disabled));
      if (sellerState.message) button.setAttribute("aria-describedby", "cart-delivery-feedback");
      else button.removeAttribute("aria-describedby");
    }
  }
  ["in_stock", "preorder"].forEach((scope) => {
    const groupButton = document.querySelector(`[data-checkout-scope='${scope}']`);
    if (!groupButton || !groups[scope].length) return;
    const method = selectedCartDeliveryMethod(scope);
    const sellerCheckout = method === "seller_delivery" && scope === "in_stock";
    const state = syncCartDeliveryFeedback(scope);
    groupButton.textContent = sellerCheckout ? "前往賣貨便結帳" : `結帳${scope === "in_stock" ? "現貨" : "預購"}商品`;
    groupButton.classList.toggle("seller-checkout-button", sellerCheckout);
    groupButton.disabled = sellerCheckout && state.invalid;
    groupButton.setAttribute("aria-disabled", String(groupButton.disabled));
  });
  if (!mixed) syncCartDeliveryFeedback();
}
async function openSellerDeliveryCheckout(scope = "in_stock") {
  const groupItems = cartItemsForScope(scope);
  if (!groupItems.length) return showToast("請先加入商品", "warning");
  const links = [...new Set(groupItems.map((item) => item.link || item.seller_link).filter(Boolean))];
  if (!links.length) return showToast("購物車商品尚未設定賣貨便連結，請改選其他取貨方式", "warning");
  if (links.length > 1) return showToast("購物車內商品屬於不同賣場，請分開前往賣貨便結帳", "warning");
  if (groupItems.some(isPreorderItem)) return showToast("預購賣貨便請使用本站結帳，商品到貨後再由客服開立賣貨便", "warning");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const button = document.querySelector(`[data-checkout-scope='${scope}']`) || document.querySelector("#cart-drawer [data-checkout]");
  if (button instanceof HTMLButtonElement) { button.disabled = true; button.textContent = "建立待確認紀錄…"; }
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ items: groupItems.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: "together", delivery_method: "seller_delivery", payment_method: "store_payment" })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || "賣貨便待確認訂單建立失敗");
    cart.splice(0, cart.length, ...cart.filter((item) => !groupItems.includes(item)));
    saveCart();
    await syncMemberCartNow({ silent: true });
    renderCart();
    window.location.assign(links[0]);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button instanceof HTMLButtonElement) { button.disabled = false; updateCartCheckoutAction(); }
  }
}
function handleCartCheckout(scope = null) {
  const groups = cartGroups();
  if (!scope && groups.in_stock.length && groups.preorder.length) return showToast("購物車含現貨與預購，請分別點選各組的結帳按鈕", "warning");
  const checkoutScope = scope || (groups.preorder.length ? "preorder" : "in_stock");
  const method = selectedCartDeliveryMethod(checkoutScope);
  if (method === "seller_delivery" && checkoutScope === "in_stock") return openSellerDeliveryCheckout(checkoutScope);
  openCheckout(checkoutScope);
}
function removeLegacySellerCheckoutOption() {
  const sellerInput = document.querySelector("input[name='delivery_method'][value='seller_delivery']");
  sellerInput?.closest("label")?.classList.add("hidden");
}

// 商品卡、推薦卡與輪播按鈕都以規格 ID 進入獨立商品頁。
function openProductDetail(id) {
  const product = products.find((item) => item.id === id);
  if (!product) return;
  if (!product.product_id) return showToast("商品資料載入中，請稍後再試");
  productPage.open(product.product_id, product.id);
}

// 商品頁加入購物車：依庫存與限購檢查後加入指定數量。伺服器建單時仍會重新驗證。
function addVariantQuantityToCart(variantId, quantity) {
  const variant = products.find((item) => item.id === variantId);
  if (!variant) return { ok: false, message: "找不到這個規格，請重新整理頁面" };
  const purchaseLimit = Number.isInteger(Number(variant.purchase_limit)) && Number(variant.purchase_limit) > 0 ? Number(variant.purchase_limit) : null;
  const maxQuantity = purchaseLimit ? Math.min(variant.stock, purchaseLimit) : variant.stock;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQuantity) return { ok: false, message: `數量需介於 1 至 ${Math.max(maxQuantity, 1)} 件` };
  const existing = cart.find((item) => item.id === variant.id);
  if (existing && existing.quantity + quantity > maxQuantity) return { ok: false, message: "已達可選購庫存或限購上限" };
  if (existing) existing.quantity += quantity;
  else cart.push({ ...variant, quantity });
  saveCart();
  renderCart();
  return { ok: true, message: `${variant.name} 已加入購物車` };
}

// 商品卡「直接購買」：尚未在購物車才加入 1 件（避免連點變 2 件），再打開購物車抽屜；
// 取貨方式、預購與現貨分開結帳、登入都在購物車內處理，不直接跳過到結帳頁。
function buyNowFromCard(variantId) {
  if (!cart.some((item) => item.id === variantId)) {
    const result = addVariantQuantityToCart(variantId, 1);
    if (!result.ok) return showToast(result.message, "warning");
  }
  if (!document.querySelector("#cart-drawer")?.classList.contains("open")) toggleCart();
}

function readAuthReturnState() {
  try {
    const raw = sessionStorage.getItem(AUTH_RETURN_STATE_KEY);
    sessionStorage.removeItem(AUTH_RETURN_STATE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || !Number.isFinite(state.createdAt) || Date.now() - state.createdAt > AUTH_RETURN_MAX_AGE_MS) return null;
    if (state.returnPath && state.returnPath !== location.pathname) return null;
    return state;
  } catch {
    try { sessionStorage.removeItem(AUTH_RETURN_STATE_KEY); } catch { /* restricted storage */ }
    return null;
  }
}

function saveAuthReturnState() {
  const drawer = document.querySelector("#cart-drawer");
  const checkoutDialog = document.querySelector("#checkout-dialog");
  const checkoutIntent = Boolean(activeCheckoutScope && activeCheckoutItems?.length);
  const checkoutOpen = Boolean(checkoutDialog?.open || checkoutIntent);
  const value = (selector) => document.querySelector(selector)?.value || "";
  const state = {
    version: 1,
    createdAt: Date.now(),
    returnPath: location.pathname,
    scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
    scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
    cartOpen: Boolean(drawer?.classList.contains("open")),
    checkout: checkoutOpen ? {
      scope: activeCheckoutScope || null,
      stage: document.querySelector("#checkout-form")?.dataset.checkoutStage || "details",
      deliveryMethod: selectedDeliveryMethod(),
      bankAccountId: document.querySelector("input[name='bank_account']:checked")?.value || "",
      fields: {
        name: value("#checkout-name"),
        phone: value("#checkout-phone"),
        address: value("#checkout-address"),
        recipientName: value("#checkout-recipient-name"),
        recipientPhone: value("#checkout-recipient-phone"),
        couponCode: value("#checkout-coupon-code"),
        points: value("#checkout-points")
      }
    } : null
  };
  try { sessionStorage.setItem(AUTH_RETURN_STATE_KEY, JSON.stringify(state)); }
  catch { /* sessionStorage may be unavailable in restricted previews. */ }
}

function restoreCheckoutReturnState(checkout) {
  if (!checkout) return;
  const fields = checkout.fields || {};
  const assign = (selector, value) => {
    const node = document.querySelector(selector);
    if (node && typeof value === "string") node.value = value;
  };
  const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${checkout.deliveryMethod}']`);
  if (deliveryInput) deliveryInput.checked = true;
  assign("#checkout-name", fields.name);
  assign("#checkout-phone", fields.phone);
  assign("#checkout-address", fields.address);
  assign("#checkout-recipient-name", fields.recipientName);
  assign("#checkout-recipient-phone", fields.recipientPhone);
  assign("#checkout-coupon-code", fields.couponCode);
  assign("#checkout-points", fields.points);
  const bankInput = checkout.bankAccountId && document.querySelector(`input[name='bank_account'][value='${checkout.bankAccountId}']`);
  if (bankInput) bankInput.checked = true;
  syncDeliveryFields();
  renderCheckoutBenefits();
  renderCheckoutSummary();
  setCheckoutStage(checkout.stage === "review" ? "review" : "details", { focus: false });
}

async function restoreAuthReturnState() {
  if (!shouldRestoreAuthReturnState) return;
  shouldRestoreAuthReturnState = false;
  const state = authReturnState;
  authReturnState = null;
  if (!state) {
    if (authReturnError) { showToast(authReturnError, "error"); authReturnError = null; }
    return;
  }
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  window.scrollTo(Number(state.scrollX) || 0, Number(state.scrollY) || 0);
  if (state.checkout && auth.user) {
    if (!profileIsComplete()) pendingReturnCheckout = state.checkout;
    else {
      await openCheckout(state.checkout.scope || undefined);
      if (document.querySelector("#checkout-dialog")?.open) restoreCheckoutReturnState(state.checkout);
    }
  } else if (state.checkout) {
    activeCheckoutScope = state.checkout.scope || activeCheckoutScope;
    activeCheckoutItems = cartItemsForScope(activeCheckoutScope);
    if (!document.querySelector("#cart-drawer")?.classList.contains("open")) toggleCart();
  } else if (state.cartOpen && !document.querySelector("#cart-drawer")?.classList.contains("open")) {
    toggleCart();
  }
  if (authReturnError) { showToast(authReturnError, "error"); authReturnError = null; }
}

function setAuthBootMessage(message, { force = false } = {}) {
  const node = document.querySelector("[data-auth-boot-message]");
  if (node && message && (force || authBootFailed)) node.textContent = message;
}

function startAuthBoot() {
  authBootFailed = false;
  const retry = document.querySelector("[data-auth-boot-retry]");
  if (retry && retry.dataset.bound !== "true") {
    retry.dataset.bound = "true";
    retry.addEventListener("click", () => location.reload());
  }
  document.body.classList.add("auth-booting");
  document.body.classList.remove("auth-boot-ready");
  setAuthBootMessage(AUTH_BOOT_STABLE_MESSAGE, { force: true });
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  if (authBootFailsafe) clearTimeout(authBootFailsafe);
  authBootFailsafe = setTimeout(() => failAuthBoot("登入服務回應逾時，請點擊重試"), AUTH_BOOT_FAILSAFE_MS);
}

function failAuthBoot(message) {
  if (authBootFailed) return;
  authBootFailed = true;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  setAuthBootMessage(message);
  document.querySelector("#auth-boot-screen i")?.classList.add("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.remove("hidden");
}

function finishAuthBoot() {
  // A late but successful resource response may arrive after the failsafe.
  // Successful completion must be allowed to clear the retry state.
  authBootFailed = false;
  if (authBootFailsafe) {
    clearTimeout(authBootFailsafe);
    authBootFailsafe = null;
  }
  document.querySelector("#auth-boot-screen i")?.classList.remove("hidden");
  document.querySelector("[data-auth-boot-retry]")?.classList.add("hidden");
  document.body.classList.remove("auth-booting");
  document.body.classList.add("auth-boot-ready");
  document.querySelector("#auth-boot-screen")?.setAttribute("aria-hidden", "true");
}

function stripLiffCallbackMarker() {
  const url = new URL(location.href);
  if (!url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) return;
  url.searchParams.delete(LIFF_AUTO_CALLBACK_PARAM);
  history.replaceState(null, "", url.pathname + (url.search || "") + (url.hash || ""));
}

function captureAuthSession() {
  const currentUrl = new URL(location.href);
  if (currentUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    // The marker makes the OAuth handoff one-shot even when a browser or
    // LINE webview does not preserve sessionStorage across the handoff.
    liffOAuthCallbackSeen = true;
    markLiffLaunchContext("oauth-callback");
    stripLiffCallbackMarker();
  }
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const hasAuthResponse = fragment.has("access_token") || fragment.has("error") || fragment.has("error_description");
  if (hasAuthResponse) {
    authReturnState = readAuthReturnState();
    shouldRestoreAuthReturnState = Boolean(authReturnState);
  }
  if (fragment.get("error")) {
    authReturnError = fragment.get("error") === "access_denied" ? "你已取消 LINE 登入" : "LINE 登入未完成，請稍後再試";
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  if (fragment.get("access_token")) {
    // A new LINE Login callback is a new member session boundary. Do not
    // carry points/coupons or friendship state across it, even on the same
    // page lifecycle.
    clearMemberStateCache();
    auth.accessToken = fragment.get("access_token");
    auth.refreshToken = fragment.get("refresh_token");
    auth.lineProviderToken = fragment.get("provider_token");
    persistEphemeralAuthSession();
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem("cj-auth") || "null");
    auth.accessToken = saved?.accessToken ?? null;
    auth.refreshToken = saved?.refreshToken ?? null;
    auth.lineProviderToken = saved?.lineProviderToken ?? null;
  } catch {
    clearMemberStateCache();
    sessionStorage.removeItem("cj-auth");
  }
}













async function loadRuntimeConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return false;
    auth.config = await response.json();
    return true;
  } catch {
    auth.config = null;
    return false;
  }
}

function readLiffLaunchContext() {
  try {
    const raw = sessionStorage.getItem(LIFF_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      sessionStorage.removeItem(LIFF_CONTEXT_KEY);
      return null;
    }
    return parsed;
  } catch {
    try { sessionStorage.removeItem(LIFF_CONTEXT_KEY); } catch { /* restricted storage */ }
    return null;
  }
}

function markLiffLaunchContext(source = "redirect") {
  try {
    sessionStorage.setItem(LIFF_CONTEXT_KEY, JSON.stringify({ createdAt: Date.now(), source }));
  } catch { /* sessionStorage may be unavailable in restricted previews. */ }
}

function clearLiffLaunchContext() {
  try { sessionStorage.removeItem(LIFF_CONTEXT_KEY); }
  catch { /* sessionStorage may be unavailable in restricted previews. */ }
  liffPrimaryRedirectPending = false;
}

function hasLiffCredentialFragment(url = new URL(location.href)) {
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const hasSupabaseSessionFields = fragment.has("refresh_token") || fragment.has("provider_token");
  return fragment.has("context_token")
    || fragment.has("feature_token")
    || (!hasSupabaseSessionFields && fragment.has("id_token") && fragment.has("client_id"));
}

function hasLiffPrimaryRedirectParams(url = new URL(location.href)) {
  // LINE may omit liff.state for a plain LIFF URL, but the primary redirect
  // can still carry LIFF-only credential fields in the hash until liff.init()
  // resolves. Never treat access_token alone as LIFF: Supabase uses it too.
  const hasLiffQuery = [...url.searchParams.keys()].some((key) => key.startsWith("liff."));
  return hasLiffQuery || hasLiffCredentialFragment(url);
}

function hasLiffLaunchIntent(url = new URL(location.href)) {
  const hasPrimaryRedirect = hasLiffPrimaryRedirectParams(url);
  const hasLiffOAuthCallback = url.searchParams.has(LIFF_AUTO_CALLBACK_PARAM);
  if (hasPrimaryRedirect || hasLiffOAuthCallback) {
    markLiffLaunchContext(hasLiffOAuthCallback ? "oauth-callback" : "primary-redirect");
    return true;
  }
  return Boolean(readLiffLaunchContext());
}

async function initializeLiffStage({ launchIntent = false, explicitLaunch = false } = {}) {
  if (!launchIntent || !auth.config?.liffEnabled || !auth.config?.liffId) {
    return { state: null, primary: false, initialized: false };
  }
  const primaryBeforeInit = hasLiffPrimaryRedirectParams();
  liffPrimaryRedirectPending = primaryBeforeInit;
  try {
    const state = await initializeLiffClient(auth.config.liffId);
    if (!state?.isInClient) {
      clearLiffLaunchContext();
      return { state, primary: false, initialized: true };
    }
    markLiffLaunchContext("in-client");
    // A primary endpoint may navigate while liff.init() is running. If the
    // URL is still carrying the LIFF handoff after init resolves, do not
    // start product/member work on a document that is not the final endpoint.
    const primaryAfterInit = hasLiffPrimaryRedirectParams();
    liffPrimaryRedirectPending = primaryBeforeInit && primaryAfterInit;
    return { state, primary: liffPrimaryRedirectPending, initialized: true };
  } catch (error) {
    liffPrimaryRedirectPending = primaryBeforeInit || explicitLaunch;
    if (primaryBeforeInit || explicitLaunch) throw error;
    clearLiffLaunchContext();
    // A stale same-tab marker must not make the public site depend on LIFF.
    console.warn("Optional LIFF bootstrap unavailable; continuing as web page.", error);
    return { state: null, primary: false, initialized: false };
  }
}

function clearStoredAuthSession() {
  clearMemberStateCache();
  auth.accessToken = null;
  auth.refreshToken = null;
  auth.lineProviderToken = null;
  auth.user = null;
  auth.profile = null;
  cartSyncUserId = null;
  try { sessionStorage.removeItem("cj-auth"); } catch { /* restricted storage */ }
}

function persistEphemeralAuthSession({ includeRefresh = true } = {}) {
  try {
    sessionStorage.setItem("cj-auth", JSON.stringify({
      accessToken: auth.accessToken,
      refreshToken: includeRefresh ? auth.refreshToken : null,
      lineProviderToken: auth.lineProviderToken
    }));
  } catch { /* restricted storage */ }
}

async function rememberPersistentLiffSession() {
  if (!liffState.isInClient || !liffState.idToken || !auth.refreshToken) return false;
  const response = await fetch("/api/auth/session/remember", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: auth.refreshToken, id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") return false;
  auth.accessToken = result.access_token;
  auth.refreshToken = null;
  liffSessionMatches = true;
  persistEphemeralAuthSession({ includeRefresh: false });
  return true;
}

async function restorePersistentLiffSession() {
  if (!liffState.isInClient || !liffState.idToken) return false;
  const response = await fetch("/api/auth/session/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.access_token !== "string") {
    if (response.status === 409) clearStoredAuthSession();
    return false;
  }
  auth.accessToken = result.access_token;
  auth.refreshToken = null;
  auth.lineProviderToken = null;
  liffSessionMatches = true;
  persistEphemeralAuthSession({ includeRefresh: false });
  return true;
}

async function forgetPersistentLiffSession() {
  try { await fetch("/api/auth/session/forget", { method: "POST" }); }
  catch { /* best-effort cleanup */ }
}

function recentLiffAutoLoginAttempt() {
  if (liffAutoLoginAttemptAt > 0 && Date.now() - liffAutoLoginAttemptAt < LIFF_AUTO_LOGIN_MAX_AGE_MS) return true;
  try {
    const raw = sessionStorage.getItem(LIFF_AUTO_LOGIN_KEY) || "";
    const parsed = JSON.parse(raw);
    const attemptedAt = typeof parsed === "object" ? Number(parsed?.createdAt) : Number(raw);
    return Number.isFinite(attemptedAt) && attemptedAt > 0 && Date.now() - attemptedAt < LIFF_AUTO_LOGIN_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function markLiffAutoLoginAttempt() {
  liffAutoLoginAttemptAt = Date.now();
  const value = { createdAt: liffAutoLoginAttemptAt, nonce: globalThis.crypto?.randomUUID?.() || String(liffAutoLoginAttemptAt) };
  try { sessionStorage.setItem(LIFF_AUTO_LOGIN_KEY, JSON.stringify(value)); }
  catch { /* restricted storage */ }
}

async function verifyCurrentLiffIdentity({ matchSession = false } = {}) {
  if (!liffState.idToken) return null;
  const headers = { "Content-Type": "application/json" };
  if (matchSession && auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;
  const response = await fetch("/api/auth/liff/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ id_token: liffState.idToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    liffSessionMatches = false;
    const error = new Error(result.error || "LIFF LINE 身分驗證失敗");
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  liffSessionMatches = result.sessionMatch === true;
  return result;
}

async function runInitializeLiffBridge(initialState = null) {
  if (!auth.config?.liffEnabled || !auth.config?.liffId) return false;
  try {
    const state = initialState || await initializeLiffClient(auth.config.liffId);
    // External browsers may still have an active LIFF web session. Keep that
    // separate from the site's normal Supabase LINE OAuth session: only the
    // LINE in-app client is allowed to enter the LIFF session bridge.
    if (!state.initialized || !state.isInClient || !state.loggedIn || !state.idToken) return false;
    if (auth.accessToken && auth.refreshToken && state.isInClient) {
      const remembered = await rememberPersistentLiffSession();
      if (remembered) {
        try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
        return false;
      }
    }
    if (!auth.accessToken && state.isInClient) {
      const restored = await restorePersistentLiffSession();
      if (restored) {
        try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
        return false;
      }
    }
    try {
      await verifyCurrentLiffIdentity({ matchSession: Boolean(auth.accessToken) });
    } catch (error) {
      const status = Number(error.status || 0);
      if (status === 409) {
        clearStoredAuthSession();
        await forgetPersistentLiffSession();
        liffSessionMatches = false;
        // The server-side LIFF session is keyed by the LIFF identity, so the
        // correct member can usually be restored without an OAuth redirect.
        if (state.isInClient && await restorePersistentLiffSession()) return false;
        await verifyCurrentLiffIdentity();
      } else if (auth.accessToken && [401, 403].includes(status) && !recentLiffAutoLoginAttempt()) {
        clearStoredAuthSession();
        if (state.isInClient && await restorePersistentLiffSession()) return false;
        await verifyCurrentLiffIdentity();
      } else {
        throw error;
      }
    }
    if (auth.accessToken) {
      try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
      return false;
    }
    if (!state.isInClient) return false;
    if (liffOAuthCallbackSeen || recentLiffAutoLoginAttempt()) return false;
    return beginLineLogin({ automatic: true });
  } catch (error) {
    console.warn("LIFF initialization failed; falling back to web login.", error);
    return false;
  }
}

function initializeLiffBridge(initialState = null) {
  if (liffBridgeResolved) return Promise.resolve(liffBridgeResult);
  if (liffBridgeInFlight) return liffBridgeInFlight;
  const promise = runInitializeLiffBridge(initialState).then((result) => {
    liffBridgeResult = result === true;
    liffBridgeResolved = true;
    return liffBridgeResult;
  }).catch((error) => {
    liffBridgeInFlight = null;
    throw error;
  });
  liffBridgeInFlight = promise;
  return promise;
}

async function syncMemberIdentityOnce() {
  const userId = auth.user?.id;
  if (!auth.accessToken || !userId || !auth.config?.authEnabled) return;
  const storageKey = `cj-identity-sync:${userId}`;
  try {
    if (sessionStorage.getItem(storageKey) === "attempted") return;
  } catch {
    // The in-memory guard below still prevents duplicate calls in restricted previews.
  }
  if (identitySyncUserId === userId && identitySyncInFlight) return identitySyncInFlight;
  identitySyncUserId = userId;
  identitySyncInFlight = fetch("/api/member/identity-sync", { method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}` } })
    .then((response) => {
      try {
        if (response.ok) sessionStorage.setItem(storageKey, "attempted");
        else sessionStorage.removeItem(storageKey);
      } catch { /* sessionStorage may be unavailable in restricted previews. */ }
      return response;
    })
    .catch(() => {
      try { sessionStorage.removeItem(storageKey); } catch { /* ignore restricted storage */ }
      return null;
    })
    .finally(() => { identitySyncInFlight = null; });
  return identitySyncInFlight;
}

function loadMember() {
  if (memberLoadResolved) return Promise.resolve();
  if (memberLoadInFlight) return memberLoadInFlight;
  const promise = (async () => {
    if (!auth.accessToken || !auth.config?.authEnabled) return;
    try {
      const response = await fetch(`${auth.config.supabaseUrl}/auth/v1/user`, { headers: { apikey: auth.config.supabaseAnonKey, Authorization: `Bearer ${auth.accessToken}` } });
      if (!response.ok) throw new Error("expired");
      const user = await response.json();
      if ((auth.user?.id && auth.user.id !== user.id) || (cartSyncUserId && cartSyncUserId !== user.id)) resetMemberCartSyncState();
      if ((memberPointsCache.userId && memberPointsCache.userId !== user.id) || (lineFriendshipCache.userId && lineFriendshipCache.userId !== user.id)) clearMemberStateCache();
      auth.user = user;
      updateMemberButton();
      // Identity binding is an explicit, best-effort operation. A temporary
      // service-role/database failure must not log the member out or block catalog.
      await Promise.all([
        syncMemberIdentityOnce(),
        loadProfile(),
        loadPoints().catch(() => { auth.points = null; }),
        loadMemberCart()
      ]);
      updateMemberButton();
      if (!profileIsComplete()) showProfileDialog(true);
    } catch {
      clearStoredAuthSession();
    }
  })();
  memberLoadInFlight = promise.then((result) => {
    memberLoadResolved = true;
    return result;
  }).finally(() => {
    memberLoadInFlight = null;
  });
  return memberLoadInFlight;
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

async function loadPoints({ force = false } = {}) {
  const userId = auth.user?.id;
  const accessToken = auth.accessToken;
  if (!userId || !accessToken) return null;
  if (!force && memberPointsCache.userId === userId && memberPointsCache.expiresAt > Date.now() && memberPointsCache.value) {
    auth.points = memberPointsCache.value;
    renderMemberPoints();
    return auth.points;
  }
  if (memberPointsInFlight?.userId === userId && memberPointsInFlight?.accessToken === accessToken) return memberPointsInFlight.promise;
  const promise = (async () => {
    const response = await fetch("/api/member/points", { headers: { Authorization: `Bearer ${accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "點數資料讀取失敗");
    // A response from a previous session must not populate the current
    // member's cache after logout or a subsequent LINE Login callback.
    if (auth.user?.id === userId && auth.accessToken === accessToken) {
      memberPointsCache = { userId, value: result, expiresAt: Date.now() + MEMBER_POINTS_TTL_MS };
      auth.points = result;
      renderMemberPoints();
    }
    return result;
  })();
  memberPointsInFlight = { userId, accessToken, promise };
  try {
    return await promise;
  } finally {
    if (memberPointsInFlight?.promise === promise) memberPointsInFlight = null;
  }
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
  showDialog(dialog);
}

function beginLineLogin({ automatic = false } = {}) {
  if (!auth.config?.authEnabled) {
    showToast("LINE Login 尚未在 Supabase 啟用");
    return false;
  }
  if (automatic && (liffOAuthCallbackSeen || recentLiffAutoLoginAttempt())) return false;
  if (!automatic) {
    try { sessionStorage.removeItem(LIFF_AUTO_LOGIN_KEY); } catch { /* restricted storage */ }
  }
  if (automatic) markLiffAutoLoginAttempt();
  saveAuthReturnState();
  saveCart();
  const redirectUrl = new URL(location.origin + location.pathname);
  if (automatic) redirectUrl.searchParams.set(LIFF_AUTO_CALLBACK_PARAM, String(Date.now()));
  const url = new URL(`${auth.config.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set("provider", auth.config.lineProvider);
  url.searchParams.set("redirect_to", redirectUrl.toString());
  url.searchParams.set("bot_prompt", "normal");
  // The automatic LIFF handoff must not add another history entry. Manual
  // login keeps the normal browser navigation semantics.
  if (automatic) location.replace(url.toString());
  else location.assign(url.toString());
  return true;
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
    closeDialog(document.querySelector("#profile-dialog"));
    showToast("會員資料已儲存", "success");
    const pendingCheckout = pendingReturnCheckout;
    pendingReturnCheckout = null;
    if (pendingCheckout) {
      await openCheckout(pendingCheckout.scope || undefined);
      if (document.querySelector("#checkout-dialog")?.open) restoreCheckoutReturnState(pendingCheckout);
      else pendingReturnCheckout = pendingCheckout;
    }
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
  const checkoutItems = checkoutCartItems();
  const total = checkoutItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const preorderCheckout = checkoutItems.length > 0 && (activeCheckoutScope === "preorder" || checkoutItems.every(isPreorderItem));
  const depositTotal = preorderCheckout
    ? checkoutItems.reduce((sum, item) => {
      const configuredRate = Number(item.deposit_rate);
      const depositRate = Number.isFinite(configuredRate) && configuredRate > 0 ? Math.min(configuredRate, 1) : 0.5;
      return sum + Math.round(item.price * item.quantity * depositRate);
    }, 0)
    : total;
  const deliveryMethod = selectedDeliveryMethod();
  const points = Math.max(0, Number(document.querySelector("#checkout-points")?.value || 0));
  const couponCode = document.querySelector("#checkout-coupon-code")?.value.trim() || "";
  const settings = auth.points?.settings;
  const pointDiscount = settings ? Math.min(points * settings.point_value, preorderCheckout ? depositTotal : total) : 0;
  const estimatedTotal = Math.max(depositTotal - pointDiscount, 0);
  const couponRow = `<div class="checkout-summary-row"><span>優惠券</span><strong>${couponCode ? "待系統確認" : "未使用"}</strong></div>`;
  const couponNote = couponCode ? `<p class="checkout-summary-note checkout-coupon-note"><strong>優惠碼已輸入</strong>：${escapeHtml(couponCode)} 的折抵會依商品、會員資格、有效期限與併用規則於建立訂單時驗證；預估總額尚未先扣除。</p>` : "";
  const deliveryNote = deliveryMethod === "seller_delivery" && checkoutItems.every(isPreorderItem)
    ? "預購先建立本站訂單並支付訂金；到貨後客服通知，再開立賣貨便供尾款取貨。運費由 7-11 於取貨時收取。"
    : deliveryMethodNotes[deliveryMethod];
  const itemRows = checkoutItems.map((item) => `<div class="checkout-summary-row checkout-summary-item"><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${money(item.price * item.quantity)}</strong></div>`).join("");
  const depositRow = preorderCheckout ? `<div class="checkout-summary-row"><span>預購訂金 50%</span><strong>${money(depositTotal)}</strong></div>` : "";
  const pointRow = `<div class="checkout-summary-row checkout-summary-discount"><span>點數預估折抵</span><strong>${pointDiscount ? `-${money(pointDiscount)}` : money(0)}</strong></div>`;
  document.querySelector("#checkout-order-summary").innerHTML = `<div class="checkout-summary-head"><span aria-hidden="true">金額</span><div><h4>結算金額</h4><p>建立訂單後，系統回傳最終優惠與付款金額。</p></div></div><div class="checkout-summary-lines">${itemRows}<div class="checkout-summary-row"><span>商品總額</span><strong>${money(total)}</strong></div>${depositRow}${couponRow}${pointRow}<div class="checkout-summary-row checkout-summary-payable"><span>本次預估應付</span><strong>${money(estimatedTotal)}</strong></div></div>${couponNote}<p class="checkout-summary-note"><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod])}</strong>：${escapeHtml(deliveryNote)}</p>`;
  const payable = document.querySelector("#checkout-review-payable");
  if (payable) payable.textContent = money(estimatedTotal);
  const totalNote = document.querySelector("#checkout-review-total-note");
  if (totalNote) totalNote.textContent = couponCode ? "預估應付・優惠券待確認" : "本次預估應付";
}

function ensureShippingRecipientFields() {
  const addressLabel = document.querySelector("#checkout-address-label");
  if (!addressLabel || document.querySelector("#checkout-recipient-name-label")) return;
  addressLabel.insertAdjacentHTML("beforebegin", '<label id="checkout-recipient-name-label" class="hidden" data-checkout-detail>宅配收件人姓名 <input id="checkout-recipient-name" maxlength="60" autocomplete="name" placeholder="請填寫收件人姓名" /></label><label id="checkout-recipient-phone-label" class="hidden" data-checkout-detail>宅配收件人電話 <input id="checkout-recipient-phone" type="tel" inputmode="numeric" maxlength="14" autocomplete="tel" placeholder="09xx-xxx-xxx" /></label>');
  if (auth.profile?.full_name) document.querySelector("#checkout-recipient-name").value = auth.profile.full_name;
  if (auth.profile?.phone) document.querySelector("#checkout-recipient-phone").value = auth.profile.phone;
}

function ensureCheckoutFieldErrors() {
  const fields = [
    ["#checkout-name", "checkout-name-error"],
    ["#checkout-phone", "checkout-phone-error"],
    ["#checkout-recipient-name", "checkout-recipient-name-error"],
    ["#checkout-recipient-phone", "checkout-recipient-phone-error"],
    ["#checkout-address", "checkout-address-error"]
  ];
  fields.forEach(([selector, errorId]) => {
    const input = document.querySelector(selector);
    if (!input) return;
    if (!document.querySelector(`#${errorId}`)) input.insertAdjacentHTML("afterend", `<small id="${errorId}" class="field-error hidden" role="alert"></small>`);
    const describedBy = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    describedBy.add(errorId);
    input.setAttribute("aria-describedby", [...describedBy].join(" "));
  });
  const bankFieldset = document.querySelector("#checkout-bank-fieldset");
  if (bankFieldset) {
    if (!document.querySelector("#checkout-bank-error")) bankFieldset.insertAdjacentHTML("afterend", '<p id="checkout-bank-error" class="field-error hidden" role="alert"></p>');
    bankFieldset.setAttribute("aria-describedby", "checkout-bank-error");
  }
  const paymentFieldset = document.querySelector("#payment-method-fieldset");
  if (paymentFieldset) {
    if (!document.querySelector("#checkout-payment-method-error")) paymentFieldset.insertAdjacentHTML("afterend", '<p id="checkout-payment-method-error" class="field-error hidden" role="alert"></p>');
    paymentFieldset.setAttribute("aria-describedby", "checkout-payment-method-error");
  }
}

function clearCheckoutFieldErrors() {
  document.querySelectorAll("#checkout-form .field-error").forEach((node) => { node.textContent = ""; node.classList.add("hidden"); });
  document.querySelectorAll("#checkout-form [aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
}

function clearCheckoutFieldErrorFor(target) {
  const localError = target.parentElement?.querySelector(".field-error");
  if (localError) { localError.textContent = ""; localError.classList.add("hidden"); target.removeAttribute("aria-invalid"); }
  const group = target.closest("fieldset");
  const groupErrorId = group?.id === "checkout-bank-fieldset" ? "checkout-bank-error" : group?.id === "payment-method-fieldset" ? "checkout-payment-method-error" : null;
  if (groupErrorId) { document.querySelector(`#${groupErrorId}`)?.classList.add("hidden"); document.querySelector(`#${groupErrorId}`)?.replaceChildren(); group.removeAttribute("aria-invalid"); }
}

function checkoutValidationError(selector, message) {
  const field = document.querySelector(selector);
  const errorId = field?.id === "checkout-bank-fieldset" ? "checkout-bank-error" : field?.id === "payment-method-fieldset" ? "checkout-payment-method-error" : null;
  const error = errorId ? document.querySelector(`#${errorId}`) : field?.nextElementSibling;
  if (field) field.setAttribute("aria-invalid", "true");
  if (error?.classList.contains("field-error")) { error.textContent = message; error.classList.remove("hidden"); }
  const focusTarget = field?.matches("input,select,textarea") ? field : field?.querySelector("input,select,textarea");
  focusTarget?.focus({ preventScroll: true });
  throw new Error(message);
}

function checkoutDetails() {
  const fullName = document.querySelector("#checkout-name").value.trim();
  const phone = document.querySelector("#checkout-phone").value.trim();
  const deliveryMethod = selectedDeliveryMethod();
  const paymentMethod = selectedPaymentMethod();
  const shippingAddress = document.querySelector("#checkout-address").value.trim();
  const shippingRecipientName = document.querySelector("#checkout-recipient-name")?.value.trim() || "";
  const shippingPhone = document.querySelector("#checkout-recipient-phone")?.value.trim() || "";
  const bankAccountId = paymentMethod === "bank_transfer" ? document.querySelector("input[name='bank_account']:checked")?.value : null;
  return {
    fullName,
    phone,
    normalizedPhone: phone.replace(/[\s-]/g, ""),
    deliveryMethod,
    paymentMethod,
    shippingAddress,
    shippingRecipientName,
    shippingPhone,
    normalizedShippingPhone: shippingPhone.replace(/[\s-]/g, ""),
    bankAccountId
  };
}

function validateCheckoutDetails() {
  ensureShippingRecipientFields();
  ensureCheckoutFieldErrors();
  clearCheckoutFieldErrors();
  const details = checkoutDetails();
  if (!details.fullName) checkoutValidationError("#checkout-name", "請填寫姓名");
  if (!/^09\d{8}$/.test(details.normalizedPhone)) checkoutValidationError("#checkout-phone", "請輸入有效的台灣手機號碼（09 開頭，共 10 碼）");
  if (details.paymentMethod === "store_payment") checkoutValidationError("#payment-method-fieldset", "本站到店取貨與宅配訂單僅接受匯款／轉帳");
  if (details.paymentMethod === "bank_transfer" && !details.bankAccountId) checkoutValidationError("#checkout-bank-fieldset", "請選擇收款帳戶");
  if (details.deliveryMethod === "home_delivery" && !details.shippingAddress) checkoutValidationError("#checkout-address", "宅配請填寫收件地址");
  if (details.deliveryMethod === "home_delivery" && !details.shippingRecipientName) checkoutValidationError("#checkout-recipient-name", "宅配請填寫收件人姓名");
  if (details.deliveryMethod === "home_delivery" && !/^09\d{8}$/.test(details.normalizedShippingPhone)) checkoutValidationError("#checkout-recipient-phone", "宅配請填寫有效的收件人手機號碼");
  return details;
}

function setCheckoutStage(stage, { focus = true } = {}) {
  const form = document.querySelector("#checkout-form");
  if (!form) return;
  const review = stage === "review";
  form.dataset.checkoutStage = review ? "review" : "details";
  form.querySelectorAll("[data-checkout-detail]").forEach((node) => {
    node.classList.toggle("hidden", review);
    node.setAttribute("aria-hidden", String(review));
  });
  form.querySelectorAll("[data-checkout-review]").forEach((node) => {
    node.classList.toggle("hidden", !review);
    node.setAttribute("aria-hidden", String(!review));
  });
  const reviewStep = document.querySelector("#checkout-review-step");
  if (reviewStep) {
    reviewStep.classList.toggle("hidden", !review);
    reviewStep.setAttribute("aria-hidden", String(!review));
  }
  form.querySelectorAll("[data-checkout-step-indicator]").forEach((node) => {
    const current = node.dataset.checkoutStepIndicator === (review ? "review" : "details");
    const complete = node.dataset.checkoutStepIndicator === "cart" || (review && node.dataset.checkoutStepIndicator === "details");
    node.classList.toggle("is-complete", complete);
    node.classList.toggle("is-current", current);
    if (current) node.setAttribute("aria-current", "step");
    else node.removeAttribute("aria-current");
  });
  if (review) {
    renderCheckoutBenefits();
    renderCheckoutSummary();
  } else {
    syncDeliveryFields();
  }
  if (focus) window.requestAnimationFrame(() => (review ? document.querySelector("#checkout-review-title") : document.querySelector("#checkout-name"))?.focus({ preventScroll: false }));
}

function openCheckoutReview() {
  document.querySelector("#checkout-error")?.classList.add("hidden");
  try {
    validateCheckoutDetails();
    setCheckoutStage("review");
  } catch (error) {
    showCheckoutError(error.message);
  }
}

function ensurePaymentMethodUI() {
  const bankAccounts = document.querySelector("#checkout-bank-accounts");
  const bankFieldset = bankAccounts?.closest("fieldset");
  if (bankFieldset) {
    bankFieldset.id = "checkout-bank-fieldset";
  }
  if (bankFieldset && !document.querySelector("#payment-method-fieldset")) {
    bankFieldset.insertAdjacentHTML("beforebegin", '<fieldset id="payment-method-fieldset" data-checkout-detail><legend>付款方式</legend><label class="radio"><input checked type="radio" name="payment_method" value="bank_transfer" /> <span><strong>匯款／轉帳</strong><small>建單後取得專用匯款資訊；匯款完成再回報帳號末五碼。</small></span></label></fieldset>');
  }
  const paymentFieldset = document.querySelector("#payment-method-fieldset");
  document.querySelector("#checkout-payment-note")?.remove();
  const lastFive = document.querySelector("#payment-last-five");
  const lastFiveLabel = lastFive?.closest("label");
  if (lastFiveLabel) lastFiveLabel.id = "payment-last-five-label";
  const paymentForm = document.querySelector("#payment-form");
  if (paymentForm && !document.querySelector("#payment-store-note")) paymentForm.insertAdjacentHTML("beforeend", '<p id="payment-store-note" class="dialog-copy hidden">此訂單選擇到店支付，不需要回報匯款末五碼；請依通知時間到店付款取貨。</p>');
}

function syncCheckoutSellerOption() {
  const fieldset = document.querySelector("#checkout-form .delivery-methods");
  if (!fieldset) return;
  let option = document.querySelector("#checkout-seller-delivery-option");
  if (!option) {
    fieldset.insertAdjacentHTML("beforeend", '<label id="checkout-seller-delivery-option" class="radio delivery-option hidden"><input type="radio" name="delivery_method" value="seller_delivery" /> <span><strong>賣貨便</strong><small>預購商品先建立本站訂單；到貨後由客服通知並開立賣貨便，運費由 7-11 取貨時收取。</small></span></label>');
    option = document.querySelector("#checkout-seller-delivery-option");
  }
  option?.classList.toggle("hidden", activeCheckoutScope !== "preorder");
}

function syncDeliveryFields() {
  ensureShippingRecipientFields();
  ensureCheckoutFieldErrors();
  syncCheckoutSellerOption();
  const method = selectedDeliveryMethod();
  const deliveryName = document.querySelector("#checkout-delivery-name");
  const deliveryNote = document.querySelector("#checkout-delivery-note");
  if (deliveryName) deliveryName.textContent = deliveryMethodLabels[method] || deliveryMethodLabels.store_pickup;
  if (deliveryNote) {
    if (method === "home_delivery") {
      deliveryNote.innerHTML = `現貨宅配匯款時<a class="helper-contact-link checkout-home-fee-link" href="${customerServiceLineUrl}" target="_blank" rel="noopener noreferrer">先私訊小幫手確認運費再連同商品一併匯款</a>即可；預購商品到貨後通知，尾款與運費確認入帳後安排寄出。`;
    } else {
      deliveryNote.textContent = deliveryMethodNotes[method] || deliveryMethodNotes.store_pickup;
    }
  }
  const addressLabel = document.querySelector("#checkout-address-label");
  const addressInput = document.querySelector("#checkout-address");
  const recipientLabel = document.querySelector("#checkout-recipient-name-label");
  const recipientInput = document.querySelector("#checkout-recipient-name");
  const recipientPhoneLabel = document.querySelector("#checkout-recipient-phone-label");
  const recipientPhoneInput = document.querySelector("#checkout-recipient-phone");
  const isHome = method === "home_delivery";
  if (addressLabel) {
    addressLabel.classList.toggle("hidden", !isHome);
    addressLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (addressInput) addressInput.required = isHome;
  if (recipientLabel) {
    recipientLabel.classList.toggle("hidden", !isHome);
    recipientLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (recipientInput) recipientInput.required = isHome;
  if (recipientPhoneLabel) {
    recipientPhoneLabel.classList.toggle("hidden", !isHome);
    recipientPhoneLabel.setAttribute("aria-hidden", String(!isHome));
  }
  if (recipientPhoneInput) recipientPhoneInput.required = isHome;
  syncPaymentFields();
  renderCheckoutSummary();
}

function syncPaymentFields() {
  const method = selectedDeliveryMethod();
  const paymentMethodError = document.querySelector("#checkout-payment-method-error");
  if (paymentMethodError) { paymentMethodError.textContent = ""; paymentMethodError.classList.add("hidden"); document.querySelector("#payment-method-fieldset")?.removeAttribute("aria-invalid"); }
  const bankFieldset = document.querySelector("#checkout-bank-fieldset");
  if (bankFieldset) {
    // 收款帳戶在訂單建立後的付款資訊視窗顯示；第二步只保留隱藏的預設帳戶供建單使用。
    bankFieldset.classList.add("hidden");
    bankFieldset.setAttribute("aria-hidden", "true");
  }
  document.querySelector("#checkout-payment-note")?.remove();
  const submitButton = document.querySelector(".checkout-submit");
  if (submitButton) submitButton.textContent = "建立訂單並取得匯款資訊";
}

function ensureCheckoutBenefits() {
  if (document.querySelector("#checkout-coupon-code")) return;
  document.querySelector("#checkout-order-summary").insertAdjacentHTML("beforebegin", '<section class="checkout-benefits" data-checkout-review aria-hidden="true" aria-labelledby="checkout-benefits-title"><div class="checkout-benefits-head"><div><h4 id="checkout-benefits-title">優惠折抵</h4><p>可選擇使用，不影響商品保留流程。</p></div><span>OPTIONAL</span></div><div class="checkout-benefits-grid"><label>優惠碼<input id="checkout-coupon-code" maxlength="32" autocomplete="off" placeholder="輸入優惠碼（選填）" list="member-coupon-options" /><datalist id="member-coupon-options"></datalist></label><label>使用點數<input id="checkout-points" type="number" min="0" step="1" value="0" inputmode="numeric" aria-describedby="checkout-point-help" /><small id="checkout-point-help">未使用點數</small></label></div><p class="checkout-benefits-note">優惠資格、有效期限、使用次數及併用規則，會在建立訂單時由系統確認。</p></section>');
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
  const nextButton = document.querySelector("[data-checkout-review-next]");
  if (bankAccounts.length && !force) return renderBankAccounts();
  container.innerHTML = '<p class="dialog-copy">載入收款帳戶中…</p>';
  submitButton.disabled = true;
  if (nextButton) nextButton.disabled = true;
  try {
    const response = await fetch("/api/bank-accounts", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "收款帳戶載入失敗");
    bankAccounts = Array.isArray(result.accounts) ? result.accounts : [];
    renderBankAccounts();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
    submitButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
  }
}

function renderBankAccounts() {
  const container = document.querySelector("#checkout-bank-accounts");
  const submitButton = document.querySelector(".checkout-submit");
  const nextButton = document.querySelector("[data-checkout-review-next]");
  if (!bankAccounts.length) {
    container.innerHTML = '<p class="form-error">商店尚未設定收款帳戶，目前無法建立訂單，請聯繫 LINE 客服。</p>';
    submitButton.disabled = true;
    if (nextButton) nextButton.disabled = true;
    return;
  }
  container.innerHTML = bankAccounts.map((account, index) => `<label class="bank-option"><input type="radio" name="bank_account" value="${escapeHtml(account.id)}" ${index === 0 ? "checked" : ""} /><span><strong>${escapeHtml(account.label || account.bank_name)}</strong><small>${escapeHtml(account.bank_name)} ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></span></label>`).join("");
  submitButton.disabled = false;
  if (nextButton) nextButton.disabled = false;
  syncPaymentFields();
}

function showLineFriendDialog(message = "請先加入潮吉好頑官方 LINE，才能建立訂單並收到訂單狀態通知。") {
  const dialog = document.querySelector("#line-friend-dialog");
  const error = document.querySelector("#line-friend-error");
  if (error) {
    error.textContent = message;
    error.classList.remove("hidden");
  }
  showDialog(dialog);
}

async function handleLineFriendRequest(button) {
  if (!canRequestLineFriendship()) return false;
  button.setAttribute("aria-disabled", "true");
  try {
    await requestLineFriendship();
    const isFriend = await checkLineFriendship({ force: true });
    if (!isFriend) {
      showLineFriendDialog("尚未偵測到好友狀態，請完成加入後再重新檢查。");
      return true;
    }
    closeDialog(document.querySelector("#line-friend-dialog"));
    await openCheckout(activeCheckoutScope);
    return true;
  } catch (error) {
    showLineFriendDialog(error.message || "LINE 好友狀態暫時無法確認");
    return true;
  } finally {
    button.removeAttribute("aria-disabled");
  }
}

async function checkLineFriendship({ force = false } = {}) {
  const userId = auth.user?.id;
  const accessToken = auth.accessToken;
  if (!userId || !accessToken) return false;
  if (!force && lineFriendshipCache.userId === userId && lineFriendshipCache.expiresAt > Date.now() && typeof lineFriendshipCache.value === "boolean") {
    auth.lineFriendFlag = lineFriendshipCache.value;
    return auth.lineFriendFlag;
  }
  if (lineFriendshipInFlight?.userId === userId && lineFriendshipInFlight?.accessToken === accessToken) return lineFriendshipInFlight.promise;
  const promise = (async () => {
    const lineAccessToken = liffSessionMatches && liffState.accessToken ? liffState.accessToken : auth.lineProviderToken;
    const response = await fetch("/api/member/line-friendship", { headers: { Authorization: `Bearer ${accessToken}`, ...(lineAccessToken ? { "X-LINE-Login-Access-Token": lineAccessToken } : {}) } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "LINE 好友狀態暫時無法確認");
    const friendFlag = result.friendFlag === true;
    if (auth.user?.id === userId && auth.accessToken === accessToken) {
      lineFriendshipCache = { userId, value: friendFlag, expiresAt: Date.now() + LINE_FRIENDSHIP_TTL_MS };
      auth.lineFriendFlag = friendFlag;
    }
    return friendFlag;
  })();
  lineFriendshipInFlight = { userId, accessToken, promise };
  try {
    return await promise;
  } finally {
    if (lineFriendshipInFlight?.promise === promise) lineFriendshipInFlight = null;
  }
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

async function openCheckout(scope = null) {
  const groups = cartGroups();
  const resolvedScope = scope || activeCheckoutScope || (groups.preorder.length ? "preorder" : "in_stock");
  const scopedItems = cartItemsForScope(resolvedScope);
  if (!scopedItems.length) return showToast("請先加入商品");
  activeCheckoutScope = resolvedScope;
  activeCheckoutItems = scopedItems.slice();
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  if (!profileIsComplete()) return showProfileDialog(true);
  if (!await requireLineFriendshipForCheckout()) return;
  const cartMethod = selectedCartDeliveryMethod(resolvedScope);
  syncCheckoutSellerOption();
  const deliveryInput = document.querySelector(`input[name='delivery_method'][value='${cartMethod}']`);
  if (deliveryInput) deliveryInput.checked = true;
  try { await loadPoints(); } catch { /* 結帳仍可不使用優惠 */ }
  if (document.querySelector("#cart-drawer").classList.contains("open")) toggleCart();
  ensurePaymentMethodUI();
  renderCheckoutBenefits();
  const couponInput = document.querySelector("#checkout-coupon-code");
  const pointsInput = document.querySelector("#checkout-points");
  if (couponInput) couponInput.value = "";
  if (pointsInput) pointsInput.value = "0";
  syncDeliveryFields();
  renderCheckoutSummary();
  setCheckoutStage("details", { focus: false });
  clearCheckoutFieldErrors();
  document.querySelector("#checkout-error").classList.add("hidden");
  showDialog(document.querySelector("#checkout-dialog"));
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
  const preorderSeller = sellerDelivery && !storePayment;
  const hasPreorder = (order.order_items || []).some(isPreorderItem);
  const awaitingInStockHomeDeliveryFee = deliveryMethod === "home_delivery" && !hasPreorder && !Number(order.shipping_fee || 0);
  const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運。" : preorderSeller ? "預購到貨後客服會通知並開立賣貨便；運費由 7-11 於取貨時向客戶收取。" : sellerDelivery ? "賣貨便運費由 7-11 於取貨時向客戶收取，不計入訂單；如有尾款，請依客服通知完成付款。" : awaitingInStockHomeDeliveryFee ? "私訊小幫手確認運費後，與商品金額一併轉帳／匯款，確認入帳後安排寄出。" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}；請將尾款與運費一併匯款，確認入帳後安排寄出。` : "到貨後由客服通知實際運費，請將尾款與運費一併匯款，確認入帳後安排寄出。";
  const paymentText = sellerDelivery ? (storePayment ? "賣貨便取貨付款（外部）" : "匯款／轉帳（預購訂金）") : storePayment ? "到店支付" : "匯款／轉帳";
  const accountNumber = String(account?.account_number || "");
  const bankDetail = sellerDelivery && storePayment
    ? "此訂單需在 7-ELEVEN 賣貨便完成付款，本站不收取賣貨便款項。"
    : storePayment
      ? "到店取貨時支付，不需回報匯款末五碼。"
      : `<div class="transfer-account-card"><div class="transfer-card-head"><div class="transfer-card-title"><svg viewBox="0 0 24 24" aria-hidden="true"><line x1="3" y1="21" x2="21" y2="21"></line><line x1="3" y1="10" x2="21" y2="10"></line><polyline points="5 6 12 3 19 6"></polyline><line x1="4" y1="10" x2="4" y2="21"></line><line x1="20" y1="10" x2="20" y2="21"></line><line x1="8" y1="14" x2="8" y2="17"></line><line x1="12" y1="14" x2="12" y2="17"></line><line x1="16" y1="14" x2="16" y2="17"></line></svg><span>轉帳專用匯款帳號</span></div></div><div class="transfer-card-total"><span>本次應匯總額</span><strong>${money(order.deposit_due)}</strong></div><div class="transfer-account-inner"><div class="transfer-account-row"><span>收款銀行</span><strong>${escapeHtml(account?.bank_name || account?.label || "收款帳戶")}</strong></div><div class="transfer-account-row"><span>戶名</span><strong>${escapeHtml(account?.account_name || "-")}</strong></div><hr /><div class="transfer-account-number-label">匯款帳號</div><div class="transfer-account-number-line"><strong>${escapeHtml(accountNumber || "-")}</strong><button type="button" class="copy-account-button" data-copy-bank-account="${escapeHtml(accountNumber)}" aria-label="複製匯款帳號">複製<br />帳號</button></div></div><div class="transfer-card-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg><span>轉帳手續費自理；完成後請於下方立即填寫「帳號末五碼」。</span></div></div>`;
  const shippingFeeRow = deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${sellerDelivery ? "賣貨便運費" : "實際運費"}</span><strong>${sellerDelivery ? "由 7-11 向客戶收取" : order.shipping_fee ? money(order.shipping_fee) : awaitingInStockHomeDeliveryFee ? linkCustomerServiceText("請先私訊小幫手確認") : "待客服通知"}</strong></div>` : "";
  const balanceLabel = deliveryMethod === "store_pickup" || deliveryMethod === "home_delivery" || sellerDelivery ? "尾款" : "尾款／運費";
  const balanceRow = balance ? `<div class="payment-row"><span>${balanceLabel}</span><strong>${money(balance)}</strong></div>` : "";
  const amountDueRow = `<div class="payment-row amount${deliveryMethod === "store_pickup" ? " payment-store-pickup-due" : ""}"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>`;
  const paymentRows = deliveryMethod === "store_pickup" ? `${amountDueRow}${balanceRow}` : `${amountDueRow}${balanceRow}${shippingFeeRow}`;
  const deliveryNoticeClass = awaitingInStockHomeDeliveryFee ? "dialog-copy payment-delivery-notice" : "dialog-copy";
  const bankDetailClass = !storePayment && !sellerDelivery ? " transfer-bank-detail" : "";
  document.querySelector("#payment-order-detail").innerHTML = `<div class="payment-order-card"><h3>${escapeHtml(order.order_number)}</h3><div class="payment-row"><span>取貨方式</span><strong>${escapeHtml(deliveryMethodLabels[deliveryMethod] || "到店取貨")}</strong></div><div class="payment-row"><span>付款方式</span><strong>${paymentText}</strong></div><div class="payment-row"><span>商品原價</span><strong>${money(order.subtotal)}</strong></div>${order.coupon_discount ? `<div class="payment-row"><span>優惠券</span><strong>-${money(order.coupon_discount)}</strong></div>` : ""}${order.point_discount ? `<div class="payment-row"><span>點數折抵</span><strong>-${money(order.point_discount)}</strong></div>` : ""}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div>${paymentRows}<p class="${deliveryNoticeClass}">${linkCustomerServiceText(deliveryNotice)}</p><div class="bank-detail${bankDetailClass}">${bankDetail}</div><p class="deadline">付款／保留期限：${formatDateTime(order.payment_deadline)}</p></div>`;
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
  showDialog(dialog);
}

function showCheckoutError(message) {
  const errorNode = document.querySelector("#checkout-error");
  errorNode.textContent = message;
  errorNode.classList.remove("hidden");
}

async function submitOrder() {
  if (!auth.config?.authEnabled) return showToast("目前為靜態預覽，尚未連接訂單資料庫");
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const details = validateCheckoutDetails();
  const itemsForOrder = checkoutCartItems().slice();
  const pickupPlan = "together";
  await saveProfile({ full_name: details.fullName, phone: details.normalizedPhone, birthday: auth.profile?.birthday || null, address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : (auth.profile?.address || null) });
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: itemsForOrder.map((item) => ({ variant_id: item.id, quantity: item.quantity })), pickup_plan: pickupPlan, delivery_method: details.deliveryMethod, payment_method: details.paymentMethod, shipping_address: details.deliveryMethod === "home_delivery" ? details.shippingAddress : null, shipping_recipient_name: details.deliveryMethod === "home_delivery" ? details.shippingRecipientName : null, shipping_phone: details.deliveryMethod === "home_delivery" ? details.normalizedShippingPhone : null, bank_account_id: details.bankAccountId, coupon_code: document.querySelector("#checkout-coupon-code")?.value.trim() || null, points_to_redeem: Number(document.querySelector("#checkout-points")?.value || 0) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || result.message || "訂單建立失敗");
  await loadPoints({ force: true }).catch(() => {});
  cart.splice(0, cart.length, ...cart.filter((item) => !itemsForOrder.includes(item)));
  saveCart(); await syncMemberCartNow(); renderCart(); activeCheckoutItems = null; activeCheckoutScope = null; closeDialog(document.querySelector("#checkout-dialog"));
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
    closeDialog(document.querySelector("#payment-dialog"));
    activePaymentOrder = result.order;
    showToast("末五碼已送出，請等待管理員確認", "success");
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
    container.innerHTML = '<div class="orders-empty"><strong>目前還沒有訂單</strong><p>先挑一件喜歡的玩具，加入選物盒後就能在這裡追蹤付款與到貨進度。</p><button class="secondary-button" type="button" data-orders-shop>前往商品區</button></div>';
    return;
  }
  container.innerHTML = currentOrders.map((order) => {
    const items = (order.order_items || []).map((item) => `${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}`).join("<br />");
    const deliveryMethod = order.delivery_method || "store_pickup";
    const sellerPending = deliveryMethod === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const preorderSellerPending = deliveryMethod === "seller_delivery" && order.status === "pending_payment" && Boolean(order.bank_account_id);
    const expired = !sellerPending && order.status === "pending_payment" && new Date(order.payment_deadline) <= new Date();
    const deliveryNotice = deliveryMethod === "store_pickup" ? "到店取貨免運" : deliveryMethod === "seller_delivery" ? "賣貨便運費由 7-11 於取貨時收取，不計入訂單" : order.shipping_fee ? `實際運費 ${money(order.shipping_fee)}` : "運費到貨後由客服通知";
    const paymentNotice = order.bank_account_id ? "匯款／轉帳" : deliveryMethod === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付";
    const statusLabel = sellerPending ? "賣貨便待確認" : preorderSellerPending ? "預購待付訂" : expired ? "付款逾期" : escapeHtml(orderStatusLabel(order));
    const deliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryMethodLabels[deliveryMethod] || "到店取貨"}`;
    const homeBalanceNotice = order.final_payment_confirmed_at
      ? "已確認"
      : orderIncludesPreorder(order)
        ? linkCustomerServiceText("待小幫手通知確認")
        : linkCustomerServiceText("私訊小幫手確認");
    const deliveryFeeRow = deliveryMethod === "home_delivery" ? "" : `<div class="payment-row"><span>配送費用</span><strong>${deliveryNotice}</strong></div>`;
    const balanceNotice = deliveryMethod === "home_delivery" ? homeBalanceNotice : order.final_payment_confirmed_at ? "已確認" : "待客服通知或確認";
    const balanceLabel = deliveryMethod === "home_delivery" ? "尾款／運費" : "尾款";
    return `<article class="order-card${sellerPending ? " seller-pending" : ""}${preorderSellerPending ? " preorder-seller-pending" : ""}"><div class="order-card-head"><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(deliveryLabel)}</small></div><span class="status-chip${sellerPending ? " status-seller-pending" : ""}">${statusLabel}</span></div>${sellerPending ? '<p class="seller-pending-notice"><strong>本站待管理員核對</strong>：請先完成賣貨便結帳；核對後會更新本站訂單狀態並通知你。</p>' : preorderSellerPending ? '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：請於訂單成立後 2 小時內完成匯款並回報末五碼；到貨後客服會通知開立賣貨便。</p>' : ""}<div class="order-items">${items}</div><div class="payment-row"><span>付款方式</span><strong>${paymentNotice}</strong></div>${deliveryFeeRow}<div class="payment-row"><span>訂單總額</span><strong>${money(order.amount_due)}</strong></div><div class="payment-row"><span>本次應付</span><strong>${money(order.deposit_due)}</strong></div>${deliveryMethod !== "store_pickup" ? `<div class="payment-row"><span>${balanceLabel}</span><strong>${balanceNotice}</strong></div>` : ""}${order.bank_account_id && order.status === "pending_payment" && !expired ? `<button type="button" data-order-payment="${order.id}">回報匯款末五碼</button>` : ""}</article>`;
  }).join("");
}

async function openOrders() {
  if (!auth.accessToken || !auth.user) return beginLineLogin();
  const dialog = document.querySelector("#orders-dialog");
  const container = document.querySelector("#orders-list");
  container.setAttribute("aria-busy", "true");
  container.innerHTML = '<div class="skeleton-stack" role="status" aria-label="載入訂單中"><div class="skeleton-card"><span></span><i></i><i></i></div><div class="skeleton-card"><span></span><i></i><i></i></div></div>';
  showDialog(dialog);
  try {
    const response = await fetch("/api/orders", { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "訂單紀錄載入失敗");
    currentOrders = Array.isArray(result.orders) ? result.orders : [];
    renderOrders();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  } finally {
    container.removeAttribute("aria-busy");
  }
}

async function adminFetch(path, options = {}) {
  const hasFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(options.body && !hasFormData ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "管理操作失敗");
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result;
}

async function testTelegramNotification() {
  const button = document.querySelector("[data-telegram-test]");
  if (button) {
    button.disabled = true;
    button.textContent = "測試中…";
  }
  try {
    const result = await adminFetch("/api/admin/telegram-test", { method: "POST", body: JSON.stringify({}) });
    showToast(result.message || "Telegram 測試通知已送出", "success");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "測試 Telegram 通知";
    }
  }
}

function relationOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function openAdmin() {
  if (!auth.user || auth.profile?.is_admin !== true) return showToast("僅限管理員使用");
  resetAdminDataForActor();
  if (window.matchMedia("(max-width: 900px)").matches) {
    document.querySelectorAll("#admin-dialog details[data-admin-mobile-collapse][open]").forEach((details) => details.removeAttribute("open"));
  }
  const dialog = document.querySelector("#admin-dialog");
  showDialog(dialog);
  const tab = document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview";
  switchAdminTab(tab);
}

function adminSectionForTab(tab) {
  return tab === "accounts" ? "settings" : adminSections.includes(tab) ? tab : "overview";
}

function resetAdminDataForActor() {
  const actorId = auth.user?.id || null;
  if (adminDataActorId === actorId) return;
  adminDataActorId = actorId;
  adminData = null;
  adminSectionLoaded.clear();
  adminSectionInFlight.clear();
  adminManagementOptionsActorId = null;
  adminManagementOptionsLoadedAt = 0;
  adminManagementOptionsInFlight = null;
}

function hasFreshAdminManagementOptions() {
  return adminManagementOptionsActorId === auth.user?.id
    && adminManagementOptionsLoadedAt > 0
    && Date.now() - adminManagementOptionsLoadedAt < ADMIN_MANAGEMENT_OPTIONS_TTL_MS;
}

function invalidateAdminManagementOptions() {
  adminManagementOptionsLoadedAt = 0;
  adminManagementOptionsActorId = null;
}

function mergeAdminData(partial) {
  const hadManagementOptions = Boolean(adminData?.managementOptions);
  const { managementOptions, ...sectionData } = partial;
  adminData = {
    ...(adminData || {}),
    ...sectionData,
    stats: { ...(adminData?.stats || {}), ...(sectionData.stats || {}) },
    pagination: { ...(adminData?.pagination || {}), ...(sectionData.pagination || {}) }
  };
  if (managementOptions && typeof managementOptions === "object") {
    const products = Array.isArray(managementOptions.products) ? managementOptions.products : [];
    const members = Array.isArray(managementOptions.members) ? managementOptions.members : [];
    const categories = Array.isArray(managementOptions.categories) ? managementOptions.categories : [];
    adminData.managementOptions = { products, members, categories };
    adminData.productOptions = products;
    adminData.discountProducts = products;
    adminData.discountMembers = members;
    adminData.categories = categories;
    adminManagementOptionsActorId = auth.user?.id || null;
    adminManagementOptionsLoadedAt = Date.now();
    if (hadManagementOptions) refreshAdminManagementOptionControls();
  }
  return adminData;
}

function adminSectionPageQuery(section) {
  if (!(section in adminSectionPages)) return "";
  const params = new URLSearchParams({ page: String(adminSectionPages[section]), page_size: "100" });
  if (section === "orders") {
    params.set("query", document.querySelector("#admin-order-search")?.value.trim() || "");
    params.set("status", document.querySelector("#admin-order-status-filter")?.value || "all");
  }
  if (section === "members") params.set("query", document.querySelector("#admin-member-search")?.value.trim() || "");
  if (section === "products") {
    params.set("query", document.querySelector("#admin-product-search")?.value.trim() || "");
    params.set("status", document.querySelector("#admin-product-status")?.value || "all");
  }
  if (section === "audit") {
    params.set("resource", document.querySelector("#admin-audit-resource")?.value || "");
    params.set("action", document.querySelector("#admin-audit-action")?.value || "");
  }
  if (section === "notifications") {
    params.set("channel", document.querySelector("#admin-notification-channel")?.value || "all");
    params.set("status", document.querySelector("#admin-notification-status")?.value || "all");
  }
  return params.toString();
}

function adminPaginationTarget(section) {
  if (section === "orders") return "#admin-order-list";
  if (section === "members") return "#admin-member-list";
  if (section === "products") return "#admin-product-list";
  if (section === "inventory") return "#admin-movement-list";
  if (section === "discounts") return "#admin-coupon-list";
  if (section === "notifications") return "#admin-notification-list";
  return "#admin-audit-list";
}

function renderAdminPagination(section) {
  if (!(section in adminSectionPages)) return;
  const pagination = adminData?.pagination?.[section];
  const target = document.querySelector(adminPaginationTarget(section));
  if (!target) return;
  let nav = document.querySelector(`[data-admin-pagination="${section}"]`);
  if (!nav) {
    nav = document.createElement("nav");
    nav.className = "admin-pagination";
    nav.dataset.adminPagination = section;
    nav.setAttribute("aria-label", `${section} 分頁`);
    target.insertAdjacentElement("afterend", nav);
  }
  if (!pagination) {
    nav.classList.add("hidden");
    nav.innerHTML = "";
    return;
  }
  const page = Number(pagination.page || 0);
  adminSectionPages[section] = page;
  const pageSize = Number(pagination.pageSize || 100);
  nav.classList.toggle("hidden", page === 0 && !pagination.hasMore);
  nav.innerHTML = `<button class="secondary-button" type="button" data-admin-page="${section}" data-admin-page-delta="-1" ${page <= 0 ? "disabled" : ""}>上一頁</button><span aria-live="polite">第 ${page + 1} 頁</span><button class="secondary-button" type="button" data-admin-page="${section}" data-admin-page-delta="1" ${pagination.hasMore ? "" : "disabled"}>下一頁</button>`;
  nav.dataset.pageSize = String(pageSize);
}

async function changeAdminPage(section, delta) {
  const pagination = adminData?.pagination?.[section];
  if (!pagination) return;
  const current = Number(pagination.page || 0);
  const next = current + delta;
  if (next < 0 || (delta > 0 && !pagination.hasMore)) return;
  adminSectionPages[section] = next;
  try {
    await loadAdminSection(section, { force: true });
  } catch (error) {
    adminSectionPages[section] = current;
    throw error;
  }
}

function reloadAdminList(section, immediate = false) {
  if (!(section in adminSectionPages)) return;
  adminSectionPages[section] = 0;
  if (adminSearchDebounceTimers[section]) window.clearTimeout(adminSearchDebounceTimers[section]);
  const run = () => {
    adminSearchDebounceTimers[section] = null;
    loadAdminSection(section, { force: true }).catch((error) => showToast(error.message, "error"));
  };
  if (immediate) run();
  else adminSearchDebounceTimers[section] = window.setTimeout(run, 300);
}

function renderAdminSection(section) {
  if (!adminData) return;
  if (section === "overview") {
    const readyStat = document.querySelector('[data-stat="readyForPickup"]');
    if (readyStat?.previousElementSibling) readyStat.previousElementSibling.textContent = "待取貨／待尾款";
    Object.entries(adminData.stats || {}).forEach(([key, value]) => {
      const node = document.querySelector(`[data-stat="${key}"]`);
      if (node) node.textContent = value;
    });
    return;
  }
  if (section === "orders") {
    renderAdminOrderStatusFilter();
    renderAdminOrders();
    renderAdminPagination(section);
    return;
  }
  if (section === "members") {
    renderAdminMembers();
    renderAdminPagination(section);
    return;
  }
  if (section === "audit") {
    renderAdminAudit();
    renderAdminPagination(section);
    return;
  }
  if (section === "notifications") {
    renderAdminNotifications();
    renderAdminPagination(section);
    return;
  }
  if (section === "products") {
    renderAdminCategories();
    renderAdminProducts();
    renderAdminSelects({ preserveSelection: true });
    removeLegacyShippingUI();
    renderAdminPagination(section);
    return;
  }
  if (section === "inventory") {
    renderAdminSelects({ preserveSelection: true });
    renderAdminMovements();
    renderAdminLowStock();
    renderAdminPagination(section);
    return;
  }
  if (section === "discounts") {
    ensureDiscountAdminUI();
    renderAdminDiscounts();
    renderAdminPagination(section);
    return;
  }
  renderAdminAccounts();
}

async function loadAdminSection(tabOrSection, { force = false } = {}) {
  resetAdminDataForActor();
  const section = adminSectionForTab(tabOrSection);
  const existing = adminSectionInFlight.get(section);
  if (existing) return existing;
  let includeManagementOptions = ADMIN_MANAGEMENT_OPTIONS_SECTIONS.has(section) && !hasFreshAdminManagementOptions();
  if (!force && adminSectionLoaded.has(section) && !includeManagementOptions) return adminData;
  if (includeManagementOptions && adminManagementOptionsInFlight) {
    await adminManagementOptionsInFlight;
    return loadAdminSection(tabOrSection, { force });
  }
  includeManagementOptions = ADMIN_MANAGEMENT_OPTIONS_SECTIONS.has(section) && !hasFreshAdminManagementOptions();
  if (!force && adminSectionLoaded.has(section) && !includeManagementOptions) return adminData;
  const requestActorId = auth.user?.id || null;
  const loading = document.querySelector("#admin-loading");
  const errorNode = document.querySelector("#admin-error");
  loading.classList.remove("hidden");
  errorNode.classList.add("hidden");
  const request = (async () => {
    try {
      const pageQuery = adminSectionPageQuery(section);
      const endpoint = ["audit", "notifications"].includes(section)
        ? `${section === "audit" ? "/api/admin/audit-logs" : "/api/admin/notification-deliveries"}?${pageQuery}`
        : `/api/admin/dashboard?section=${encodeURIComponent(section)}${pageQuery ? `&${pageQuery}` : ""}${includeManagementOptions ? "&include_options=true" : ""}`;
      const partial = await adminFetch(endpoint);
      if (requestActorId !== (auth.user?.id || null)) return adminData;
      const options = partial.managementOptions;
      if (includeManagementOptions && (!options || !Array.isArray(options.products) || !Array.isArray(options.members) || !Array.isArray(options.categories))) {
        throw new Error("管理表單選項暫時無法載入");
      }
      mergeAdminData(partial);
      adminSectionLoaded.add(section);
      renderAdminSection(section);
      return adminData;
    } catch (error) {
      if (requestActorId === (auth.user?.id || null)) {
        errorNode.textContent = error.message;
        errorNode.classList.remove("hidden");
      }
      throw error;
    } finally {
      if (adminSectionInFlight.get(section) === request) {
        loading.classList.add("hidden");
        adminSectionInFlight.delete(section);
      }
      if (includeManagementOptions && adminManagementOptionsInFlight === request) adminManagementOptionsInFlight = null;
    }
  })();
  adminSectionInFlight.set(section, request);
  if (includeManagementOptions) adminManagementOptionsInFlight = request;
  return request;
}

function switchAdminTab(tab) {
  document.querySelectorAll("[data-admin-tab]").forEach((button) => button.classList.toggle("active", button.dataset.adminTab === tab));
  document.querySelectorAll("[data-admin-panel]").forEach((panel) => panel.classList.toggle("hidden", panel.dataset.adminPanel !== tab));
  loadAdminSection(tab).catch(() => {});
}

async function refreshAdminSections(sections) {
  await Promise.all([...new Set(sections)].map((section) => loadAdminSection(section, { force: true })));
}

async function loadAdminData(section) {
  return loadAdminSection(section || document.querySelector("[data-admin-tab].active")?.dataset.adminTab || "overview", { force: true });
}

function applyAdminQuickFilter(filter) {
  if (filter === "low_stock") {
    switchAdminTab("inventory");
  } else if (filter === "members") {
    switchAdminTab("members");
  } else {
    const statusFilter = document.querySelector("#admin-order-status-filter");
    if (statusFilter) statusFilter.value = ["pending_review", "seller_pending", "ready_for_pickup"].includes(filter) ? filter : "all";
    switchAdminTab("orders");
    reloadAdminList("orders", true);
  }
  document.querySelector(".admin-content")?.scrollTo({ top: 0, behavior: "smooth" });
}

function localDateTime(value) {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function ensureDiscountAdminUI() {
  if (!document.querySelector("[data-admin-tab='discounts']") || !document.querySelector("[data-admin-panel='discounts']")) return;
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
  renderAdminDiscountOptionBoxes({ preserveSelection: true });
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

function renderAdminDiscountOptionBoxes({ preserveSelection = false } = {}) {
  const productBox = document.querySelector("#coupon-product-options");
  const memberBox = document.querySelector("#coupon-member-options");
  const products = adminData.discountProducts || adminData.products || [];
  const members = adminData.discountMembers || adminData.members || [];
  const checkedProducts = preserveSelection ? new Set([...productBox.querySelectorAll("[name='coupon_product']:checked")].map((input) => input.value)) : new Set();
  const checkedMembers = preserveSelection ? new Set([...memberBox.querySelectorAll("[name='coupon_member']:checked")].map((input) => input.value)) : new Set();
  productBox.innerHTML = products.map((product) => `<label><input type="checkbox" name="coupon_product" value="${escapeHtml(product.id)}" ${checkedProducts.has(product.id) ? "checked" : ""} /> ${escapeHtml(product.name)}</label>`).join("") || "<small>尚無商品</small>";
  memberBox.innerHTML = members.map((member) => `<label><input type="checkbox" name="coupon_member" value="${escapeHtml(member.id)}" ${checkedMembers.has(member.id) ? "checked" : ""} /> ${escapeHtml(member.full_name || member.phone || "未命名會員")}</label>`).join("") || "<small>尚無會員</small>";
}

function auditMaskedValue(value) {
  const text = String(value ?? "");
  return text.length > 4 ? `${"*".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : "****";
}

function auditJsonSummary(value) {
  if (value == null) return "—";
  let text = "";
  try {
    text = JSON.stringify(value, (key, child) => /account_number|channel_access_token|bot_token|secret|password/i.test(key) ? auditMaskedValue(child) : child);
  } catch {
    text = String(value);
  }
  if (text.length > 320) text = `${text.slice(0, 317)}…`;
  return escapeHtml(text);
}

function renderAdminAudit() {
  const container = document.querySelector("#admin-audit-list");
  if (!container) return;
  const actionLabels = { create: "新增", update: "更新", adjust: "調整", upload: "上傳", delete: "刪除" };
  const resourceLabels = { product: "商品", product_variant: "規格", category: "分類", bank_account: "收款帳戶", coupon: "優惠券", birthday_coupon_settings: "生日券設定", point_settings: "點數設定", member_points: "會員點數", product_image: "商品圖片" };
  const logs = Array.isArray(adminData?.auditLogs) ? adminData.auditLogs : [];
  container.innerHTML = logs.length ? logs.map((entry) => {
    const actor = relationOne(entry.profiles);
    return `<article class="admin-card audit-log-card"><div><strong>${escapeHtml(actionLabels[entry.action] || entry.action)} · ${escapeHtml(resourceLabels[entry.resource] || entry.resource)}</strong><small>${formatDateTime(entry.created_at)} · 操作人：${escapeHtml(actor?.full_name || entry.actor_id || "未知")}</small><small>目標：${escapeHtml(entry.target || "—")}</small><small>前：<code>${auditJsonSummary(entry.before_data)}</code></small><small>後：<code>${auditJsonSummary(entry.after_data)}</code></small></div></article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的稽核紀錄。</div>';
}

function notificationStatusLabel(status) {
  return { pending: "待處理", processing: "發送中", sent: "已送出", failed: "失敗" }[status] || status || "未知";
}

function renderAdminNotifications() {
  const container = document.querySelector("#admin-notification-list");
  if (!container) return;
  const channelLabels = { line: "LINE", telegram: "Telegram" };
  const logs = Array.isArray(adminData?.notificationDeliveries) ? adminData.notificationDeliveries : [];
  container.innerHTML = logs.length ? logs.map((entry) => {
    const failed = entry.status === "failed";
    const retryButton = failed ? `<button class="secondary-button" type="button" data-admin-notification-requeue="${escapeHtml(entry.channel)}:${escapeHtml(entry.id)}">重新排入</button>` : "";
    const retryAt = entry.next_retry_at ? `下次重試：${formatDateTime(entry.next_retry_at)}` : "無排程重試";
    const error = entry.error_message ? `錯誤：${escapeHtml(entry.error_message)}` : "無錯誤訊息";
    return `<article class="admin-card notification-delivery-card"><div><strong>${escapeHtml(channelLabels[entry.channel] || entry.channel)} · ${escapeHtml(notificationStatusLabel(entry.status))}</strong><small>${formatDateTime(entry.updated_at || entry.created_at)} · 事件 ${escapeHtml(entry.event_type || "—")}</small><small>收件人：${escapeHtml(entry.recipient_name || entry.recipient_hint || "已遮罩")} · 訂單：${escapeHtml(entry.order_number || "—")}</small><small>嘗試 ${Number(entry.attempt_count || 0)} 次 · ${escapeHtml(retryAt)}</small><small>${error}</small></div>${retryButton}</article>`;
  }).join("") : '<div class="empty-state">目前沒有符合條件的通知紀錄。</div>';
}

async function requeueAdminNotification(button) {
  const [channel, id] = String(button.dataset.adminNotificationRequeue || "").split(":");
  if (!["line", "telegram"].includes(channel) || !/^[0-9a-f-]{36}$/i.test(id || "")) throw new Error("通知紀錄資料不正確");
  if (!(await adminConfirm({ title: "重新排入這筆失敗通知？", message: "會在下一次排程重試時發送，現在不會立即發送。", confirmLabel: "重新排入", trigger: button }))) return;
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/notification-deliveries/${channel}/${id}/requeue`, { method: "POST", body: JSON.stringify({}) });
    await loadAdminSection("notifications", { force: true });
    showToast("通知已排入下一次重試", "success");
  } finally {
    button.disabled = false;
  }
}

const adminOrderStatusFilterGroups = [
  { label: "待處理", options: [["seller_pending", "賣貨便待核對"], ["pending_payment", "待付款"], ["pending_review", "待確認款項"]] },
  { label: "處理中", options: [["confirmed", "已確認款項（依配送狀態）"], ["ready_for_pickup", "配送處理中（到貨／出貨／待尾款）"]] },
  { label: "結案／退款", options: [["completed", "已完成訂單"], ["cancelled", "已取消"], ["refund_pending", "退款處理中"], ["refunded", "已退款"]] }
];

function renderAdminOrderStatusFilter() {
  const select = document.querySelector("#admin-order-status-filter");
  if (!select) return;
  const orders = Array.isArray(adminData?.orders) ? adminData.orders : [];
  const counts = Object.fromEntries(adminOrderStatusFilterGroups.flatMap((group) => group.options).map(([value]) => [value, 0]));
  orders.forEach((order) => {
    if (Object.prototype.hasOwnProperty.call(counts, order.status)) counts[order.status] += 1;
    if (order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id) counts.seller_pending += 1;
  });
  const previous = select.value;
  const countLabel = (value) => counts[value] ? `（${counts[value]}）` : "";
  select.innerHTML = `<option value="all">全部訂單${orders.length ? `（${orders.length}）` : ""}</option>` + adminOrderStatusFilterGroups.map((group) => `<optgroup label="${group.label}">${group.options.map(([value, label]) => `<option value="${value}">${label}${countLabel(value)}</option>`).join("")}</optgroup>`).join("");
  const available = new Set(["all", ...adminOrderStatusFilterGroups.flatMap((group) => group.options.map(([value]) => value))]);
  select.value = available.has(previous) ? previous : "all";
}

function renderAdminData() {
  ensureDiscountAdminUI();
  const readyStat = document.querySelector('[data-stat="readyForPickup"]');
  if (readyStat?.previousElementSibling) readyStat.previousElementSibling.textContent = "待取貨／待尾款";
  Object.entries(adminData.stats || {}).forEach(([key, value]) => {
    const node = document.querySelector(`[data-stat="${key}"]`);
    if (node) node.textContent = value;
  });
  renderAdminAccounts();
  renderAdminOrderStatusFilter();
  renderAdminOrders();
  renderAdminMembers();
  renderAdminCategories();
  renderAdminProducts();
  renderAdminMovements();
  renderAdminLowStock();
  renderAdminSelects();
  renderAdminDiscounts();
  removeLegacyShippingUI();
}

function removeLegacyShippingUI() {
  document.querySelector("[data-admin-tab='shipping']")?.remove();
  document.querySelector("[data-admin-panel='shipping']")?.remove();
  const checkoutCopy = document.querySelector("#checkout-form > .dialog-copy");
  if (checkoutCopy) checkoutCopy.textContent = "送出後會立即保留商品；購物車若含現貨與預購，會分開建立訂單與付款期限。本站匯款訂單請於預購 2 小時內、現貨 24 小時內回報末五碼；確認付款後才扣除庫存。預購賣貨便到貨後由客服通知並開立賣貨便，運費由 7-11 取貨時收取；宅配現貨付款確認後即可由客服確認尾款與運費，預購商品則於到貨後通知。";
  const checkoutTerms = document.querySelector("#checkout-form > .terms");
  if (checkoutTerms) checkoutTerms.textContent = "送出後將立即保留本組商品庫存；預購須於 2 小時內、現貨須於 24 小時內完成匯款，逾期未回報付款將自動取消並釋放保留量，確認付款後才扣除庫存。付款完成視同同意代購規則；賣貨便運費由 7-11 於取貨時收取，宅配現貨付款確認後由客服確認尾款與運費，預購商品到貨後通知，確認入帳後才安排寄出，任何原因不接受退換貨。";
  const productCopy = document.querySelector("[data-admin-panel='products'] > .dialog-copy");
  if (productCopy) productCopy.textContent = "新增商品時可先上傳 1 張主圖；建立後可在商品卡「編輯商品資料與照片」批量上傳，最多 10 張。JPG、PNG、WebP 會優先保留比例、縮放並轉成 WebP，若瀏覽器不支援轉換則保留原始格式；單張上限 5MB。";
  const orderCopy = document.querySelector("[data-admin-panel='orders'] > .dialog-copy");
  if (orderCopy) orderCopy.textContent = "建立訂單會先保留庫存；確認訂金／付款後才會扣除庫存。未扣庫存的取消會釋放保留量；已扣庫存且尚未完成交付的取消會反轉原銷售異動。賣貨便運費由 7-11 向客戶收取，不計入訂單；現貨宅配付款確認後即可填寫實際運費，預購宅配則於到貨後更新狀態，再確認尾款與運費入帳後安排寄出。";
  const ordersCopy = document.querySelector("#orders-dialog .dialog-copy");
  if (ordersCopy) ordersCopy.textContent = "可查看訂單狀態，匯款訂單可補填匯款帳號末五碼；賣貨便訂單會先顯示為待確認，待管理員人工核對。";
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
    renderAdminPagination("members");
    return;
  }
  const kindLabels = { earn: "消費入點", redeem: "點數折抵", reversal: "點數扣回", manual: "人工調整" };
  container.innerHTML = members.map((member) => {
    const entries = memberPointEntries(member.id).slice(0, 8);
    const history = entries.map((entry) => { const order = relationOne(entry.orders); const actor = relationOne(entry.actor); return `<li><span>${escapeHtml(kindLabels[entry.kind] || entry.kind)}${order?.order_number ? ` · ${escapeHtml(order.order_number)}` : ""}</span><strong class="${entry.points > 0 ? "movement-positive" : "movement-negative"}">${entry.points > 0 ? "+" : ""}${entry.points}</strong><small>${formatDateTime(entry.created_at)} · ${escapeHtml(entry.reason)}${actor?.full_name ? ` · 操作：${escapeHtml(actor.full_name)}` : ""}</small></li>`; }).join("");
    const memberOrders = (adminData.orders || []).filter((order) => order.member_id === member.id).slice(0, 8);
    const orderHistory = memberOrders.map((order) => `<li><span>${escapeHtml(order.order_number)} · ${escapeHtml(orderStatusLabel(order))}</span><strong>${money(order.amount_due)}</strong><small>${formatDateTime(order.created_at)} · ${order.delivery_method === "store_pickup" ? "到店取貨" : order.delivery_method === "seller_delivery" ? "賣貨便" : "宅配"}</small></li>`).join("");
    return `<article class="admin-member-card"><header><div><h3>${escapeHtml(member.full_name || "尚未填寫姓名")}${member.is_admin ? " · 管理員" : ""}</h3><small>${escapeHtml(member.phone || "尚未填寫手機")} · 加入於 ${formatDateTime(member.created_at)}</small></div><div class="member-metrics"><span>點數<b>${member.point_balance}</b></span><span>累積消費<b>${money(member.lifetime_spend)}</b></span><span>訂單<b>${member.order_count}</b></span></div></header><div class="member-extra"><span>生日：${escapeHtml(member.birthday || "未填")}</span><span>地址：${escapeHtml(member.address || "未填")}</span></div><form class="admin-point-adjust" data-admin-points-form="${member.id}"><label>異動點數<input name="points" required type="number" step="1" placeholder="增加填正數、扣除填負數" /></label><label>原因<input name="reason" required maxlength="200" placeholder="例如：活動贈點、人工更正" /></label><button class="secondary-button" type="submit">調整點數</button></form><details class="admin-order-history"><summary>消費紀錄（${member.order_count || 0}）</summary>${orderHistory ? `<ol class="member-ledger">${orderHistory}</ol>` : '<p>尚無消費紀錄。</p>'}</details><details class="admin-order-history"><summary>點數紀錄（${memberPointEntries(member.id).length}）</summary>${history ? `<ol class="member-ledger">${history}</ol>` : '<p>尚無點數紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("members");
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
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("點數規則已儲存", "success");
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
  // 表單在滑出面板內時由 admin-sheets.js 開啟並捲回頂端；對 fixed 面板呼叫 scrollIntoView 會讓 iOS Safari 捲動整頁、點擊錯位
  const couponForm = document.querySelector("#admin-coupon-form");
  if (!couponForm.closest(".admin-sheet-panel")) couponForm.scrollIntoView({ behavior: "smooth", block: "start" });
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
  await refreshAdminSections(["discounts"]); resetCouponForm(); switchAdminTab("discounts"); showToast("優惠券已儲存", "success");
}

async function submitBirthdaySettings(event) {
  event.preventDefault();
  await adminFetch("/api/admin/birthday-coupon-settings", { method: "PUT", body: JSON.stringify({ enabled: document.querySelector("#birthday-enabled").checked, discount_amount: Number(document.querySelector("#birthday-amount").value), issue_days_before: Number(document.querySelector("#birthday-before").value), valid_days: Number(document.querySelector("#birthday-valid-days").value), combinable_with_points: document.querySelector("#birthday-combinable").checked }) });
  await refreshAdminSections(["discounts"]); switchAdminTab("discounts"); showToast("生日券規則已儲存", "success");
}

async function issueBirthdayCouponsNow() {
  if (!(await adminConfirm({ title: "立即執行生日券發送？", message: "已發送過的會員不會重複取得。", confirmLabel: "立即發送" }))) return;
  const result = await adminFetch("/api/admin/birthday-coupons/issue", { method: "POST" });
  await refreshAdminSections(["discounts"]);
  switchAdminTab("discounts");
  showToast(`生日券發送完成（新增 ${result.issued || 0} 張）`, "success");
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
  if (!(await adminConfirm({ title: `確定要${points > 0 ? "增加" : "扣除"} ${Math.abs(points)} 點？`, message: `異動原因：${reason}`, confirmLabel: points > 0 ? "確定增加" : "確定扣除", danger: points < 0, trigger: event.submitter }))) return;
  await adminFetch(`/api/admin/members/${form.dataset.adminPointsForm}/points`, { method: "POST", body: JSON.stringify({ points, reason }) });
  await refreshAdminSections(["members"]);
  switchAdminTab("members");
  showToast("會員點數已調整", "success");
}

function adminOrderHistory(orderId) {
  return (adminData.orderHistory || []).filter((entry) => entry.order_id === orderId);
}

function adminReturnConfirmation(orderItemId) {
  return (adminData.returns || []).find((entry) => entry.order_item_id === orderItemId);
}

function renderAdminReturnPanel(order) {
  if (order.status !== "refunded") return "";
  const items = (order.order_items || []).filter((item) => item.id);
  if (!items.length) return "";
  const rows = items.map((item) => {
    const confirmation = adminReturnConfirmation(item.id);
    const itemLabel = `${item.product_name || "商品"}${item.variant_name && item.variant_name !== "單一規格" ? ` · ${item.variant_name}` : ""}`;
    if (confirmation) {
      return `<div class="admin-return-confirmed"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><small>已驗收 ${confirmation.received_quantity} 件：可再售 ${confirmation.restock_quantity} 件、報廢 ${confirmation.scrap_quantity} 件 · ${formatDateTime(confirmation.created_at)}</small>${confirmation.note ? `<small>備註：${escapeHtml(confirmation.note)}</small>` : ""}</div>`;
    }
    return `<form class="admin-return-form" data-admin-return-form="${escapeHtml(item.id)}" data-return-max="${Number(item.quantity) || 0}"><strong>${escapeHtml(itemLabel)} × ${item.quantity}</strong><p class="admin-order-note">收到退貨後才填寫。可再售數量才會回補庫存，報廢數量只留下稽核紀錄。</p><div class="form-grid"><label>收到數量<input name="received_quantity" type="number" min="1" max="${Number(item.quantity) || 0}" required /></label><label>可再售回補<input name="restock_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label>報廢數量<input name="scrap_quantity" type="number" min="0" max="${Number(item.quantity) || 0}" value="0" required /></label><label class="wide">驗收備註<textarea name="note" rows="2" maxlength="1000" placeholder="例如：外盒損傷、配件缺少"></textarea></label></div><button class="secondary-button" type="submit">確認退貨驗收</button></form>`;
  }).join("");
  return `<section class="admin-return-panel"><h4>退貨驗收</h4><p class="admin-order-note">已退款訂單不會自動回補；逐項確認實際收到數量，再分為可再售或報廢。</p>${rows}</section>`;
}

function adminDiscountLabel(value) {
  const amount = Math.max(0, Number(value || 0));
  return amount > 0 ? `-${money(amount)}` : "未使用";
}

function renderAdminOrders() {
  const container = document.querySelector("#admin-order-list");
  const keyword = document.querySelector("#admin-order-search").value.trim().toLowerCase();
  const status = document.querySelector("#admin-order-status-filter").value;
  const orders = (adminData.orders || []).filter((order) => {
    const member = relationOne(order.profiles);
    const searchable = `${order.order_number} ${member?.full_name || ""} ${member?.phone || ""} ${order.payment_last_five || ""}`.toLowerCase();
    const isSellerPending = order.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const matchesStatus = status === "all" || (status === "seller_pending" ? isSellerPending : order.status === status);
    return matchesStatus && searchable.includes(keyword);
  }).sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  if (!orders.length) {
    container.innerHTML = '<div class="empty-state">目前沒有符合條件的訂單。</div>';
    renderAdminPagination("orders");
    return;
  }
  container.innerHTML = orders.map((order) => {
    const member = relationOne(order.profiles);
    const account = relationOne(order.bank_accounts);
    const items = (order.order_items || []).map((item) => `<div><span>${escapeHtml(item.product_name)}${item.variant_name === "單一規格" ? "" : ` · ${escapeHtml(item.variant_name)}`} × ${item.quantity}</span><strong>${money(item.unit_price * item.quantity)}</strong></div>`).join("");
    const hasPreorder = orderIncludesPreorder(order);
    const preorderStorePickup = order.delivery_method === "store_pickup" && hasPreorder;
    const transitions = (adminOrderTransitions[order.status] || []).filter((item) =>
      (!item.splitOnly || order.pickup_plan === "split")
      && (!item.storePaymentOnly || !order.bank_account_id)
      && (item.value !== "partially_ready" || preorderStorePickup)
      && (item.value !== "ready_for_pickup" || preorderStorePickup || order.delivery_method === "seller_delivery" || (order.delivery_method === "home_delivery" && hasPreorder))
      && !(item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder)
      && !(item.value === "cancelled" && order.delivery_method === "seller_delivery" && order.status === "ready_for_pickup")
      && (item.value !== "completed" || order.delivery_method !== "home_delivery" || Boolean(order.final_payment_confirmed_at))
    );
    const options = transitions.map((item) => {
      const label = item.value === "confirmed" && order.delivery_method === "seller_delivery" && !order.bank_account_id
        ? "確認賣貨便訂單並扣除庫存"
        : item.value === "confirmed" && order.delivery_method === "seller_delivery"
          ? "確認預購訂金並扣除庫存"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && !hasPreorder
          ? "確認已出貨並通知會員"
        : item.value === "ready_for_pickup" && order.delivery_method === "seller_delivery" && hasPreorder
          ? "商品已到貨，通知會員開賣貨便"
        : item.value === "ready_for_pickup" && order.delivery_method === "home_delivery" && hasPreorder
          ? "預購商品已到貨，通知會員確認尾款／運費"
        : item.value === "ready_for_pickup" && preorderStorePickup
          ? "通知會員可到店取貨"
        : item.value === "completed" && order.delivery_method === "seller_delivery"
          ? "確認已出貨、通知會員並完成訂單"
        : item.value === "completed" && order.delivery_method === "home_delivery"
          ? "確認寄送完成並結束訂單"
        : item.label;
      return `<option value="${item.value}">${escapeHtml(label)}</option>`;
    }).join("");
    const history = adminOrderHistory(order.id).slice(0, 5).map((entry) => { const actor = relationOne(entry.profiles); return `<li><span>${escapeHtml(adminOrderStatusLabel(order, entry.from_status))} → ${escapeHtml(adminOrderStatusLabel(order, entry.to_status))}</span><small>${formatDateTime(entry.created_at)}${actor?.full_name ? ` · ${escapeHtml(actor.full_name)}` : ""}${entry.note ? ` · ${escapeHtml(entry.note)}` : ""}</small></li>`; }).join("");
    const balance = Math.max(order.amount_due - order.paid_amount, 0);
    const couponDiscount = Number(order.coupon_discount || 0);
    const pointDiscount = Number(order.point_discount || 0);
    const deliveryLabel = deliveryMethodLabels[order.delivery_method || "store_pickup"] || "到店取貨";
    const orderDeliveryLabel = `${orderInventoryTypeLabel(order)}．${deliveryLabel}`;
    const shippingInfo = order.delivery_method === "home_delivery" ? `<p class="admin-order-note">收件人：${escapeHtml(order.shipping_recipient_name || "未填寫")}<br />電話：${escapeHtml(order.shipping_phone || "未填寫")}<br />地址：${escapeHtml(order.shipping_address || "未填寫")}</p>` : "";
    return `<article class="admin-order-card"><header><div><h3>${escapeHtml(order.order_number)}</h3><small>${formatDateTime(order.created_at)} · ${escapeHtml(orderDeliveryLabel)}${order.confirmed_at || order.payment_confirmed_at ? ` · 確認：${formatDateTime(order.confirmed_at || order.payment_confirmed_at)}` : ""}</small></div><span class="status-chip status-${order.status}">${escapeHtml(adminOrderStatusLabel(order))}</span></header><div class="admin-order-member"><strong>${escapeHtml(member?.full_name || "未填姓名")}</strong><span>${escapeHtml(member?.phone || "未填手機")}</span></div><div class="admin-order-items">${items}</div><div class="admin-order-payment"><span class="admin-order-total">總額 <b>${money(order.amount_due)}</b></span><span class="admin-order-payment-method">運費 <b>${order.shipping_fee ? money(order.shipping_fee) : "免運"}</b></span><span class="admin-order-deposit">訂金應付 <b>${money(order.deposit_due)}</b></span><span class="admin-order-paid">已確認 <b>${money(order.paid_amount || 0)}</b></span><span class="admin-order-balance">待收尾款 <b>${money(balance)}</b></span><span class="admin-order-discount admin-order-coupon">優惠券折抵 <b>${adminDiscountLabel(couponDiscount)}</b></span><span class="admin-order-discount admin-order-points">點數折抵 <b>${adminDiscountLabel(pointDiscount)}</b></span></div>${shippingInfo}<div class="admin-order-bank"><span>${escapeHtml(account?.label || account?.bank_name || "未指定帳戶")}</span><span>匯款末五碼：<b>${escapeHtml(order.payment_last_five || "尚未回報")}</b></span></div>${order.admin_note ? `<p class="admin-order-note">目前備註：${escapeHtml(order.admin_note)}</p>` : ""}${transitions.length ? `<form class="admin-order-action" data-admin-order-form="${order.id}"><label>下一步<select name="target_status">${options}</select></label><label>管理備註<textarea name="note" rows="2" maxlength="1000" placeholder="取消與退款相關操作必填；其他操作可選填"></textarea></label><button class="primary-button" type="submit">更新訂單</button></form>` : '<p class="admin-order-terminal">此訂單目前沒有可執行的下一步。</p>'}${renderAdminReturnPanel(order)}<details class="admin-order-history"><summary>狀態紀錄（${adminOrderHistory(order.id).length}）</summary>${history ? `<ol>${history}</ol>` : '<p>尚無管理異動紀錄。</p>'}</details></article>`;
  }).join("");
  renderAdminPagination("orders");
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const paymentNode = card.querySelector(".admin-order-payment-method");
    const order = orders[index];
    if (!paymentNode || !order) return;
    const hasPreorder = orderIncludesPreorder(order);
    paymentNode.innerHTML = `付款方式 <b>${order.bank_account_id ? "匯款／轉帳" : order.delivery_method === "seller_delivery" ? "賣貨便取貨付款（外部）" : "到店支付"}</b>`;
    const paymentGrid = card.querySelector(".admin-order-payment");
    const shippingFeeLabel = order.delivery_method === "store_pickup" ? "免運" : order.delivery_method === "seller_delivery" ? "由 7-11 收取" : order.shipping_fee ? money(order.shipping_fee) : "待客服通知";
    const balanceLabel = order.delivery_method === "store_pickup" ? "到店確認" : order.delivery_method === "seller_delivery" ? "依賣貨便訂單" : order.final_payment_confirmed_at ? "已確認" : "尚未確認";
    if (paymentGrid) paymentGrid.insertAdjacentHTML("beforeend", `<span>${order.delivery_method === "seller_delivery" ? "賣貨便運費" : "實際運費"} <b>${shippingFeeLabel}</b></span><span>尾款／運費 <b>${balanceLabel}</b></span>`);
    if (order.delivery_method === "home_delivery") {
      const currentStockHomePending = order.delivery_method === "home_delivery" && !hasPreorder && order.status === "pending_review";
      const canUpdateFulfillment = currentStockHomePending || ["partially_ready", "ready_for_pickup"].includes(order.status);
      const terminalStatuses = ["completed", "cancelled", "refund_pending", "refunded"];
      const insertBefore = card.querySelector(".admin-order-action") || card.querySelector(".admin-order-history");
      if (canUpdateFulfillment) {
        const form = document.createElement("form");
        form.className = "admin-fulfillment-form";
        form.dataset.adminFulfillmentForm = order.id;
        const fulfillmentTiming = currentStockHomePending ? "待確認款項階段填寫" : hasPreorder ? "預購商品到貨後" : "現貨備貨完成後";
        const shippingFeeField = `<label>實際運費<input name="shipping_fee" type="number" min="0" step="1" value="${Number(order.shipping_fee || 0)}" required /><small>${fulfillmentTiming}填寫，會加入待收金額。</small></label>`;
        const finalPaymentLabel = currentStockHomePending ? "已確認全額與運費入帳" : "已確認尾款與運費入帳";
        const lastFiveLabel = currentStockHomePending ? "匯款末五碼" : "尾款匯款末五碼";
        const submitLabel = currentStockHomePending ? "儲存運費／匯款末五碼" : "儲存尾款／運費";
        const notePlaceholder = currentStockHomePending ? "例如：客服確認運費金額、匯款確認日期" : "例如：宅配箱型、客服通知日期";
        form.innerHTML = `<div class="form-grid"><div>${shippingFeeField}</div><label>${lastFiveLabel}<input name="final_payment_last_five" maxlength="5" inputmode="numeric" pattern="[0-9]{5}" value="${escapeHtml(order.final_payment_last_five || "")}" placeholder="付款後填寫" /></label><label class="check-field"><input name="final_payment_confirmed" type="checkbox" ${order.final_payment_confirmed_at ? "checked" : ""} /> ${finalPaymentLabel}</label><label class="wide">收款備註<textarea name="note" rows="2" maxlength="1000" placeholder="${notePlaceholder}">${escapeHtml(order.admin_note || "")}</textarea></label></div><button class="secondary-button" type="submit">${submitLabel}</button>`;
        card.insertBefore(form, insertBefore);
      } else if (!terminalStatuses.includes(order.status)) {
        const prompt = document.createElement("p");
        prompt.className = "admin-order-terminal";
        prompt.textContent = order.status === "confirmed"
          ? hasPreorder
            ? "預購宅配：請等商品實際到貨後，更新為「預購商品已到貨」；之後即可填寫尾款與運費。"
            : "現貨宅配：請在待確認款項階段填寫實際運費與匯款末五碼，再確認款項並扣除庫存。"
          : "請先完成訂金／付款確認；宅配進入備貨或到貨狀態後，才能填寫尾款與運費。";
        card.insertBefore(prompt, insertBefore);
      }
    }
  });
  container.querySelectorAll(".admin-order-card").forEach((card, index) => {
    const order = orders[index];
    const sellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && !order.bank_account_id;
    const preorderSellerPending = order?.delivery_method === "seller_delivery" && order.status === "pending_payment" && Boolean(order.bank_account_id);
    if (!sellerPending && !preorderSellerPending) return;
    if (preorderSellerPending) {
      card.classList.add("preorder-seller-pending");
      const statusChip = card.querySelector(".status-chip");
      if (statusChip) statusChip.textContent = "預購待付訂";
      if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>預購訂金待確認</strong>：會員須於 2 小時內回報末五碼；確認後保留庫存，商品到貨再由客服開立賣貨便。</p>');
      return;
    }
    card.classList.add("seller-pending");
    const statusChip = card.querySelector(".status-chip");
    if (statusChip) {
      statusChip.textContent = "賣貨便待確認";
      statusChip.classList.add("status-seller-pending");
    }
    if (!card.querySelector(".seller-pending-notice")) card.querySelector("header")?.insertAdjacentHTML("afterend", '<p class="seller-pending-notice"><strong>請先核對賣貨便訂單</strong>：確認外部訂單內容後，再更新狀態並扣除庫存。</p>');
  });
  container.querySelectorAll("[data-admin-order-form]").forEach((form) => {
    const target = form.querySelector("select[name='target_status']");
    const button = form.querySelector("button[type='submit']");
    if (!(target instanceof HTMLSelectElement) || !(button instanceof HTMLButtonElement)) return;
    const syncRiskState = () => {
      const dangerous = ["cancelled", "refund_pending", "refunded"].includes(target.value);
      button.classList.toggle("danger-button", dangerous);
      button.textContent = dangerous ? "確認高風險操作" : "更新訂單";
      button.setAttribute("aria-label", dangerous ? "確認取消或退款等高風險操作" : "更新訂單");
    };
    target.addEventListener("change", syncRiskState);
    syncRiskState();
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
  const currentOrder = (adminData.orders || []).find((order) => order.id === form.dataset.adminOrderForm);
  const warning = targetStatus === "confirmed"
    ? "確認款項後會正式扣除商品庫存。"
    : targetStatus === "completed"
      ? "完成訂單代表商品已取走且尾款已收訖。"
      : targetStatus === "cancelled" && ["pending_payment", "pending_review"].includes(currentOrder?.status)
        ? "此訂單尚未扣除實體庫存；取消後會釋放保留量。"
      : targetStatus === "cancelled"
        ? "此訂單已扣除庫存且尚未完成交付；取消後會由系統反轉原銷售異動，不能再手動重複回補。"
      : ["refund_pending", "refunded"].includes(targetStatus)
        ? "退款流程不會自動回補庫存；收到實物後，請在已退款訂單逐項驗收並分為可再售或報廢。"
        : "";
  if (!(await adminConfirm({ title: "確定更新此訂單狀態？", message: warning, confirmLabel: "確定更新", danger: ["cancelled", "refund_pending", "refunded"].includes(targetStatus), trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminOrderForm}/transition`, { method: "POST", body: JSON.stringify({ target_status: targetStatus, note }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("訂單狀態已更新", "success");
    await loadProducts();
    renderProducts();
  } finally {
    button.disabled = false;
  }
}

async function submitAdminOrderReturn(event) {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) throw new Error("退貨驗收表單資料無法讀取");
  const receivedField = form.elements.namedItem("received_quantity");
  const restockField = form.elements.namedItem("restock_quantity");
  const scrapField = form.elements.namedItem("scrap_quantity");
  const noteField = form.elements.namedItem("note");
  if (!(receivedField instanceof HTMLInputElement) || !(restockField instanceof HTMLInputElement) || !(scrapField instanceof HTMLInputElement) || !(noteField instanceof HTMLTextAreaElement)) throw new Error("退貨驗收表單欄位不完整");
  const received = Number(receivedField.value);
  const restock = Number(restockField.value);
  const scrap = Number(scrapField.value);
  const max = Number(form.dataset.returnMax || 0);
  if (![received, restock, scrap].every(Number.isInteger) || received <= 0 || received > max || restock < 0 || scrap < 0 || restock + scrap !== received) throw new Error("收到、可再售與報廢數量必須正確相等，且不可超過原購買數量");
  if (!(await adminConfirm({ title: "確認退貨驗收？", message: `收到 ${received} 件，其中可再售 ${restock} 件、報廢 ${scrap} 件。`, confirmLabel: "確認驗收", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/order-items/${form.dataset.adminReturnForm}/return`, { method: "POST", body: JSON.stringify({ received_quantity: received, restock_quantity: restock, scrap_quantity: scrap, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders", "overview", "inventory", "products"]);
    switchAdminTab("orders");
    showToast("退貨驗收已記錄", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
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
  if (confirmed && !(await adminConfirm({ title: "確認尾款與運費已入帳？", message: "確認後即可完成寄送訂單。", confirmLabel: "確認已入帳", trigger: event.submitter }))) return;
  const button = form.querySelector("button[type='submit']");
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await adminFetch(`/api/admin/orders/${form.dataset.adminFulfillmentForm}/fulfillment`, { method: "PATCH", body: JSON.stringify({ shipping_fee: shippingFee, final_payment_confirmed: confirmed, final_payment_last_five: finalFive || null, note: noteField.value.trim() }) });
    await refreshAdminSections(["orders"]);
    switchAdminTab("orders");
    showToast("尾款與實際運費已更新", "success");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
  }
}

function renderAdminAccounts() {
  const container = document.querySelector("#admin-account-list");
  const accounts = adminData.accounts || [];
  container.innerHTML = accounts.length ? accounts.map((account) => `<div class="admin-card"><div><strong>${escapeHtml(account.label)} ${account.is_active ? "" : "（已停用）"}</strong><small>${escapeHtml(account.bank_name)} · ${escapeHtml(account.account_number)}<br />戶名：${escapeHtml(account.account_name)}</small></div><button type="button" data-account-edit="${account.id}">編輯</button></div>`).join("") : '<div class="empty-state">尚未設定收款帳戶；新增後前台才可建立訂單。</div>';
}

function sortedAdminCategories() {
  return (adminData?.categories || []).slice().sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0) || String(left.name || "").localeCompare(String(right.name || ""), "zh-Hant"));
}

function adminCategoryOptions(selectedId = "", { required = false, includeInactiveSelected = false } = {}) {
  const selected = String(selectedId || "");
  const categories = sortedAdminCategories().filter((category) => category.is_active !== false || (includeInactiveSelected && String(category.id) === selected));
  const placeholder = required ? "請選擇分類" : "未分類";
  return `<option value="">${placeholder}</option>${categories.map((category) => `<option value="${escapeHtml(category.id)}" data-category-name="${escapeHtml(category.name)}" ${String(category.id) === selected ? "selected" : ""}>${escapeHtml(category.name)}${category.is_active === false ? "（已停用）" : ""}</option>`).join("")}`;
}

function resetAdminCategoryForm() {
  const form = document.querySelector("#admin-category-form");
  if (form instanceof HTMLFormElement) form.reset();
  const id = document.querySelector("#admin-category-edit-id");
  const order = document.querySelector("#admin-category-order");
  const active = document.querySelector("#admin-category-active");
  const title = document.querySelector("[data-category-form-title]");
  const submit = form?.querySelector("button[type='submit']");
  const cancel = document.querySelector("[data-admin-category-cancel]");
  if (id) id.value = "";
  if (order) order.value = "0";
  if (active) active.checked = true;
  if (title) title.textContent = "新增分類";
  if (submit) submit.textContent = "新增分類";
  cancel?.classList.add("hidden");
}

function focusAdminCategoryForm() {
  const details = document.querySelector("#admin-category-management");
  if (details instanceof HTMLDetailsElement) details.open = true;
  window.setTimeout(() => document.querySelector("#admin-category-name")?.focus(), 0);
}

function editAdminCategory(categoryId) {
  const category = sortedAdminCategories().find((item) => item.id === categoryId);
  if (!category) return;
  document.querySelector("#admin-category-edit-id").value = category.id;
  document.querySelector("#admin-category-name").value = category.name;
  document.querySelector("#admin-category-order").value = String(category.display_order || 0);
  document.querySelector("#admin-category-active").checked = category.is_active !== false;
  document.querySelector("[data-category-form-title]").textContent = "編輯分類";
  document.querySelector("#admin-category-form button[type='submit']").textContent = "儲存分類";
  document.querySelector("[data-admin-category-cancel]").classList.remove("hidden");
  const details = document.querySelector("#admin-category-management");
  if (details instanceof HTMLDetailsElement) details.open = true;
  document.querySelector("#admin-category-name")?.focus();
}

function renderAdminCategories() {
  const picker = document.querySelector("#admin-category-id");
  if (picker instanceof HTMLSelectElement) {
    const selected = picker.value;
    picker.innerHTML = adminCategoryOptions(selected, { required: true });
    if ([...picker.options].some((option) => option.value === selected)) picker.value = selected;
  }
  const list = document.querySelector("#admin-category-list");
  if (!(list instanceof HTMLElement)) return;
  const categories = sortedAdminCategories();
  if (!categories.length) {
    list.innerHTML = '<div class="empty-state">尚未建立分類，請先新增一個分類。</div>';
    return;
  }
  const productCounts = new Map(categories.map((category) => [category.id, 0]));
  (adminData.productOptions || adminData.products || []).forEach((product) => {
    if (product.category_id && productCounts.has(product.category_id)) productCounts.set(product.category_id, productCounts.get(product.category_id) + 1);
  });
  list.innerHTML = categories.map((category) => `<article class="admin-card admin-category-card"><div><strong>${escapeHtml(category.name)}</strong><small>排序 ${Number(category.display_order || 0)} · ${category.is_active === false ? "已停用（不供新商品選擇）" : "啟用"} · 使用商品 ${productCounts.get(category.id) || 0} 件</small></div><button type="button" data-admin-category-edit="${escapeHtml(category.id)}">編輯</button></article>`).join("");
}

async function submitAdminCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = document.querySelector("#admin-category-edit-id").value.trim();
  const name = document.querySelector("#admin-category-name").value.trim();
  const displayOrder = Number(document.querySelector("#admin-category-order").value || 0);
  const isActive = document.querySelector("#admin-category-active").checked;
  if (!name) throw new Error("請填寫分類名稱");
  if (!Number.isInteger(displayOrder) || displayOrder < 0) throw new Error("分類排序須為 0 或正整數");
  const submit = form.querySelector("button[type='submit']");
  if (submit instanceof HTMLButtonElement) { submit.disabled = true; submit.textContent = "儲存中…"; }
  try {
    await adminFetch(id ? `/api/admin/categories/${id}` : "/api/admin/categories", { method: id ? "PATCH" : "POST", body: JSON.stringify({ name, display_order: displayOrder, is_active: isActive }) });
    invalidateAdminManagementOptions();
    resetAdminCategoryForm();
    await refreshAdminSections(["products"]);
    switchAdminTab("products");
    showToast(id ? "商品分類已更新" : "商品分類已新增", "success");
  } finally {
    if (submit instanceof HTMLButtonElement) { submit.disabled = false; submit.textContent = id ? "儲存分類" : "新增分類"; }
  }
}

function renderAdminSelects({ preserveSelection = false } = {}) {
  const products = adminData.productOptions || adminData.products || [];
  const productOptions = products.map((product) => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join("");
  const productSelect = document.querySelector("#admin-variant-product");
  const selectedProduct = preserveSelection ? productSelect?.value : "";
  if (productSelect) {
    productSelect.innerHTML = productOptions || '<option value="">請先建立商品</option>';
    if (selectedProduct && [...productSelect.options].some((option) => option.value === selectedProduct)) productSelect.value = selectedProduct;
  }
  const variantOptions = products.flatMap((product) => (product.product_variants || []).map((variant) => `<option value="${variant.id}">${escapeHtml(product.name)} · ${escapeHtml(variant.name)}（庫存 ${variant.stock_on_hand}）</option>`)).join("");
  const variantSelect = document.querySelector("#admin-inventory-variant");
  const selectedVariant = preserveSelection ? variantSelect?.value : "";
  if (variantSelect) {
    variantSelect.innerHTML = variantOptions || '<option value="">目前沒有商品規格</option>';
    if (selectedVariant && [...variantSelect.options].some((option) => option.value === selectedVariant)) variantSelect.value = selectedVariant;
  }
}

function refreshAdminManagementOptionControls() {
  if (!adminData) return;
  renderAdminCategories();
  document.querySelectorAll("[data-edit-product-form] select[name='category_id']").forEach((select) => {
    const selected = select.value;
    select.innerHTML = adminCategoryOptions(selected, { includeInactiveSelected: true });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  });
  renderAdminSelects({ preserveSelection: true });
  renderAdminDiscountOptionBoxes({ preserveSelection: true });
}

/** 建立後台商品主圖缺失或載入失敗時的可存取替代內容。 */
function adminProductImageFallbackMarkup() {
  return '<span class="admin-product-placeholder" role="img" aria-label="尚無商品圖片"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 6.5h16v11H4zM7 6.5l1.8-2h6.4l1.8 2M8 13l2.2-2.2 2.3 2.3 1.5-1.5 2 2"/></svg><small>NO IMAGE</small></span>';
}

/** 將後台商品縮圖的 404／解碼失敗畫面替換為一致的 fallback。 */
function handleAdminProductImageError(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const thumbnail = image.closest(".admin-product-thumbnail");
  if (!thumbnail || thumbnail.dataset.imageFallbackApplied === "true") return;
  thumbnail.dataset.imageFallbackApplied = "true";
  thumbnail.innerHTML = adminProductImageFallbackMarkup();
}

function ensureAdminPointsEligibilityUI() {
  if (document.querySelector("#admin-points-excluded")) return;
  const limitLabel = document.querySelector("#admin-purchase-limit")?.closest("label");
  if (!limitLabel) return;
  limitLabel.insertAdjacentHTML("afterend", '<label class="check-field admin-points-excluded-field"><input id="admin-points-excluded" type="checkbox" /> 不可累積會員點數<small>啟用後，完成訂單時此商品金額不列入新點數累積。</small></label>');
}

function ensureAdminPricingUI() {
  const productPrice = document.querySelector("#admin-price")?.closest("label");
  if (productPrice && !document.querySelector("#admin-compare-at-price")) productPrice.insertAdjacentHTML("afterend", '<label>原價（選填）<input id="admin-compare-at-price" type="number" min="0" step="1" placeholder="例如 1680" /><small>高於售價時顯示刪除線與限時優惠。</small></label>');
  const variantPrice = document.querySelector("#admin-new-price")?.closest("label");
  if (variantPrice && !document.querySelector("#admin-new-compare-at-price")) variantPrice.insertAdjacentHTML("afterend", '<label>原價（選填）<input id="admin-new-compare-at-price" type="number" min="0" step="1" placeholder="例如 1680" /><small>高於售價時顯示刪除線與限時優惠。</small></label>');
}

// 商品列表版面由 admin-products-table.js 負責（ADMIN_REDESIGN_PLAN Stage 8）；新增商品表單的附加欄位仍在此補上
function renderAdminProducts() {
  ensureAdminPointsEligibilityUI();
  ensureAdminPricingUI();
  renderAdminProductsTable();
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

function ensureAdminLowStockUI() {
  const panel = document.querySelector("[data-admin-panel='inventory']");
  const heading = panel?.querySelector("h3");
  if (heading && !document.querySelector("#admin-low-stock-list")) heading.insertAdjacentHTML("beforebegin", '<section class="admin-low-stock" aria-labelledby="admin-low-stock-title"><div class="admin-low-stock-head"><h3 id="admin-low-stock-title">低庫存規格</h3><span id="admin-low-stock-count">0</span></div><div id="admin-low-stock-list"></div></section>');
}

function renderAdminLowStock() {
  ensureAdminLowStockUI();
  const list = document.querySelector("#admin-low-stock-list");
  const count = document.querySelector("#admin-low-stock-count");
  if (!list) return;
  const lowStock = (adminData.productOptions || adminData.managementOptions?.products || []).flatMap((product) => (product.product_variants || []).filter((variant) => Number(variant.stock_on_hand) <= Number(variant.safety_stock)).map((variant) => ({ product, variant })));
  if (count) count.textContent = `${lowStock.length} 項`;
  list.innerHTML = lowStock.length ? lowStock.map(({ product, variant }) => `<div class="admin-low-stock-row"><div><strong>${escapeHtml(product.name)} · ${escapeHtml(variant.name)}</strong><small>SKU ${escapeHtml(variant.sku)} · 安全庫存 ${variant.safety_stock}</small></div><span>${variant.stock_on_hand}</span><button class="secondary-button" type="button" data-admin-low-stock-variant="${escapeHtml(variant.id)}">調整庫存</button></div>`).join("") : '<p class="admin-low-stock-empty">目前沒有低於安全庫存的規格。</p>';
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
  await refreshAdminSections(["settings"]);
  switchAdminTab("accounts");
  showToast("收款帳戶已儲存", "success");
}

function normalizePreorderDate(value) {
  const candidate = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function splitPreorderArrival(value) {
  const raw = String(value || "").trim();
  if (!raw) return { from: "", until: "", raw: "" };
  const matches = [...raw.matchAll(/(\d{3,4})[\/.-](\d{1,2})[\/.-](\d{1,2})/g)].map((match) => {
    const year = Number(match[1]) < 1000 ? Number(match[1]) + 1911 : Number(match[1]);
    const month = String(Number(match[2])).padStart(2, "0");
    const day = String(Number(match[3])).padStart(2, "0");
    const iso = `${String(year).padStart(4, "0")}-${month}-${day}`;
    const date = new Date(`${iso}T00:00:00`);
    return date.getFullYear() === year && date.getMonth() + 1 === Number(month) && date.getDate() === Number(day) ? iso : "";
  }).filter(Boolean).slice(0, 2);
  const remainder = raw.replace(/\d{3,4}[\/.-]\d{1,2}[\/.-]\d{1,2}/g, "").replace(/[至到~～—–\-\s]/g, "");
  if (!matches.length || remainder) return { from: "", until: "", raw };
  return { from: matches[0], until: matches[1] || "", raw: "" };
}

function preorderArrivalValue(from, until, rawFallback = "") {
  const start = normalizePreorderDate(from);
  const end = normalizePreorderDate(until);
  if (!start && !end) return String(rawFallback || "").trim() || null;
  if (start && end && end < start) throw new Error("預計到貨區間的結束日期不可早於開始日期");
  return start && end && start !== end ? `${start} 至 ${end}` : start || end;
}

function productFormBody() {
  const kind = document.querySelector("#admin-kind").value;
  const categorySelect = document.querySelector("#admin-category-id");
  const categoryOption = categorySelect?.selectedOptions?.[0];
  const categoryId = categorySelect?.value || "";
  const categoryName = categoryOption?.dataset.categoryName || "";
  if (!categoryId || !categoryName) throw new Error("請選擇啟用中的商品分類；若需新增請先建立分類");
  return {
    category_id: categoryId,
    category_name: categoryName,
    product_name: document.querySelector("#admin-product-name").value,
    description: document.querySelector("#admin-product-description").value,
    variant_name: document.querySelector("#admin-variant-name").value,
    sku: document.querySelector("#admin-sku").value,
    kind,
    price: Number(document.querySelector("#admin-price").value),
    compare_at_price: document.querySelector("#admin-compare-at-price")?.value ? Number(document.querySelector("#admin-compare-at-price").value) : null,
    stock: Number(document.querySelector("#admin-stock").value),
    purchase_limit: document.querySelector("#admin-purchase-limit").value ? Number(document.querySelector("#admin-purchase-limit").value) : null,
    points_eligible: !document.querySelector("#admin-points-excluded")?.checked,
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-deposit-rate").value || 0) / 100,
    preorder_arrival: preorderArrivalValue(document.querySelector("#admin-arrival-from").value, document.querySelector("#admin-arrival-until").value),
    seller_link: document.querySelector("#admin-seller-link").value,
    is_published: document.querySelector("#admin-published").checked
  };
}

function validateProductImage(file) {
  if (!file) return;
  if (!(file instanceof File)) throw new Error("請選擇商品照片");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("照片僅支援 JPG、PNG 或 WebP");
  if (file.size > 5 * 1024 * 1024) throw new Error("商品照片不可超過 5MB");
}

const PRODUCT_IMAGE_MAX_DIMENSION = 1600;
const PRODUCT_IMAGE_MAX_PIXELS = 40_000_000;
const PRODUCT_IMAGE_WEBP_QUALITY = 0.86;

async function decodeProductImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
      } catch {
        // Fall through to the Image element for browsers with partial ImageBitmap support.
      }
    }
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("圖片無法讀取"));
      image.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function productImageWebpName(name) {
  const baseName = String(name || "product-image").replace(/\.[^/.]+$/, "").trim() || "product-image";
  return `${baseName}.webp`;
}

async function prepareProductImage(file) {
  if (!file) return null;
  validateProductImage(file);
  let decoded;
  try {
    decoded = await decodeProductImage(file);
  } catch {
    throw new Error("圖片無法讀取，請改用 JPG、PNG 或 WebP 圖片");
  }
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > PRODUCT_IMAGE_MAX_PIXELS) throw new Error("照片解析度過高，請先縮小圖片後再試");
    const scale = Math.min(1, PRODUCT_IMAGE_MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { file, converted: false, width: decoded.width, height: decoded.height };
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    try {
      context.drawImage(decoded.source, 0, 0, width, height);
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    let blob;
    try {
      blob = await new Promise((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("目前瀏覽器不支援 WebP 轉換")), "image/webp", PRODUCT_IMAGE_WEBP_QUALITY));
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
    if (!(blob instanceof Blob) || blob.type !== "image/webp" || blob.size > 5 * 1024 * 1024) return { file, converted: false, width: decoded.width, height: decoded.height };
    try {
      return { file: new File([blob], productImageWebpName(file.name), { type: "image/webp", lastModified: Date.now() }), converted: true, width, height };
    } catch {
      return { file, converted: false, width: decoded.width, height: decoded.height };
    }
  } finally {
    decoded.close();
  }
}

async function uploadAdminProductImage(productId, file) {
  if (!file) return;
  validateProductImage(file);
  const formData = new FormData();
  formData.append("image", file, file.name);
  await adminFetch(`/api/admin/products/${productId}/image`, { method: "POST", body: formData });
}

async function submitAdminProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const selectedImage = document.querySelector("#admin-product-image").files[0];
  validateProductImage(selectedImage);
  const submitButton = form.querySelector("button[type='submit']");
  const originalLabel = submitButton?.textContent || "建立商品";
  if (submitButton) { submitButton.disabled = true; submitButton.textContent = selectedImage ? "處理圖片並建立中…" : "建立商品中…"; }
  try {
    const preparedImage = selectedImage ? await prepareProductImage(selectedImage) : null;
    const result = await adminFetch("/api/admin/products", { method: "POST", body: JSON.stringify(productFormBody()) });
    invalidateAdminManagementOptions();
    await uploadAdminProductImage(result.ids.product_id, preparedImage?.file);
    form.reset();
    document.querySelector("#admin-variant-name").value = "單一規格";
    document.querySelector("#admin-stock").value = "0";
    document.querySelector("#admin-purchase-limit").value = "";
    const compareAtPriceInput = document.querySelector("#admin-compare-at-price");
    if (compareAtPriceInput) compareAtPriceInput.value = "";
    document.querySelector("#admin-deposit-rate").value = "0";
    await refreshAdminSections(["products", "inventory", "overview"]);
    switchAdminTab("products");
    const imageNotice = preparedImage && !preparedImage.converted ? "；瀏覽器不支援 WebP 轉換，已保留原始格式" : preparedImage ? "，圖片已轉為 WebP" : "";
    showToast(`商品已建立${imageNotice}`, preparedImage && !preparedImage.converted ? "warning" : "success");
  } finally {
    if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
  }
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
    compare_at_price: document.querySelector("#admin-new-compare-at-price")?.value ? Number(document.querySelector("#admin-new-compare-at-price").value) : null,
    safety_stock: Number(document.querySelector("#admin-new-safety-stock").value || 3),
    deposit_rate: kind === "preorder" ? 0.5 : Number(document.querySelector("#admin-new-deposit-rate").value || 0) / 100,
    preorder_arrival: preorderArrivalValue(document.querySelector("#admin-new-arrival-from").value, document.querySelector("#admin-new-arrival-until").value),
    seller_link: document.querySelector("#admin-new-seller-link").value,
    is_published: document.querySelector("#admin-new-published").checked
  };
  await adminFetch("/api/admin/variants", { method: "POST", body: JSON.stringify(body) });
  invalidateAdminManagementOptions();
  event.currentTarget.reset();
  document.querySelector("#admin-new-safety-stock").value = "3";
  const newCompareAtPriceInput = document.querySelector("#admin-new-compare-at-price");
  if (newCompareAtPriceInput) newCompareAtPriceInput.value = "";
  document.querySelector("#admin-new-deposit-rate").value = "0";
  await refreshAdminSections(["products", "inventory", "overview"]);
  switchAdminTab("products");
  showToast("商品規格已新增", "success");
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
    invalidateAdminManagementOptions();
    form.reset();
    await refreshAdminSections(["inventory", "products", "overview"]);
    switchAdminTab("inventory");
    const variantSelect = document.querySelector("#admin-inventory-variant");
    if (variantSelect) variantSelect.value = variantId;
    const variantLabel = variantSelect?.selectedOptions?.[0]?.textContent?.trim() || "商品規格";
    const feedback = document.querySelector("#admin-inventory-feedback");
    if (feedback) {
      feedback.textContent = `${variantLabel} 已更新，最新庫存 ${Number(result.stock_on_hand ?? 0)} 件。`;
      feedback.classList.remove("hidden");
    }
    showToast(`庫存已更新：${variantLabel} ${Number(result.stock_on_hand ?? 0)} 件`, "success");
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
  const form = event.target;
  const formData = new FormData(form);
  const submitButton = form.querySelector("button[type='submit']");
  const originalLabel = submitButton?.textContent || "儲存";
  if (productId) {
    const selectedImage = formData.get("image");
    const hasImage = selectedImage instanceof File && selectedImage.size > 0;
    validateProductImage(hasImage ? selectedImage : null);
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = hasImage ? "處理圖片並儲存中…" : "儲存中…"; }
    let preparedImage = null;
    try {
      preparedImage = hasImage ? await prepareProductImage(selectedImage) : null;
      const purchaseLimit = String(formData.get("purchase_limit") || "").trim();
      await adminFetch(`/api/admin/products/${productId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), description: formData.get("description"), category_id: String(formData.get("category_id") || "").trim() || null, purchase_limit: purchaseLimit ? Number(purchaseLimit) : null, points_eligible: formData.get("points_excluded") !== "on", display_order: Number(formData.get("display_order") || 0), is_published: formData.get("is_published") === "on" }) });
      invalidateAdminManagementOptions();
      if (preparedImage) await uploadAdminProductImage(productId, preparedImage.file);
      event.target.dataset.imageFallback = preparedImage && !preparedImage.converted ? "true" : "false";
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  } else {
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = "儲存中…"; }
    try {
      const kind = formData.get("kind");
      const compareAtPrice = String(formData.get("compare_at_price") || "").trim();
      await adminFetch(`/api/admin/variants/${variantId}`, { method: "PATCH", body: JSON.stringify({ name: formData.get("name"), sku: formData.get("sku"), kind, price: Number(formData.get("price")), compare_at_price: compareAtPrice ? Number(compareAtPrice) : null, safety_stock: Number(formData.get("safety_stock") || 3), deposit_rate: kind === "preorder" ? 0.5 : Number(formData.get("deposit_rate") || 0) / 100, preorder_arrival: preorderArrivalValue(formData.get("preorder_arrival_from"), formData.get("preorder_arrival_until"), formData.get("preorder_arrival_raw")), display_order: Number(formData.get("display_order") || 0), seller_link: formData.get("seller_link"), is_published: formData.get("is_published") === "on" }) });
      invalidateAdminManagementOptions();
    } finally {
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = originalLabel; }
    }
  }
  await refreshAdminSections(["products", "inventory", "overview"]);
  switchAdminTab("products");
  const imageFallback = productId && event.target.dataset.imageFallback === "true";
  showToast(productId ? `商品資料已儲存${imageFallback ? "；瀏覽器不支援 WebP 轉換，已保留原始格式" : ""}` : "規格資料已儲存", imageFallback ? "warning" : "success");
}

function syncDepositField(kindSelector, rateInput) {
  const preorder = kindSelector.value === "preorder";
  if (preorder) rateInput.value = "50";
  rateInput.readOnly = preorder;
}

document.addEventListener("click", (event) => {
  const copyAccount = event.target.closest("[data-copy-bank-account]");
  if (copyAccount) {
    const value = copyAccount.dataset.copyBankAccount || "";
    const copyPromise = navigator.clipboard?.writeText(value);
    if (!copyPromise) return showToast("目前瀏覽器不支援複製帳號", "warning");
    copyPromise.then(() => {
      const original = copyAccount.textContent;
      copyAccount.textContent = "已複製";
      showToast("匯款帳號已複製", "success");
      window.setTimeout(() => { copyAccount.textContent = original; }, 1800);
    }).catch(() => showToast("複製帳號失敗，請手動選取", "warning"));
    return;
  }
  const add = event.target.closest("[data-add]"); if (add) addToCartWithFeedback(add.dataset.add, add);
  const heroAdd = event.target.closest("[data-hero-add]"); if (heroAdd) addToCartWithFeedback(heroAdd.dataset.heroAdd, heroAdd);
  const change = event.target.closest("[data-quantity]"); if (change) { const item = cart.find((entry) => entry.id === change.dataset.quantity); const delta = Number(change.dataset.delta); const max = products.find((product) => product.id === item.id).stock; item.quantity = Math.min(max, item.quantity + delta); if (item.quantity <= 0) cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const remove = event.target.closest("[data-remove]"); if (remove) { const item = cart.find((entry) => entry.id === remove.dataset.remove); cart.splice(cart.indexOf(item), 1); saveCart(); renderCart(); }
  const detail = event.target.closest("[data-detail]"); if (detail) openProductDetail(detail.dataset.detail);
  const buyNow = event.target.closest("[data-buy-now]"); if (buyNow && !buyNow.disabled) buyNowFromCard(buyNow.dataset.buyNow);
  if (event.target.closest("[data-cart-toggle]")) toggleCart();
  const scopedCheckout = event.target.closest("[data-checkout-scope]");
  if (scopedCheckout) handleCartCheckout(scopedCheckout.dataset.checkoutScope);
  else if (event.target.closest("[data-checkout]")) handleCartCheckout();
  if (event.target.closest("[data-admin-open]")) openAdmin();
  if (event.target.closest("[data-admin-close]")) closeDialog(document.querySelector("#admin-dialog"));
  const adminQuickFilter = event.target.closest("[data-admin-quick-filter]");
  if (adminQuickFilter) applyAdminQuickFilter(adminQuickFilter.dataset.adminQuickFilter);
  const lowStockVariant = event.target.closest("[data-admin-low-stock-variant]");
  if (lowStockVariant) {
    const variantSelect = document.querySelector("#admin-inventory-variant");
    if (variantSelect) variantSelect.value = lowStockVariant.dataset.adminLowStockVariant;
    document.querySelector("#admin-inventory-delta")?.focus();
  }
  if (event.target.closest("[data-checkout-close]")) closeDialog(document.querySelector("#checkout-dialog"));
  if (event.target.closest("[data-checkout-review-next]")) openCheckoutReview();
  if (event.target.closest("[data-checkout-details-back]")) setCheckoutStage("details");
  if (event.target.closest("[data-demo='login']")) auth.user ? showProfileDialog(false) : beginLineLogin();
  if (event.target.closest("[data-profile-close]")) closeDialog(document.querySelector("#profile-dialog"));
  if (event.target.closest("[data-orders-open]")) openOrders();
  if (event.target.closest("[data-orders-close]")) closeDialog(document.querySelector("#orders-dialog"));
  if (event.target.closest("[data-orders-shop]")) { closeDialog(document.querySelector("#orders-dialog")); scrollToAnchor("product-search-bar"); }
  const lineFriendRequest = event.target.closest("[data-line-friend-request]");
  if (lineFriendRequest && canRequestLineFriendship()) {
    event.preventDefault();
    handleLineFriendRequest(lineFriendRequest);
    return;
  }
  if (event.target.closest("[data-payment-close], [data-payment-later]")) closeDialog(document.querySelector("#payment-dialog"));
  const lineFriendCheck = event.target.closest("[data-line-friend-check]");
  if (lineFriendCheck) {
    lineFriendCheck.disabled = true;
    lineFriendCheck.textContent = "檢查中…";
    document.querySelector("#line-friend-error")?.classList.add("hidden");
    checkLineFriendship({ force: true }).then((isFriend) => {
      if (!isFriend) return showLineFriendDialog();
      closeDialog(document.querySelector("#line-friend-dialog"));
      return openCheckout(activeCheckoutScope);
    }).catch((error) => showLineFriendDialog(error.message)).finally(() => {
      lineFriendCheck.disabled = false;
      lineFriendCheck.textContent = "我已加入，重新檢查";
    });
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) switchAdminTab(adminTab.dataset.adminTab);
  if (event.target.closest("[data-admin-refresh]")) loadAdminData().catch((error) => showToast(error.message, "error"));
  if (event.target.closest("[data-telegram-test]")) testTelegramNotification().catch((error) => showToast(error.message, "error"));
  if (event.target.closest("[data-birthday-issue]")) issueBirthdayCouponsNow().catch((error) => showToast(error.message, "error"));
  const adminPageButton = event.target.closest("[data-admin-page]");
  if (adminPageButton) {
    const section = adminPageButton.dataset.adminPage;
    const delta = Number(adminPageButton.dataset.adminPageDelta || 0);
    adminPageButton.disabled = true;
    changeAdminPage(section, delta).catch((error) => showToast(error.message, "error")).finally(() => { adminPageButton.disabled = false; });
    return;
  }
  const notificationRequeueButton = event.target.closest("[data-admin-notification-requeue]");
  if (notificationRequeueButton) {
    requeueAdminNotification(notificationRequeueButton).catch((error) => showToast(error.message, "error"));
    return;
  }
  if (event.target.closest("[data-admin-category-focus]")) focusAdminCategoryForm();
  if (event.target.closest("[data-admin-category-cancel]")) resetAdminCategoryForm();
  const categoryEdit = event.target.closest("[data-admin-category-edit]");
  if (categoryEdit) editAdminCategory(categoryEdit.dataset.adminCategoryEdit);
  const accountEdit = event.target.closest("[data-account-edit]");
  if (accountEdit) editAccount(accountEdit.dataset.accountEdit);
  if (event.target.closest("[data-account-cancel]")) resetAccountForm();
  if (event.target.closest("[data-coupon-reset]")) resetCouponForm();
  const couponEdit = event.target.closest("[data-coupon-edit]");
  if (couponEdit) editCoupon(couponEdit.dataset.couponEdit);
  const paymentOrderButton = event.target.closest("[data-order-payment]");
  if (paymentOrderButton) {
    const order = currentOrders.find((item) => item.id === paymentOrderButton.dataset.orderPayment);
    if (order) { closeDialog(document.querySelector("#orders-dialog")); showPaymentDialog(order); }
  }
});
document.addEventListener("error", handleAdminProductImageError, true);
document.addEventListener("change", (event) => {
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
  if (event.target.matches("#admin-order-status-filter")) reloadAdminList("orders", true);
  if (event.target.matches("#admin-product-status")) reloadAdminList("products", true);
  if (event.target.matches("#admin-audit-resource, #admin-audit-action")) reloadAdminList("audit", true);
  if (event.target.matches("#admin-notification-channel, #admin-notification-status")) reloadAdminList("notifications", true);
  if (event.target.matches("#point-max-mode")) syncPointMaxHint();
  if (event.target.matches("#admin-kind")) syncDepositField(event.target, document.querySelector("#admin-deposit-rate"));
  if (event.target.matches("#admin-new-kind")) syncDepositField(event.target, document.querySelector("#admin-new-deposit-rate"));
  if (event.target.matches("[data-edit-variant-form] select[name='kind']")) syncDepositField(event.target, event.target.form.elements.deposit_rate);
  if (event.target.matches("input[name='delivery_method']")) {
    if (activeCheckoutScope) setCartGroupDeliveryMethod(activeCheckoutScope, event.target.value);
    syncDeliveryFields();
  }
  if (event.target.matches("input[name='cart_delivery_method']")) setCartDeliveryMethod(event.target.value);
  if (event.target.matches("input[data-group-delivery]")) setCartGroupDeliveryMethod(event.target.dataset.groupDelivery, event.target.value);
  if (event.target.matches("input[name='payment_method']")) syncPaymentFields();
});
document.addEventListener("input", (event) => {
  if (event.target.matches("#admin-order-search")) reloadAdminList("orders");
  if (event.target.matches("#admin-member-search")) reloadAdminList("members");
  if (event.target.matches("#admin-product-search")) reloadAdminList("products");
  if (event.target.matches("#checkout-points")) renderCheckoutSummary();
  if (event.target.matches("#checkout-coupon-code")) renderCheckoutSummary();
  if (event.target.matches("#checkout-address")) renderCheckoutSummary();
  if (event.target.closest("#checkout-form")) clearCheckoutFieldErrorFor(event.target);
});
document.addEventListener("submit", async (event) => {
  if (event.target.matches("#admin-coupon-form")) {
    try { await submitCoupon(event); } catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("#birthday-coupon-form")) {
    try { await submitBirthdaySettings(event); } catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-points-form]")) {
    try { await submitMemberPointAdjustment(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-order-form]")) {
    try { await submitAdminOrderTransition(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-return-form]")) {
    try { await submitAdminOrderReturn(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (event.target.matches("[data-admin-fulfillment-form]")) {
    try { await submitAdminOrderFulfillment(event); }
    catch (error) { showToast(error.message, "error"); }
    return;
  }
  if (!event.target.matches("[data-edit-product-form], [data-edit-variant-form]")) return;
  try { await submitDynamicAdminForm(event); }
  catch (error) { showToast(error.message, "error"); }
});
initAnchorScroll();
const productPage = createProductPage({
  getProducts: () => products,
  addToCart: addVariantQuantityToCart,
  showToast,
  showDialog,
  closeDialog
});
initAdminProductGallery({
  adminFetch,
  prepareProductImage,
  showToast,
  getProduct: (id) => (adminData?.products || []).find((product) => product.id === id),
  fallbackMarkup: adminProductImageFallbackMarkup
});
initAdminProductsTable({
  getProducts: () => adminData?.products || [],
  adminFetch,
  showToast,
  adminCategoryOptions,
  splitPreorderArrival,
  fallbackMarkup: adminProductImageFallbackMarkup,
  onCatalogChanged: invalidateAdminManagementOptions
});
initAdminShell({
  getStats: () => (adminData?.stats && Object.keys(adminData.stats).length ? adminData.stats : null),
  switchAdminTab,
  reloadAdminList,
  loadAdminSection,
  adminFetch,
  formatDateTime,
  orderStatusLabel: (order) => adminOrderStatusLabel(order)
});
document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => { activeCategory = button.dataset.category; document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button)); renderProducts(); }));
search.addEventListener("input", renderProducts);
document.querySelector("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.checkoutStage !== "review") {
    openCheckoutReview();
    return;
  }
  const submitButton = document.querySelector(".checkout-submit");
  document.querySelector("#checkout-error").classList.add("hidden");
  submitButton.disabled = true;
  submitButton.textContent = "建立訂單中…";
  try { await submitOrder(); }
  catch (error) { showCheckoutError(error.message); }
  finally {
    submitButton.disabled = bankAccounts.length === 0;
    submitButton.textContent = "建立訂單並取得匯款資訊";
  }
});
document.querySelector("#payment-form").addEventListener("submit", submitPayment);
document.querySelector("#profile-form").addEventListener("submit", submitProfile);
document.querySelector("#admin-account-form").addEventListener("submit", async (event) => { try { await submitAdminAccount(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-category-form").addEventListener("submit", async (event) => { try { await submitAdminCategory(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-product-form").addEventListener("submit", async (event) => { try { await submitAdminProduct(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-variant-form").addEventListener("submit", async (event) => { try { await submitNewVariant(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-inventory-form").addEventListener("submit", async (event) => { try { await submitInventoryAdjustment(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#admin-point-settings-form").addEventListener("submit", async (event) => { try { await submitPointSettings(event); } catch (error) { showToast(error.message, "error"); } });
document.querySelector("#profile-dialog").addEventListener("cancel", (event) => {
  if (event.currentTarget.dataset.required === "true") event.preventDefault();
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("close", syncPageScrollLock);
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

function waitForHeroImageDecode(timeoutMs = HERO_IMAGE_DECODE_TIMEOUT_MS) {
  const image = document.querySelector("#hero-product-spotlight img");
  if (!image || !image.getAttribute("src")) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;
    let onLoad = null;
    let onError = null;
    const finish = (decoded) => {
      if (settled) return;
      settled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
      if (onLoad) image.removeEventListener("load", onLoad);
      if (onError) image.removeEventListener("error", onError);
      resolve(decoded);
    };
    timeoutId = window.setTimeout(() => finish(false), timeoutMs);
    if (typeof image.decode === "function") {
      // Prefer the browser's decode result when available. A load event can
      // fire before pixels are ready on mobile WebViews, so it must not win
      // over decode success, failure, or the timeout.
      try {
        image.decode().then(() => finish(true)).catch(() => finish(false));
      } catch {
        finish(false);
      }
      return;
    }
    onLoad = () => finish(true);
    onError = () => finish(false);
    if (image.complete) {
      finish(image.naturalWidth > 0);
      return;
    }
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
  });
}

function renderInitialPageOnce() {
  if (initialPageRendered) return;
  initialPageRendered = true;
  renderHeroSpotlight();
  renderProducts();
  renderCart();
  productPage.sync();
}

async function bootstrapAuth() {
  if (authBootstrapInFlight) return authBootstrapInFlight;
  authBootstrapInFlight = (async () => {
    removeLegacyShippingUI();
    removeLegacySellerCheckoutOption();
    const bootUrl = new URL(location.href);
    // Overlap the LIFF SDK download with /api/config for LINE launches only;
    // ordinary browsers never load the SDK.
    if (hasLiffPrimaryRedirectParams(bootUrl) || bootUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM) || readLiffLaunchContext()) preloadLiffSdk();
    const configLoaded = await loadRuntimeConfig();
    const liffPrimaryRedirect = hasLiffPrimaryRedirectParams(bootUrl);
    const explicitLiffLaunch = liffPrimaryRedirect || bootUrl.searchParams.has(LIFF_AUTO_CALLBACK_PARAM);
    const liffLaunchIntent = hasLiffLaunchIntent(bootUrl);
    if (!configLoaded && explicitLiffLaunch) throw new Error("登入服務設定載入失敗");
    if (!configLoaded && liffLaunchIntent) clearLiffLaunchContext();
    // LIFF primary redirects can carry LINE-owned access_token/id_token fields
    // in the hash until liff.init() resolves. Only normal browser OAuth and
    // the cj_liff_oauth callback may be captured before LIFF initialization.
    if (!liffPrimaryRedirect) captureAuthSession();
    const liffStage = await initializeLiffStage({
      launchIntent: configLoaded && liffLaunchIntent,
      explicitLaunch: explicitLiffLaunch
    });
    if (liffStage.primary) return;
    if (liffPrimaryRedirect) captureAuthSession();
    loadLocalCart();
    const liffRedirecting = liffLaunchIntent && liffStage.initialized && liffStage.state?.isInClient
      ? await initializeLiffBridge(liffStage.state)
      : false;
    if (liffRedirecting) return;
    await loadProducts();
    renderInitialPageOnce();
    await waitForHeroImageDecode();
    finishAuthBoot();
    // Member/session restoration continues after the public catalog is usable,
    // so a slow auth request cannot keep ordinary browsers behind the boot UI.
    await loadMember();
    await restoreAuthReturnState();
  })();
  return authBootstrapInFlight;
}

startAuthBoot();
try {
  await bootstrapAuth();
} catch (error) {
  console.error("App bootstrap failed.", error);
  if (liffPrimaryRedirectPending || hasLiffPrimaryRedirectParams() || new URL(location.href).searchParams.has(LIFF_AUTO_CALLBACK_PARAM)) {
    failAuthBoot("LINE 登入頁面準備失敗，請點擊重試");
  } else {
    renderInitialPageOnce();
    finishAuthBoot();
    showToast("頁面載入較慢，部分會員資料可能需要重新整理", "error");
  }
}
